import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createBoundedRuntimeStorage } from "./claude-artifact-storage.mjs";
import { describeRuntimeAssemblyPlan, runtimeAssemblyFiles } from "./runtime-assembly-inputs.mjs";
import { runtimeTreeSnapshotFiles } from "./runtime-tree-reader.mjs";

const OPERATION_MS = 240_000;
const MAX_IO = 262_144;
const READ_BYTES = 65_536;
const FLAGS = Object.freeze({ executed: false, portableRuntime: false, nativeSupport: false });
const PACKAGES = ["@agenthawk/core", "@agenthawk/cli", "commander", "semver", "yaml", "zod"];
const REASONS = new Set([
  "unsupported_host",
  "invalid_destination",
  "destination_unavailable",
  "invalid_plan",
  "storage_failed",
  "ownership_changed",
  "tree_mismatch",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
]);

class TreeError extends Error {}
function fail(code) {
  throw new TreeError(code);
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameContent(a, b) {
  return (
    sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}
function directory(stat, uid, privateDirectory, owned = true) {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    (stat.uid === uid || (!owned && stat.uid === 0n)) &&
    (privateDirectory ? (stat.mode & 0o7777n) === 0o700n : (stat.mode & 0o022n) === 0n)
  );
}
function regularFile(stat, uid) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (stat.mode & 0o7777n) === 0o600n
  );
}
function reason(error) {
  return error instanceof TreeError && REASONS.has(error.message)
    ? error.message
    : "storage_failed";
}

function createOperation(overrides, action) {
  const rawIo = overrides.filesystem ?? filesystem;
  const platform = overrides.platform ?? process.platform;
  const getUid = overrides.getUid ?? (() => process.getuid());
  return async (input) => {
    let retained = false;
    let result;
    let subscribed;
    let storage;
    let timedOut = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, OPERATION_MS);
    timer.unref();
    const failure = (code) =>
      Object.freeze({
        schemaVersion: 1,
        status: "rejected",
        reason: code,
        retainedState: retained ? "present_or_uncertain" : "not_created",
        ...FLAGS,
      });
    try {
      const { destination, signal } = input ?? {};
      if (signal !== undefined) {
        if (!(signal instanceof AbortSignal)) fail("invalid_destination");
        subscribed = signal;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      const check = () => {
        if (controller.signal.aborted) fail(timedOut ? "deadline_exceeded" : "cancelled");
      };
      check();
      if (platform !== "linux") fail("unsupported_host");
      const uid = BigInt(getUid());
      if (
        uid < 0n ||
        typeof destination !== "string" ||
        destination.length > 4096 ||
        [...destination].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        !isAbsolute(destination) ||
        resolve(destination) !== destination ||
        dirname(destination) === destination
      ) {
        fail("invalid_destination");
      }
      storage = createBoundedRuntimeStorage(rawIo, controller.signal);
      const io = storage.filesystem;
      const stat = (path) => io.lstat(path, { bigint: true });
      const ancestors = new Map();
      const parent = dirname(destination);
      if ((await io.realpath(parent)) !== parent) fail("invalid_destination");
      for (let current = parent; ; current = dirname(current)) {
        check();
        const observed = await stat(current);
        if (!directory(observed, uid, false, current === parent)) fail("invalid_destination");
        ancestors.set(current, observed);
        if (dirname(current) === current) break;
      }
      if ((await io.lstatIfPresent(destination, { bigint: true })) !== undefined) {
        fail("destination_unavailable");
      }
      const checkAncestors = async () => {
        for (const [path, identity] of ancestors) {
          check();
          const observed = await stat(path);
          if (
            !directory(observed, uid, false, path === parent) ||
            !sameIdentity(identity, observed)
          ) {
            fail("ownership_changed");
          }
        }
        check();
      };
      await checkAncestors();
      result = await action({
        input,
        io,
        stat,
        check,
        checkAncestors,
        uid,
        destination,
        parentIdentity: ancestors.get(parent),
        markRetained() {
          retained = true;
        },
      });
    } catch (error) {
      result = failure(
        controller.signal.aborted ? (timedOut ? "deadline_exceeded" : "cancelled") : reason(error),
      );
    } finally {
      if (storage && !(await storage.settle())) result = failure("closure_unconfirmed");
      else if (controller.signal.aborted)
        result = failure(timedOut ? "deadline_exceeded" : "cancelled");
      clearTimeout(timer);
      subscribed?.removeEventListener("abort", abort);
    }
    return result;
  };
}

/** Internal read-only preflight; identity is for same-process fencing, not a receipt. */
export function createRuntimeDestinationInspector(overrides = {}) {
  return createOperation(overrides, async ({ parentIdentity }) =>
    Object.freeze({
      schemaVersion: 1,
      status: "available",
      parentIdentity: Object.freeze({
        dev: parentIdentity.dev,
        ino: parentIdentity.ino,
      }),
      ...FLAGS,
    }),
  );
}
export const inspectRuntimeDestination = createRuntimeDestinationInspector();

function verifiedFiles(plan, sourceSnapshot, useSnapshot) {
  const description = describeRuntimeAssemblyPlan(plan);
  const source = useSnapshot
    ? runtimeTreeSnapshotFiles(sourceSnapshot, plan)
    : runtimeAssemblyFiles(plan);
  if (!description || !Array.isArray(source) || source.length === 0 || source.length > 1400)
    fail("invalid_plan");
  const files = [];
  const paths = new Set();
  let bytes = 0;
  for (const file of source) {
    const { path, size, sha256: digest, data } = file;
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      !/^[A-Za-z0-9_@./-]+$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !PACKAGES.some((name) => path.startsWith(`runtime/node_modules/${name}/`)) ||
      paths.has(path.toLowerCase()) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 1_048_576 ||
      !Buffer.isBuffer(data) ||
      data.length !== size ||
      sha256(data) !== digest
    )
      fail("invalid_plan");
    paths.add(path.toLowerCase());
    bytes += size;
    if (bytes > 7_000_000) fail("invalid_plan");
    files.push({ path, size, sha256: digest, data: Buffer.from(data) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inventory = files.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }));
  if (
    description.fileCount !== files.length ||
    description.fileBytes !== bytes ||
    description.plannedTreeSha256 !== sha256(JSON.stringify(inventory))
  )
    fail("invalid_plan");
  return { description, files };
}

/** Trusted filesystem/platform seams are development-only, never command-line overrides. */
export function createRuntimeTreeWriter(overrides = {}) {
  return createOperation(overrides, async (context) => {
    const { input, io, stat, check, checkAncestors, uid, destination, markRetained } = context;
    // Only the private WeakMap brand yields bytes. Plain inventories cannot authorize writes.
    const { description, files } = verifiedFiles(
      input.plan,
      input.sourceSnapshot,
      Object.hasOwn(input, "sourceSnapshot"),
    );
    const directories = new Map();
    const expected = new Map([[destination, new Set()]]);
    const identities = new Map();
    let operations = 0;
    const tick = () => {
      check();
      if (++operations > MAX_IO) fail("storage_failed");
    };
    const close = async (handle) => {
      try {
        await handle.close();
      } catch {
        fail("closure_unconfirmed");
      }
    };
    const checkDirectory = async (path, content = false) => {
      check();
      const observed = await stat(path);
      const identity = directories.get(path);
      if (
        !directory(observed, uid, true) ||
        !sameIdentity(identity, observed) ||
        (content && !sameContent(identity, observed))
      )
        fail("ownership_changed");
    };
    const checkChain = async (path) => {
      await checkAncestors();
      for (let current = path; ; current = dirname(current)) {
        await checkDirectory(current);
        if (current === destination) break;
        if (!current.startsWith(`${destination}\\`) && !current.startsWith(`${destination}/`))
          fail("tree_mismatch");
      }
      check();
    };
    const createDirectory = async (path) => {
      if (path !== destination) await checkChain(dirname(path));
      else await checkAncestors();
      markRetained();
      try {
        await io.mkdir(path, { mode: 0o700 });
      } catch {
        fail("destination_unavailable");
      }
      const identity = await stat(path);
      if (!directory(identity, uid, true)) fail("ownership_changed");
      directories.set(path, identity);
      expected.set(path, new Set());
      if (path !== destination) expected.get(dirname(path)).add(basename(path));
      await checkChain(path);
    };
    const ensureDirectories = async (filePath) => {
      const relativeParts = filePath.split("/").slice(0, -1);
      let path = destination;
      for (const part of relativeParts) {
        path = join(path, part);
        if (!directories.has(path)) await createDirectory(path);
      }
      return path;
    };
    const verifyFile = async (file) => {
      const path = join(destination, ...file.path.split("/"));
      await checkChain(dirname(path));
      const before = await stat(path);
      if (!regularFile(before, uid) || !sameContent(identities.get(file.path), before))
        fail("ownership_changed");
      const handle = await io.open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await handle.stat({ bigint: true });
      if (!regularFile(opened, uid) || !sameContent(before, opened)) fail("ownership_changed");
      if (opened.size !== BigInt(file.size)) fail("tree_mismatch");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(READ_BYTES, file.size + 1));
      let position = 0;
      while (position <= file.size) {
        tick();
        const length = Math.min(buffer.length, file.size + 1 - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        check();
        if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
          fail("storage_failed");
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const afterPath = await stat(path);
      if (
        !regularFile(after, uid) ||
        !regularFile(afterPath, uid) ||
        !sameContent(opened, after) ||
        !sameContent(opened, afterPath)
      )
        fail("ownership_changed");
      const digest = hash.digest("hex");
      if (position !== file.size || digest !== file.sha256) fail("tree_mismatch");
      await close(handle);
      await checkChain(dirname(path));
      return { path: file.path, size: position, sha256: digest };
    };
    const writeFile = async (file) => {
      const parent = await ensureDirectories(file.path);
      await checkChain(parent);
      const path = join(destination, ...file.path.split("/"));
      const handle = await io.open(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat({ bigint: true });
      if (!regularFile(opened, uid) || opened.size !== 0n) fail("ownership_changed");
      let position = 0;
      while (position < file.size) {
        tick();
        const length = Math.min(READ_BYTES, file.size - position);
        const { bytesWritten } = await handle.write(file.data, position, length, position);
        check();
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > length)
          fail("storage_failed");
        position += bytesWritten;
      }
      await handle.sync();
      check();
      const written = await handle.stat({ bigint: true });
      if (
        !regularFile(written, uid) ||
        !sameIdentity(opened, written) ||
        written.size !== BigInt(file.size)
      )
        fail("ownership_changed");
      identities.set(file.path, written);
      await close(handle);
      expected.get(parent).add(basename(path));
      await verifyFile(file);
    };
    const enumerate = async () => {
      for (const [path, names] of expected) {
        await checkChain(path);
        await checkDirectory(path, true);
        const handle = await io.opendir(path, { bufferSize: 1 });
        const seen = new Set();
        // One extra bounded read detects overflow; no recursive/unbounded readdir.
        for (let count = 0; count <= names.size; count += 1) {
          tick();
          const entry = await handle.read();
          check();
          if (entry === null) break;
          if (
            !entry ||
            typeof entry.name !== "string" ||
            !names.has(entry.name) ||
            seen.has(entry.name) ||
            entry.isSymbolicLink()
          )
            fail("tree_mismatch");
          const child = join(path, entry.name);
          if (directories.has(child) ? !entry.isDirectory() : !entry.isFile())
            fail("tree_mismatch");
          seen.add(entry.name);
        }
        if (seen.size !== names.size) fail("tree_mismatch");
        await close(handle);
        await checkDirectory(path, true);
        await checkChain(path);
      }
    };
    await createDirectory(destination);
    for (const file of files) await writeFile(file);
    const measured = [];
    for (const file of files) measured.push(await verifyFile(file));
    const storedTreeSha256 = sha256(JSON.stringify(measured));
    if (storedTreeSha256 !== description.plannedTreeSha256) fail("tree_mismatch");
    const outcome = Object.freeze({
      ...description,
      status: "assembled",
      storedTreeSha256,
      ...FLAGS,
    });
    const recordBytes = Buffer.from(`${JSON.stringify(outcome)}\n`);
    if (recordBytes.length > 65_536) fail("invalid_plan");
    const record = {
      path: "assembly-record.json",
      size: recordBytes.length,
      sha256: sha256(recordBytes),
      data: recordBytes,
    };
    await writeFile(record);
    // Directory metadata is frozen only after all intended writes have finished.
    for (const path of directories.keys()) {
      await checkDirectory(path);
      directories.set(path, await stat(path));
    }
    await enumerate();
    for (const file of [...files, record]) await verifyFile(file);
    await enumerate();
    await checkAncestors();
    return outcome;
  });
}
export const writeRuntimeTree = createRuntimeTreeWriter();
