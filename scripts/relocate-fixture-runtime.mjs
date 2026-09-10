import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRuntimePlan, prepareFixtureRuntime } from "./prepare-fixture-runtime.mjs";
import { describeRuntimeAssemblyPlan } from "./runtime-assembly-inputs.mjs";
import { inspectRuntimeDestination, writeRuntimeTree } from "./runtime-tree.mjs";
import {
  describeRuntimeTreeSnapshot,
  readRuntimeTree,
  runtimeTreeSnapshotsDisjoint,
  runtimeTreeSnapshotsMatch,
} from "./runtime-tree-reader.mjs";

const FLAGS = Object.freeze({ executed: false, portableRuntime: false, nativeSupport: false });
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
  "invalid_source",
  "source_unavailable",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
  "invalid_preparation",
  "snapshot_changed",
  "snapshot_overlap",
]);

function fail(reason) {
  const error = new Error("runtime_relocation_failed");
  error.reason = REASONS.has(reason) ? reason : "storage_failed";
  throw error;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Trusted development seams only. Production accepts one fresh destination. */
export function createFixtureRuntimeRelocator(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  const inspect = overrides.inspect ?? inspectRuntimeDestination;
  const prepare = overrides.prepare ?? prepareFixtureRuntime;
  const planFor = overrides.planFor ?? fixtureRuntimePlan;
  const describePlan = overrides.describePlan ?? describeRuntimeAssemblyPlan;
  const read = overrides.read ?? readRuntimeTree;
  const describe = overrides.describe ?? describeRuntimeTreeSnapshot;
  const matches = overrides.matches ?? runtimeTreeSnapshotsMatch;
  const disjoint = overrides.disjoint ?? runtimeTreeSnapshotsDisjoint;
  const write = overrides.write ?? writeRuntimeTree;

  return async (destination, externalSignal) => {
    let retained = false;
    let result;
    let subscribed;
    let stopped;
    const controller = new AbortController();
    const stop = (reason) => {
      stopped ??= reason;
      controller.abort();
    };
    const abort = () => stop("cancelled");
    // Eight minutes preparation + bounded tree stages; the hosted job adds an outer limit.
    const timer = setTimeout(() => stop("deadline_exceeded"), 1_200_000);
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
      if (stopped) fail(stopped);
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
      if (
        typeof destination !== "string" ||
        destination.length === 0 ||
        destination.length > 4000 ||
        [...destination].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        !isAbsolute(destination) ||
        resolve(destination) !== destination ||
        dirname(destination) === destination
      )
        fail("invalid_destination");
      const source = `${destination}.source`;
      const scratch = `${source}.build`;
      let parentIdentity;
      for (const path of [destination, source, scratch]) {
        check();
        const inspected = await inspect({ destination: path, signal: controller.signal });
        if (inspected.status !== "available") fail(inspected.reason);
        if (parentIdentity && !sameIdentity(parentIdentity, inspected.parentIdentity))
          fail("ownership_changed");
        parentIdentity = inspected.parentIdentity;
      }
      check();
      retained = true; // An unexpected preparer throw may have left writes.
      const prepared = await prepare(source, controller.signal);
      if (prepared.status !== "assembled") {
        retained = prepared.retainedState !== "not_created";
        fail(prepared.reason);
      }
      check();
      const plan = planFor(prepared);
      const description = describePlan(plan);
      if (!plan || !description) fail("invalid_preparation");
      const measure = async (path) => {
        check();
        const snapshot = await read({ source: path, plan, signal: controller.signal });
        // A result description exists only for an internally branded, settled read.
        const measured = describe(snapshot);
        if (!measured) fail(snapshot?.reason);
        check();
        if (
          measured.sourceTreeSha256 !== description.plannedTreeSha256 ||
          measured.fileCount !== description.fileCount ||
          measured.fileBytes !== description.fileBytes
        )
          fail("tree_mismatch");
        return snapshot;
      };
      const sourceBefore = await measure(source);
      check();
      const written = await write({
        destination,
        plan,
        sourceSnapshot: sourceBefore,
        signal: controller.signal,
      });
      if (written.status !== "assembled") fail(written.reason);
      check();
      const destinationBefore = await measure(destination);
      const sourceAfter = await measure(source);
      const destinationAfter = await measure(destination);
      if (!matches(sourceBefore, sourceAfter) || !matches(destinationBefore, destinationAfter))
        fail("snapshot_changed");
      if (!disjoint(sourceAfter, destinationAfter)) fail("snapshot_overlap");
      check();
      result = Object.freeze({
        ...description,
        sourceBinding: "observed_fresh_build",
        status: "relocated",
        sourceTreeSha256: describe(sourceAfter).sourceTreeSha256,
        destinationTreeSha256: describe(destinationAfter).sourceTreeSha256,
        ...FLAGS,
      });
    } catch (error) {
      result = failure(REASONS.has(error?.reason) ? error.reason : "storage_failed");
    } finally {
      // Each nested operation settles its owned I/O before returning. Never replace
      // an unconfirmed closure with generic cancellation or a successful receipt.
      if (stopped && result?.reason !== "closure_unconfirmed") result = failure(stopped);
      clearTimeout(timer);
      subscribed?.removeEventListener("abort", abort);
    }
    return result;
  };
}

export const relocateFixtureRuntime = createFixtureRuntimeRelocator();

export async function runRuntimeRelocationCommand(args, relocate = relocateFixtureRuntime) {
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
  const result = await relocate(args[0]);
  return { exitCode: result.status === "relocated" ? 0 : 1, result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, result } = await runRuntimeRelocationCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
