import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import {
  cliErrorReportSchema,
  type InitIntegration,
  type InitTarget,
  initReportSchema,
} from "@agenthawk/core";
import type { CheckResult, OutputFormat } from "./check.js";
import { type InitAsset, initAssets } from "./init-content.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

const maximumDirectoryEntries = 4_096;
const lockName = ".agenthawk-init.lock";

export interface InitOptions {
  format: OutputFormat;
  integration: InitIntegration;
}

export interface InitDependencies {
  afterPublish?: (target: InitTarget, path: string) => Promise<void>;
  afterCreateParent?: (path: string) => Promise<void>;
  afterTargetInspect?: (target: InitTarget, path: string) => Promise<void>;
  afterTrackedCreation?: (
    kind: "lock" | "parent" | "stage" | "staging",
    path: string,
  ) => Promise<void>;
  assets?: (integration: InitIntegration) => readonly InitAsset[];
  beforeCreateParent?: (path: string) => Promise<void>;
  beforeLink?: (target: InitTarget, path: string) => Promise<void>;
  beforePublish?: (target: InitTarget) => Promise<void>;
  cwd?: string;
  inspectCreatedIdentity?: (
    kind: "lock" | "parent" | "stage" | "staging",
    path: string,
    inspect: () => Promise<Stats>,
  ) => Promise<Stats>;
  uuid?: () => string;
}

interface PreparedAsset extends InitAsset {
  bytes: Buffer;
  name: string;
  path: string;
  state: "absent" | "unchanged";
}

interface TrackedPath {
  path: string;
  stats: Stats;
}

class InitInputError extends Error {}
class InitCleanupUnconfirmedError extends Error {}

export async function initializeRepository(
  options: InitOptions,
  dependencies: InitDependencies = {},
): Promise<CheckResult> {
  const createdFiles: TrackedPath[] = [];
  const createdDirectories: TrackedPath[] = [];
  const stagedFiles: TrackedPath[] = [];
  let stagingDirectory: TrackedPath | undefined;
  let lock: { handle: FileHandle; path: string; stats: Stats } | undefined;
  try {
    const root = await initializationRoot(dependencies.cwd ?? process.cwd());
    const bundledAssets = (dependencies.assets ?? initAssets)(options.integration);
    let assets = await prepareAssets(root, bundledAssets, dependencies);
    const lockPath = join(root, lockName);
    await assertNameAvailable(root, lockName, true);
    let lockHandle: FileHandle;
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch {
      throw new InitInputError("Initialization lock is unavailable.");
    }
    let lockStats: Stats;
    try {
      lockStats = await (dependencies.inspectCreatedIdentity?.("lock", lockPath, () =>
        lockHandle.stat(),
      ) ?? lockHandle.stat());
    } catch {
      try {
        await lockHandle.close();
      } catch {}
      throw new InitCleanupUnconfirmedError("Initialization lock identity is unavailable.");
    }
    lock = { handle: lockHandle, path: lockPath, stats: lockStats };
    await dependencies.afterTrackedCreation?.("lock", lockPath);
    await lockHandle.writeFile("agenthawk-init\n", "utf8");
    await lockHandle.sync();

    assets = await prepareAssets(root, bundledAssets, dependencies);
    for (const asset of assets.filter((candidate) => candidate.state === "absent")) {
      await createParentDirectories(
        root,
        asset.segments.slice(0, -1),
        createdDirectories,
        dependencies,
      );
    }

    const stagingName = `.agenthawk-init-${(dependencies.uuid ?? randomUUID)()}`;
    validateSegment(stagingName);
    const stagingPath = join(root, stagingName);
    await assertNameAvailable(root, stagingName, false);
    await mkdir(stagingPath, { mode: 0o700 });
    let stagingStats: Stats;
    try {
      stagingStats = await (dependencies.inspectCreatedIdentity?.("staging", stagingPath, () =>
        lstat(stagingPath),
      ) ?? lstat(stagingPath));
    } catch {
      throw new InitCleanupUnconfirmedError("Staging directory identity is unavailable.");
    }
    if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
      throw new InitCleanupUnconfirmedError("Staging directory could not be verified.");
    }
    stagingDirectory = { path: stagingPath, stats: stagingStats };
    await dependencies.afterTrackedCreation?.("staging", stagingPath);

    for (const [index, asset] of assets.entries()) {
      if (asset.state === "unchanged") continue;
      const stagePath = join(stagingPath, `${index}.tmp`);
      const handle = await open(stagePath, "wx", 0o600);
      let initialStageStats: Stats;
      try {
        initialStageStats = await (dependencies.inspectCreatedIdentity?.("stage", stagePath, () =>
          handle.stat(),
        ) ?? handle.stat());
      } catch {
        try {
          await handle.close();
        } catch {}
        throw new InitCleanupUnconfirmedError("Staged file identity is unavailable.");
      }
      const trackedStage = { path: stagePath, stats: initialStageStats };
      stagedFiles.push(trackedStage);
      let stageStats = trackedStage.stats;
      try {
        await dependencies.afterTrackedCreation?.("stage", stagePath);
        await handle.writeFile(asset.bytes);
        await handle.sync();
        stageStats = await handle.stat();
        trackedStage.stats = stageStats;
        if (!stageStats.isFile() || stageStats.size !== asset.bytes.length) {
          throw new Error("Staged initialization asset could not be verified.");
        }
      } finally {
        await handle.close();
      }
      await dependencies.beforePublish?.(asset.target);
      await assertPublishTarget(root, asset);
      await dependencies.beforeLink?.(asset.target, asset.path);
      try {
        await link(stagePath, asset.path);
      } catch {
        throw new InitInputError("Initialization target appeared during publication.");
      }
      createdFiles.push({ path: asset.path, stats: stageStats });
      await dependencies.afterPublish?.(asset.target, asset.path);
      await unlink(stagePath);
      stagedFiles.splice(stagedFiles.indexOf(trackedStage), 1);
      await verifyExpectedFile(root, asset, stageStats);
    }

    if (!(await removeTrackedDirectory(stagingDirectory))) {
      throw new Error("Staging directory cleanup could not be confirmed.");
    }
    stagingDirectory = undefined;
    if (!(await releaseLock(lock))) throw new Error("Initialization lock cleanup failed.");
    lock = undefined;

    const created = assets.filter((asset) => asset.state === "absent").map((asset) => asset.target);
    const unchanged = assets
      .filter((asset) => asset.state === "unchanged")
      .map((asset) => asset.target);
    const report = initReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: AGENTHAWK_CLI_VERSION,
      command: "init",
      initialized: true,
      integration: options.integration,
      policyVersion: 1,
      templateVersion: 1,
      created,
      unchanged,
      providersContacted: false,
    });
    return {
      exitCode: 0,
      output:
        options.format === "json"
          ? `${JSON.stringify(report)}\n`
          : renderInit(created, unchanged, options.integration),
    };
  } catch (error) {
    const cleanupConfirmed =
      (await rollback({
        createdDirectories,
        createdFiles,
        lock,
        stagedFiles,
        stagingDirectory,
      })) && !(error instanceof InitCleanupUnconfirmedError);
    const invalidInput = error instanceof InitInputError && cleanupConfirmed;
    const message = invalidInput
      ? "Initialization cannot continue because a target or parent path is unsafe or contains different content."
      : cleanupConfirmed
        ? "Initialization failed safely; newly created targets were rolled back."
        : "Initialization failed and cleanup could not be confirmed; inspect the documented initialization targets before retrying.";
    return {
      exitCode: invalidInput ? 2 : 4,
      output:
        options.format === "json"
          ? `${JSON.stringify(
              cliErrorReportSchema.parse({
                schemaVersion: "1.0",
                error: { code: invalidInput ? "invalid_input" : "internal_error", message },
                exitCode: invalidInput ? 2 : 4,
              }),
            )}\n`
          : `AgentHawk: ${escapeTerminal(message)}\n`,
    };
  }
}

async function initializationRoot(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new InitInputError("Initialization root must be absolute.");
  const resolved = resolve(input);
  if (parse(resolved).root === resolved || resolved.startsWith("\\\\")) {
    throw new InitInputError("Initialization root is unsupported.");
  }
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw new InitInputError("Initialization root is unavailable.");
  }
  let rootStats: Stats | undefined;
  try {
    rootStats = await lstat(resolved);
  } catch {
    rootStats = undefined;
  }
  if (
    !rootStats ||
    rootStats.isSymbolicLink() ||
    !rootStats.isDirectory() ||
    !samePath(resolved, canonical)
  ) {
    throw new InitInputError("Initialization root is unsafe.");
  }
  return canonical;
}

async function prepareAssets(
  root: string,
  assets: readonly InitAsset[],
  dependencies: InitDependencies,
): Promise<PreparedAsset[]> {
  const prepared: PreparedAsset[] = [];
  for (const asset of assets) {
    const name = asset.segments.at(-1);
    if (name === undefined) throw new InitInputError("Initialization target mapping is invalid.");
    for (const segment of asset.segments) validateSegment(segment);
    const path = resolve(root, ...asset.segments);
    const contained = relative(root, path);
    if (
      !contained ||
      contained.startsWith(`..${sep}`) ||
      contained === ".." ||
      isAbsolute(contained)
    ) {
      throw new InitInputError("Initialization target escaped the root.");
    }
    const bytes = Buffer.from(asset.content, "utf8");
    if (bytes.length === 0 || bytes.length > 32_768 || !asset.content.endsWith("\n")) {
      throw new Error("Bundled initialization asset is invalid.");
    }
    const state = await existingTargetState(root, asset, name, path, bytes, dependencies);
    prepared.push({ ...asset, bytes, name, path, state });
  }
  return prepared;
}

async function existingTargetState(
  root: string,
  asset: InitAsset,
  name: string,
  path: string,
  expected: Buffer,
  dependencies: InitDependencies,
): Promise<"absent" | "unchanged"> {
  const { segments } = asset;
  const parentState = await inspectParents(root, segments.slice(0, -1));
  if (parentState === "missing") return "absent";
  const parent = segments.slice(0, -1).reduce((current, segment) => join(current, segment), root);
  await assertNameAvailable(parent, name, true);
  let initial: Stats;
  try {
    initial = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return "absent";
    throw new InitInputError("Initialization target is unreadable.");
  }
  if (
    initial.isSymbolicLink() ||
    !initial.isFile() ||
    initial.nlink !== 1 ||
    initial.size !== expected.length
  ) {
    throw new InitInputError("Initialization target collides with existing content.");
  }
  await dependencies.afterTargetInspect?.(asset.target, path);
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    throw new InitInputError("Initialization target is unreadable.");
  }
  try {
    const opened = await handle.stat();
    if (!sameIdentity(initial, opened) || !opened.isFile() || opened.nlink !== 1) {
      throw new InitInputError("Initialization target changed during inspection.");
    }
    const bytes = Buffer.alloc(expected.length + 1);
    let read = 0;
    while (read < bytes.length) {
      const chunk = await handle.read(bytes, read, bytes.length - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    const final = await lstat(path);
    if (
      !sameIdentity(initial, final) ||
      final.size !== initial.size ||
      read !== expected.length ||
      !bytes.subarray(0, read).equals(expected)
    ) {
      throw new InitInputError("Initialization target contains different content.");
    }
    return "unchanged";
  } finally {
    await handle.close();
  }
}

async function inspectParents(
  root: string,
  segments: readonly string[],
): Promise<"present" | "missing"> {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new InitInputError("Initialization parent is unsafe.");
      }
    } catch (error) {
      if (error instanceof InitInputError) throw error;
      if (isMissing(error)) return "missing";
      throw new InitInputError("Initialization parent is unreadable.");
    }
  }
  return "present";
}

async function createParentDirectories(
  root: string,
  segments: readonly string[],
  tracked: TrackedPath[],
  dependencies: InitDependencies,
): Promise<void> {
  let current = root;
  for (const segment of segments) {
    await assertNameAvailable(current, segment, true);
    current = join(current, segment);
    await dependencies.beforeCreateParent?.(current);
    let createdStats: Stats | undefined;
    try {
      await mkdir(current, { mode: 0o700 });
      let stats: Stats;
      try {
        stats = await (dependencies.inspectCreatedIdentity?.("parent", current, () =>
          lstat(current),
        ) ?? lstat(current));
      } catch {
        throw new InitCleanupUnconfirmedError(
          "Created initialization parent could not be identified.",
        );
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new InitCleanupUnconfirmedError("Created initialization parent is unsafe.");
      }
      tracked.push({ path: current, stats });
      createdStats = stats;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        if (error instanceof InitCleanupUnconfirmedError) throw error;
        if (error instanceof InitInputError) throw error;
        throw new InitInputError("Initialization parent could not be created.");
      }
      let stats: Stats | undefined;
      try {
        stats = await lstat(current);
      } catch {
        stats = undefined;
      }
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new InitInputError("Initialization parent is unsafe.");
      }
    }
    if (createdStats) {
      await dependencies.afterTrackedCreation?.("parent", current);
      await dependencies.afterCreateParent?.(current);
      const verified = await lstat(current);
      if (
        verified.isSymbolicLink() ||
        !verified.isDirectory() ||
        !sameIdentity(createdStats, verified)
      ) {
        throw new InitInputError("Created initialization parent changed before use.");
      }
    }
  }
}

async function assertPublishTarget(root: string, asset: PreparedAsset): Promise<void> {
  if ((await inspectParents(root, asset.segments.slice(0, -1))) !== "present") {
    throw new InitInputError("Initialization parent disappeared.");
  }
  const parent = asset.segments
    .slice(0, -1)
    .reduce((current, segment) => join(current, segment), root);
  await assertNameAvailable(parent, asset.name, false);
  try {
    await lstat(asset.path);
    throw new InitInputError("Initialization target appeared during publication.");
  } catch (error) {
    if (error instanceof InitInputError) throw error;
    if (!isMissing(error)) throw new InitInputError("Initialization target is unreadable.");
  }
}

async function verifyExpectedFile(
  root: string,
  asset: PreparedAsset,
  expectedIdentity: Stats,
): Promise<void> {
  if ((await inspectParents(root, asset.segments.slice(0, -1))) !== "present") {
    throw new Error("Published initialization parent could not be verified.");
  }
  const stats = await lstat(asset.path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.nlink !== 1 ||
    !sameIdentity(stats, expectedIdentity) ||
    stats.size !== asset.bytes.length
  ) {
    throw new Error("Published initialization target could not be verified.");
  }
  const digest = createHash("sha256")
    .update(await readVerifiedBytes(asset.path, stats))
    .digest("hex");
  const expectedDigest = createHash("sha256").update(asset.bytes).digest("hex");
  if (digest !== expectedDigest)
    throw new Error("Published initialization bytes are inconsistent.");
}

async function readVerifiedBytes(path: string, initial: Stats): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!sameIdentity(initial, opened) || !opened.isFile())
      throw new Error("File identity changed.");
    const bytes = Buffer.alloc(initial.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const chunk = await handle.read(bytes, read, bytes.length - read, read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    const final = await lstat(path);
    if (!sameIdentity(initial, final) || final.size !== initial.size || read !== initial.size) {
      throw new Error("File changed while being verified.");
    }
    return bytes.subarray(0, read);
  } finally {
    await handle.close();
  }
}

async function assertNameAvailable(
  parent: string,
  expectedName: string,
  allowExact: boolean,
): Promise<void> {
  validateSegment(expectedName);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (isMissing(error)) return;
    throw new InitInputError("Initialization directory could not be enumerated.");
  }
  if (entries.length > maximumDirectoryEntries) {
    throw new InitInputError("Initialization directory is too large to inspect safely.");
  }
  const collision = entries.find(
    (entry) =>
      asciiFold(entry) === asciiFold(expectedName) && (!allowExact || entry !== expectedName),
  );
  if (collision) throw new InitInputError("Initialization target has a case collision.");
}

function validateSegment(segment: string): void {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes(":")
  ) {
    throw new InitInputError("Initialization target mapping is invalid.");
  }
}

async function rollback(state: {
  createdDirectories: TrackedPath[];
  createdFiles: TrackedPath[];
  lock: { handle: FileHandle; path: string; stats: Stats } | undefined;
  stagedFiles: TrackedPath[];
  stagingDirectory: TrackedPath | undefined;
}): Promise<boolean> {
  let confirmed = true;
  for (const file of [...state.createdFiles].reverse()) {
    confirmed = (await removeTrackedFile(file)) && confirmed;
  }
  for (const file of [...state.stagedFiles].reverse()) {
    confirmed = (await removeTrackedFile(file)) && confirmed;
  }
  if (state.stagingDirectory) {
    confirmed = (await removeTrackedDirectory(state.stagingDirectory)) && confirmed;
  }
  for (const directory of [...state.createdDirectories].reverse()) {
    confirmed = (await removeTrackedDirectory(directory)) && confirmed;
  }
  if (state.lock) confirmed = (await releaseLock(state.lock)) && confirmed;
  return confirmed;
}

async function removeTrackedFile(tracked: TrackedPath): Promise<boolean> {
  try {
    const current = await lstat(tracked.path);
    if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, tracked.stats)) {
      return false;
    }
    await unlink(tracked.path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function removeTrackedDirectory(tracked: TrackedPath): Promise<boolean> {
  try {
    const current = await lstat(tracked.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(current, tracked.stats)
    ) {
      return false;
    }
    await rmdir(tracked.path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function releaseLock(lock: {
  handle: FileHandle;
  path: string;
  stats: Stats;
}): Promise<boolean> {
  let confirmed = true;
  try {
    await lock.handle.close();
  } catch {
    confirmed = false;
  }
  return (await removeTrackedFile({ path: lock.path, stats: lock.stats })) && confirmed;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function isMissing(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function renderInit(
  created: readonly InitTarget[],
  unchanged: readonly InitTarget[],
  integration: InitIntegration,
): string {
  return [
    `AgentHawk v${AGENTHAWK_CLI_VERSION}`,
    "",
    "Initialization: COMPLETE",
    `Integration: ${integration}`,
    `Created: ${created.length === 0 ? "none" : created.join(", ")}`,
    `Unchanged: ${unchanged.length === 0 ? "none" : unchanged.join(", ")}`,
    "",
    "Generated integration instructions are advisory; protected CI remains authoritative.",
    "",
  ].join("\n");
}
