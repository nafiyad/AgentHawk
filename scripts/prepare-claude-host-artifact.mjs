import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadPinnedArtifact } from "./claude-artifact-download.mjs";
import {
  CLAUDE_ARTIFACT_POLICY,
  verifyClaudeGpgStatus,
  verifyClaudeManifest,
} from "./claude-artifact-policy.mjs";
import { createBoundedArtifactStorage } from "./claude-artifact-storage.mjs";

const OPERATION_MS = 240_000;
const GPG_MS = 15_000;
const CLOSE_MS = 5_000;
const OUTPUT_BYTES = 65_536;
const READ_BYTES = 65_536;
const FAILURE_CODES = new Set([
  "unsupported_host",
  "invalid_destination",
  "destination_unavailable",
  "storage_failed",
  "ownership_changed",
  "artifact_mismatch",
  "manifest_invalid",
  "signature_invalid",
  "verifier_failed",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
  "download_failed",
]);

class PreparationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new PreparationError(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameContentState(left, right) {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validDirectory(status, uid, owned) {
  return (
    status.isDirectory() &&
    !status.isSymbolicLink() &&
    status.ino > 0n &&
    (status.mode & 0o022n) === 0n &&
    (status.uid === uid || (!owned && status.uid === 0n))
  );
}

function validFile(status, uid) {
  return (
    status.isFile() &&
    !status.isSymbolicLink() &&
    status.ino > 0n &&
    status.uid === uid &&
    status.nlink === 1n &&
    (status.mode & 0o7777n) === 0o600n
  );
}

function errorCode(error) {
  if (error instanceof PreparationError && FAILURE_CODES.has(error.code)) return error.code;
  return "storage_failed";
}

/** Trusted development-test seams only; the CLI never accepts dependency/policy overrides. */
export function createArtifactPreparer(overrides = {}) {
  const rawIo = overrides.filesystem ?? filesystem;
  const policy = overrides.policy ?? CLAUDE_ARTIFACT_POLICY;
  const download = overrides.download ?? downloadPinnedArtifact;
  const runGpg = overrides.runGpg ?? executeFixedGpg;
  const verifyManifest = overrides.verifyManifest ?? verifyClaudeManifest;
  const verifySignature = overrides.verifySignature ?? verifyClaudeGpgStatus;
  const clock = overrides.clock ?? Date.now;
  const platform = overrides.platform ?? process.platform;
  const getUid = overrides.getUid ?? (() => process.getuid());

  return async (outputDirectory, externalSignal) => {
    let created = false;
    let rootIdentity;
    let parentIdentity;
    let uid;
    let parent;
    let outcome;
    let writes = 0;
    let subscribedSignal;
    const storedFiles = new Map();
    const controller = new AbortController();
    const storage = createBoundedArtifactStorage(rawIo, controller.signal);
    const io = storage.filesystem;
    const abort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OPERATION_MS);
    timer.unref();
    const failure = (reason) =>
      Object.freeze({
        schemaVersion: "1",
        status: "failed",
        reason,
        retainedState: created ? "present_or_uncertain" : "not_created",
        executed: false,
        nativeSupport: false,
      });
    const check = () => {
      if (controller.signal.aborted) fail(timedOut ? "deadline_exceeded" : "cancelled");
    };
    const stat = (path) => io.lstat(path, { bigint: true });
    const checkRoot = async () => {
      check();
      const observedParent = await stat(parent);
      const observedRoot = await stat(outputDirectory);
      if (
        !validDirectory(observedParent, uid, true) ||
        !sameIdentity(parentIdentity, observedParent) ||
        !validDirectory(observedRoot, uid, true) ||
        (observedRoot.mode & 0o7777n) !== 0o700n ||
        !sameIdentity(rootIdentity, observedRoot)
      ) {
        fail("ownership_changed");
      }
      check();
    };
    const close = async (handle) => {
      try {
        await handle.close();
      } catch {
        fail("closure_unconfirmed");
      }
    };
    const verifyStored = async (artifact, expectedIdentity) => {
      await checkRoot();
      const path = join(outputDirectory, artifact.file);
      const before = await stat(path);
      if (!validFile(before, uid) || !sameIdentity(expectedIdentity, before)) {
        fail("ownership_changed");
      }
      const handle = await io.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await handle.stat({ bigint: true });
      if (!validFile(opened, uid) || !sameContentState(before, opened)) fail("ownership_changed");
      if (opened.size !== BigInt(artifact.size)) fail("artifact_mismatch");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(READ_BYTES);
      let position = 0;
      while (position <= artifact.size) {
        check();
        const length = Math.min(buffer.length, artifact.size + 1 - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        check();
        if (bytesRead === 0) break;
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length) {
          fail("storage_failed");
        }
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const afterHandle = await handle.stat({ bigint: true });
      const afterPath = await stat(path);
      if (
        !validFile(afterHandle, uid) ||
        !validFile(afterPath, uid) ||
        !sameContentState(opened, afterHandle) ||
        !sameContentState(opened, afterPath)
      ) {
        fail("ownership_changed");
      }
      if (position !== artifact.size || hash.digest("hex") !== artifact.sha256) {
        fail("artifact_mismatch");
      }
      await close(handle);
      await checkRoot();
    };
    const store = async (artifact, source, collect = false) => {
      await checkRoot();
      const path = join(outputDirectory, artifact.file);
      const handle = await io.open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const identity = await handle.stat({ bigint: true });
      if (!validFile(identity, uid) || identity.size !== 0n) fail("ownership_changed");
      const hash = createHash("sha256");
      const collected = [];
      let position = 0;
      await source(async (chunk) => {
        check();
        if (
          !Buffer.isBuffer(chunk) ||
          chunk.length === 0 ||
          chunk.length > 262_144 ||
          position + chunk.length > artifact.size ||
          (collect && position + chunk.length > OUTPUT_BYTES)
        ) {
          fail("artifact_mismatch");
        }
        hash.update(chunk);
        if (collect) collected.push(Buffer.from(chunk));
        let offset = 0;
        while (offset < chunk.length) {
          check();
          if (++writes > 262_144) fail("storage_failed");
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
            position + offset,
          );
          check();
          if (
            !Number.isInteger(bytesWritten) ||
            bytesWritten <= 0 ||
            bytesWritten > chunk.length - offset
          ) {
            fail("storage_failed");
          }
          offset += bytesWritten;
        }
        position += chunk.length;
      });
      check();
      if (position !== artifact.size || hash.digest("hex") !== artifact.sha256) {
        fail("artifact_mismatch");
      }
      await handle.sync();
      check();
      const written = await handle.stat({ bigint: true });
      if (!validFile(written, uid) || !sameIdentity(identity, written)) fail("ownership_changed");
      await close(handle);
      await verifyStored(artifact, identity);
      storedFiles.set(artifact.file, { artifact, identity });
      return collect ? Buffer.concat(collected) : undefined;
    };
    const revalidateStoredFiles = async () => {
      for (const { artifact, identity } of storedFiles.values()) {
        await verifyStored(artifact, identity);
      }
    };
    const acquire = (artifact, collect) =>
      store(
        artifact,
        async (sink) => {
          try {
            await download(artifact, sink, controller.signal);
          } catch (error) {
            check();
            if (error instanceof PreparationError) throw error;
            if (error?.message === "download_cleanup_unconfirmed") fail("closure_unconfirmed");
            fail("download_failed");
          }
        },
        collect,
      );

    try {
      if (externalSignal !== undefined) {
        if (!(externalSignal instanceof AbortSignal)) fail("invalid_destination");
        externalSignal.addEventListener("abort", abort, { once: true });
        subscribedSignal = externalSignal;
        if (externalSignal.aborted) abort();
      }
      check();
      if (platform !== "linux") fail("unsupported_host");
      uid = BigInt(getUid());
      if (
        typeof outputDirectory !== "string" ||
        outputDirectory.length === 0 ||
        outputDirectory.length > 4096 ||
        [...outputDirectory].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127;
        }) ||
        !isAbsolute(outputDirectory) ||
        resolve(outputDirectory) !== outputDirectory ||
        dirname(outputDirectory) === outputDirectory
      ) {
        fail("invalid_destination");
      }
      parent = dirname(outputDirectory);
      if ((await io.realpath(parent)) !== parent) fail("invalid_destination");
      for (let current = parent; ; current = dirname(current)) {
        check();
        const observed = await stat(current);
        if (!validDirectory(observed, uid, current === parent)) fail("invalid_destination");
        if (current === parent) parentIdentity = observed;
        if (dirname(current) === current) break;
      }
      const verifier = await stat("/usr/bin/gpg");
      if (
        !verifier.isFile() ||
        verifier.isSymbolicLink() ||
        verifier.uid !== 0n ||
        (verifier.mode & 0o022n) !== 0n ||
        (verifier.mode & 0o111n) === 0n
      ) {
        fail("verifier_failed");
      }
      check();
      try {
        // A rejected creation can still have an uncertain filesystem outcome.
        // Retention never asserts that an existing destination belongs to us.
        created = true;
        await io.mkdir(outputDirectory, { mode: 0o700 });
      } catch {
        fail("destination_unavailable");
      }
      rootIdentity = await stat(outputDirectory);
      await checkRoot();
      const gpgHome = join(outputDirectory, "gnupg");
      await io.mkdir(gpgHome, { mode: 0o700 });
      const gpgIdentity = await stat(gpgHome);
      const checkGpgHome = async () => {
        await checkRoot();
        const current = await stat(gpgHome);
        if (
          !validDirectory(current, uid, true) ||
          (current.mode & 0o7777n) !== 0o700n ||
          !sameIdentity(gpgIdentity, current)
        ) {
          fail("ownership_changed");
        }
      };
      await acquire(policy.key, false);
      const manifest = await acquire(policy.manifest, true);
      if (!verifyManifest(manifest)) fail("manifest_invalid");
      await acquire(policy.signature, false);
      await checkGpgHome();
      await revalidateStoredFiles();
      const dearmored = await runGpg(outputDirectory, "dearmor", controller.signal);
      check();
      if (dearmored.code !== 0) fail("verifier_failed");
      await store(policy.dearmoredKey, async (sink) => await sink(dearmored.stdout));
      await checkGpgHome();
      await revalidateStoredFiles();
      const verified = await runGpg(outputDirectory, "verify", controller.signal);
      check();
      if (!verifySignature(verified.stdout, verified.code, clock())) fail("signature_invalid");
      await checkGpgHome();
      await revalidateStoredFiles();
      await acquire(policy.binary, false);
      outcome = Object.freeze({
        schemaVersion: "1",
        status: "prepared",
        artifact: Object.freeze({
          file: policy.binary.file,
          version: policy.version,
          platform: policy.platform,
          size: policy.binary.size,
          sha256: policy.binary.sha256,
        }),
        manifestSha256: policy.manifest.sha256,
        signingFingerprint: policy.signingFingerprint,
        executed: false,
        nativeSupport: false,
      });
      const receipt = Buffer.from(`${JSON.stringify(outcome)}\n`, "utf8");
      await store(
        { file: "preparation.json", size: receipt.length, sha256: sha256(receipt) },
        async (sink) => await sink(receipt),
      );
      await revalidateStoredFiles();
      await checkRoot();
    } catch (error) {
      outcome = failure(
        controller.signal.aborted
          ? timedOut
            ? "deadline_exceeded"
            : "cancelled"
          : errorCode(error),
      );
    } finally {
      // A rejected await never proves cancellation of the underlying syscall.
      // Close only after each handle's own I/O settles; never delete retained
      // state, and never return prepared when settlement cannot be established.
      if (!(await storage.settle())) outcome = failure("closure_unconfirmed");
      else if (controller.signal.aborted) {
        outcome = failure(timedOut ? "deadline_exceeded" : "cancelled");
      }
      clearTimeout(timer);
      subscribedSignal?.removeEventListener("abort", abort);
    }
    return outcome;
  };
}

export const prepareClaudeHostArtifact = createArtifactPreparer();

// GPG is the only child executable in preparation. Never run the acquired file.
export function executeFixedGpg(root, operation, signal) {
  if ((operation !== "dearmor" && operation !== "verify") || !(signal instanceof AbortSignal)) {
    return Promise.reject(new PreparationError("verifier_failed"));
  }
  const home = join(root, "gnupg");
  const args = [
    "--no-options",
    "--homedir",
    home,
    "--no-default-keyring",
    "--batch",
    "--no-tty",
    "--no-auto-key-retrieve",
    "--no-auto-key-import",
    "--auto-key-locate",
    "clear",
    "--no-autostart",
    "--disable-dirmngr",
    "--no-auto-check-trustdb",
    ...(operation === "dearmor"
      ? ["--dearmor", "--output", "-", join(root, "claude-code.asc")]
      : [
          "--keyring",
          join(root, "public-key.gpg"),
          "--status-fd",
          "1",
          "--verify",
          join(root, "manifest.json.sig"),
          join(root, "manifest.json"),
        ]),
  ];
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new PreparationError("cancelled"));
    let child;
    try {
      child = spawn("/usr/bin/gpg", args, {
        cwd: root,
        env: { HOME: home, TMPDIR: root, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return reject(new PreparationError("verifier_failed"));
    }
    const chunks = [];
    let bytes = 0;
    let failed = false;
    let settled = false;
    let closeTimer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal.removeEventListener("abort", stop);
      if (error) reject(error);
      else resolvePromise(value);
    };
    const stop = () => {
      if (failed || settled) return;
      failed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Closure, not a successful kill request, is the settlement authority.
      }
      closeTimer = setTimeout(() => {
        finish(new PreparationError("closure_unconfirmed"));
      }, CLOSE_MS);
    };
    const timer = setTimeout(stop, GPG_MS);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const receive = (keep) => (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_BYTES) stop();
      else if (keep && !failed) chunks.push(Buffer.from(chunk));
    };
    child.stdout.on("data", receive(true));
    child.stderr.on("data", receive(false));
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.once("error", stop);
    child.once("close", (code, childSignal) => {
      if (failed || childSignal !== null || !Number.isInteger(code)) {
        finish(new PreparationError(signal.aborted ? "cancelled" : "verifier_failed"));
      } else {
        finish(undefined, { code, stdout: Buffer.concat(chunks) });
      }
    });
  });
}

export async function runArtifactPreparationCommand(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "Usage: prepare-claude-host-artifact <new-absolute-directory>\nLinux-only, authenticated fixture acquisition. Does not execute Claude.\n",
    );
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await prepareClaudeHostArtifact(
      args.length === 1 ? args[0] : undefined,
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "prepared" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runArtifactPreparationCommand().catch(() => {
    process.stderr.write("Claude artifact preparation failed; retained state is unverified.\n");
    process.exitCode = 1;
  });
}
