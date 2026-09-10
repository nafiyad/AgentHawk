import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadRuntimeArchive } from "./claude-artifact-download.mjs";
import { createBoundedRuntimeStorage } from "./claude-artifact-storage.mjs";
import { releaseVersion } from "./package-policy.mjs";
import { RUNTIME_ARCHIVE_POLICY } from "./runtime-archive-policy.mjs";
import {
  createRuntimeAssemblyPlan,
  describeRuntimeAssemblyPlan,
} from "./runtime-assembly-inputs.mjs";
import { runRuntimeBuildProcess } from "./runtime-build-process.mjs";
import { observeRuntimeBuildSource, readRuntimeBuildFile } from "./runtime-build-source.mjs";
import { inspectRuntimeDestination, writeRuntimeTree } from "./runtime-tree.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const FLAGS = Object.freeze({ executed: false, portableRuntime: false, nativeSupport: false });
const freshPlans = new WeakMap();
const REASONS = new Set([
  "unsupported_host",
  "invalid_destination",
  "destination_unavailable",
  "ownership_changed",
  "source_invalid",
  "source_dirty",
  "source_changed",
  "output_exists",
  "toolchain_invalid",
  "process_failed",
  "process_timeout",
  "process_output_limit",
  "archive_invalid",
  "download_failed",
  "storage_failed",
  "tree_mismatch",
  "invalid_plan",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
]);

function fail(reason) {
  const error = new Error("runtime_preparation_failed");
  error.reason = REASONS.has(reason) ? reason : "storage_failed";
  throw error;
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** In-process freshness evidence only; neither a receipt nor authority to launch. */
export function fixtureRuntimePlan(result) {
  return freshPlans.get(result);
}

/** Trusted test seams only. Production accepts one destination and no overrides. */
export function createFixtureRuntimePreparer(overrides = {}) {
  const rawIo = overrides.filesystem ?? filesystem;
  const root = overrides.root ?? ROOT;
  const platform = overrides.platform ?? process.platform;
  const nodeVersion = overrides.nodeVersion ?? process.version;
  const run = overrides.run ?? runRuntimeBuildProcess;
  const inspect = overrides.inspect ?? inspectRuntimeDestination;
  const observe = overrides.observe ?? observeRuntimeBuildSource;
  const readFile = overrides.readFile ?? readRuntimeBuildFile;
  const download = overrides.download ?? downloadRuntimeArchive;
  const planInputs = overrides.plan ?? createRuntimeAssemblyPlan;
  const describe = overrides.describe ?? describeRuntimeAssemblyPlan;
  const write = overrides.write ?? writeRuntimeTree;
  const getUid = overrides.getUid ?? (() => process.getuid());
  // The development builder/tool lookup is trusted. Do not inherit credentials,
  // Node injection, Git helpers, package-manager user config, or proxy variables.
  const env = Object.freeze({
    PATH: overrides.path ?? process.env.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_ignore_scripts: "true",
    npm_config_ignore_pnpmfile: "true",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/dev/null",
  });

  return async (destination, externalSignal) => {
    let result;
    let assembledPlan;
    let storage;
    let retained = false;
    let subscribed;
    let timedOut = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, 480_000);
    timer.unref();
    const failure = (reason) =>
      Object.freeze({
        schemaVersion: 1,
        status: "failed",
        reason,
        retainedState: retained ? "present_or_uncertain" : "not_created",
        ...FLAGS,
      });
    const check = () => {
      if (controller.signal.aborted) fail(timedOut ? "deadline_exceeded" : "cancelled");
    };
    const execute = async (file, args, timeoutMs) => {
      check();
      const processResult = await run(file, args, {
        cwd: root,
        env,
        signal: controller.signal,
        timeoutMs,
      });
      if (processResult.status !== "completed") fail(processResult.reason);
      check();
      return processResult.stdout;
    };
    try {
      if (externalSignal !== undefined) {
        if (!(externalSignal instanceof AbortSignal)) fail("invalid_destination");
        subscribed = externalSignal;
        externalSignal.addEventListener("abort", abort, { once: true });
        if (externalSignal.aborted) abort();
      }
      check();
      if (platform !== "linux") fail("unsupported_host");
      const preflight = await inspect({ destination, signal: controller.signal });
      if (preflight.status !== "available") fail(preflight.reason);
      const scratch = `${destination}.build`;
      const scratchPreflight = await inspect({ destination: scratch, signal: controller.signal });
      if (scratchPreflight.status !== "available") fail(scratchPreflight.reason);
      if (!sameIdentity(preflight.parentIdentity, scratchPreflight.parentIdentity))
        fail("ownership_changed");
      storage = createBoundedRuntimeStorage(rawIo, controller.signal);
      const io = storage.filesystem;
      const before = await observe({ root, io, execute, requireFreshOutput: true });
      const pnpmVersion = (await execute("pnpm", ["--version"])).toString("utf8").trim();
      const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
      const compilerVersion = (await execute(process.execPath, [compiler, "--version"]))
        .toString("utf8")
        .trim();
      if (
        !/^v(?:22|24)\.\d+\.\d+$/u.test(nodeVersion) ||
        pnpmVersion !== "10.34.5" ||
        compilerVersion !== "Version 7.0.2"
      )
        fail("toolchain_invalid");
      const source = Object.freeze({
        ...before,
        nodeVersion,
        pnpmVersion,
        typescriptVersion: "7.0.2",
      });
      const uid = BigInt(getUid());
      const parent = dirname(destination);
      const validDirectory = (stat, privateMode) =>
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === uid &&
        stat.ino > 0n &&
        (privateMode ? (stat.mode & 0o7777n) === 0o700n : (stat.mode & 0o022n) === 0n);
      let scratchIdentity;
      const checkScratch = async () => {
        check();
        const parentNow = await io.lstat(parent, { bigint: true });
        if (
          !validDirectory(parentNow, false) ||
          !sameIdentity(preflight.parentIdentity, parentNow) ||
          (await io.realpath(parent)) !== parent
        )
          fail("ownership_changed");
        if (scratchIdentity) {
          const current = await io.lstat(scratch, { bigint: true });
          if (!validDirectory(current, true) || !sameIdentity(scratchIdentity, current))
            fail("ownership_changed");
        }
      };
      await checkScratch();
      retained = true; // A mkdir rejection may still leave uncertain kernel state.
      await io.mkdir(scratch, { mode: 0o700 });
      scratchIdentity = await io.lstat(scratch, { bigint: true });
      if (!validDirectory(scratchIdentity, true)) fail("ownership_changed");
      const archives = {};
      for (const name of ["core", "cli"]) {
        await checkScratch();
        // Compile only our reviewed source. Never invoke arbitrary manifest scripts.
        await execute(
          process.execPath,
          [compiler, "-p", join(root, "packages", name, "tsconfig.build.json")],
          120_000,
        );
      }
      if (JSON.stringify(await observe({ root, io, execute })) !== JSON.stringify(before))
        fail("source_changed");
      const names = [];
      for (const name of ["core", "cli"]) {
        await checkScratch();
        await execute("pnpm", [
          "--config.ignore-scripts=true",
          "--config.ignore-pnpmfile=true",
          "--dir",
          join(root, "packages", name),
          "pack",
          "--pack-destination",
          scratch,
        ]);
        await checkScratch();
        const file = `agenthawk-${name}-${releaseVersion}.tgz`;
        names.push(file);
        archives[name] = await readFile(io, join(scratch, file), 1_000_000);
      }
      const handle = await io.opendir(scratch, { bufferSize: 1 });
      const seen = new Set();
      for (let count = 0; count <= names.length; count += 1) {
        const entry = await handle.read();
        check();
        if (entry === null) break;
        if (
          !names.includes(entry.name) ||
          seen.has(entry.name) ||
          !entry.isFile() ||
          entry.isSymbolicLink()
        )
          fail("archive_invalid");
        seen.add(entry.name);
      }
      await handle.close();
      if (seen.size !== names.length) fail("archive_invalid");
      await checkScratch();
      if (JSON.stringify(await observe({ root, io, execute })) !== JSON.stringify(before))
        fail("source_changed");
      const externalArchives = {};
      for (const name of ["commander", "semver", "yaml", "zod"]) {
        check();
        const chunks = [];
        let total = 0;
        try {
          await download(
            name,
            (chunk) => {
              check();
              if (!Buffer.isBuffer(chunk)) fail("download_failed");
              total += chunk.length;
              if (total > RUNTIME_ARCHIVE_POLICY[name].compressedBytes) fail("download_failed");
              chunks.push(Buffer.from(chunk));
            },
            controller.signal,
          );
        } catch (error) {
          if (error?.message === "download_cleanup_unconfirmed") fail("closure_unconfirmed");
          if (REASONS.has(error?.reason)) fail(error.reason);
          fail("download_failed");
        }
        externalArchives[name] = Buffer.concat(chunks);
      }
      const plan = planInputs({
        source,
        coreArchive: archives.core,
        cliArchive: archives.cli,
        externalArchives,
      });
      const description = describe(plan);
      if (!description || plan.status !== "planned") fail("archive_invalid");
      // These measurements come directly from our controlled fresh build, never
      // a supplied release receipt. The brand alone does not establish freshness.
      for (const name of ["core", "cli"]) {
        if (
          !description.packages.some(
            (entry) =>
              entry.name === `@agenthawk/${name}` && entry.archiveSha256 === sha256(archives[name]),
          )
        )
          fail("archive_invalid");
      }
      check();
      const written = await write({ destination, plan, signal: controller.signal });
      if (written.status !== "assembled") fail(written.reason);
      await checkScratch();
      if (JSON.stringify(await observe({ root, io, execute })) !== JSON.stringify(before))
        fail("source_changed");
      check();
      result = Object.freeze({ ...written, sourceBinding: "observed_fresh_build", ...FLAGS });
      assembledPlan = plan;
    } catch (error) {
      result = failure(REASONS.has(error?.reason) ? error.reason : "storage_failed");
    } finally {
      if (storage && !(await storage.settle())) result = failure("closure_unconfirmed");
      else if (controller.signal.aborted && result?.reason !== "closure_unconfirmed")
        result = failure(timedOut ? "deadline_exceeded" : "cancelled");
      clearTimeout(timer);
      subscribed?.removeEventListener("abort", abort);
    }
    // No capability escapes before the final source fence, confirmed settlement
    // and sticky cancellation handling. Serialized or cloned results carry none.
    if (result?.status === "assembled" && assembledPlan) freshPlans.set(result, assembledPlan);
    return result;
  };
}

export const prepareFixtureRuntime = createFixtureRuntimePreparer();

export async function runFixtureRuntimeCommand(args, prepare = prepareFixtureRuntime) {
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== "string" ||
    args[0].startsWith("-")
  ) {
    return {
      exitCode: 2,
      result: {
        schemaVersion: 1,
        status: "failed",
        reason: "invalid_destination",
        retainedState: "not_created",
        ...FLAGS,
      },
    };
  }
  const result = await prepare(args[0]);
  return { exitCode: result.status === "assembled" ? 0 : 1, result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, result } = await runFixtureRuntimeCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
