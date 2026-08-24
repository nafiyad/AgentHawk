import { randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancellationError,
  cliErrorReportSchema,
  codexProjectHookLifecycleReportSchema,
  codexProjectHookStatusReportSchema,
  isOperationCancelled,
  type OperationContext,
  throwIfCancelled,
} from "@agenthawk/core";
import type { CheckResult, OutputFormat } from "./check.js";
import {
  buildCodexProjectHookArtifacts,
  buildCodexProjectHookLockBytes,
  createCodexProjectHookIdentifier,
  parseCodexProjectHookReceiptBytes,
  verifyCodexProjectHookBytes,
  verifyCodexProjectHookReceiptBinding,
} from "./codex-project-hook-format.js";
import {
  type CodexProjectHookStatusDependencies,
  statusCodexProjectHook,
} from "./codex-project-hook-status.js";
import {
  loadRepositoryAuthority,
  type RepositoryAuthority,
  RepositoryAuthorityError,
} from "./repository-authority.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

const lockName = ".agenthawk-codex-integration.lock";
const maximumAdapterBytes = 1_048_576;
const maximumHookBytes = 65_536;
const maximumReceiptBytes = 8_192;

export interface CodexProjectHookLifecycleOptions extends OperationContext {
  readonly format: OutputFormat;
}

export interface CodexProjectHookTransactionDependencies
  extends CodexProjectHookStatusDependencies {
  readonly checkpoint?: (name: TransactionCheckpoint) => Promise<void> | void;
  readonly createIdentifier?: () => string;
  readonly linkFile?: typeof link;
  readonly makeDirectory?: typeof mkdir;
  readonly removeDirectory?: typeof rmdir;
  readonly unlinkFile?: typeof unlink;
}

export type TransactionCheckpoint =
  | "lock_created"
  | "parents_ready"
  | "staging_ready"
  | "staged_files_ready"
  | "capability_verified"
  | "before_receipt_publish"
  | "receipt_published"
  | "before_hook_publish"
  | "hook_published"
  | "before_hook_remove"
  | "hook_removed"
  | "before_receipt_remove"
  | "receipt_removed"
  | "before_cleanup";

interface TrackedFile {
  readonly bytes: Buffer;
  readonly path: string;
  readonly stats: BigIntStats;
}

interface TrackedDirectory {
  readonly path: string;
  readonly stats: BigIntStats;
}

interface OperationLock extends TrackedFile {
  readonly handle: FileHandle;
  readonly operationId: string;
}

class LifecycleInputError extends Error {}
class LifecycleRecoveryError extends Error {}

export async function installCodexProjectHook(
  options: CodexProjectHookLifecycleOptions,
  dependencies: CodexProjectHookTransactionDependencies = {},
): Promise<CheckResult> {
  let authority: RepositoryAuthority;
  try {
    authority = await (dependencies.loadAuthority ?? loadRepositoryAuthority)(
      dependencies.cwd ?? process.cwd(),
      options,
    );
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("install", options.format, error);
  }
  const cwd = authority.repositoryRoot;
  const initial = await observe(cwd, options, dependencies);
  if (initial.ownership !== "absent" || initial.blockers.length > 0) {
    return lifecycleFailure("install", options.format, new LifecycleInputError());
  }

  const operationId = identifier(dependencies);
  let operationLock: OperationLock | undefined;
  let staging: TrackedDirectory | undefined;
  const staged: TrackedFile[] = [];
  let receiptPublished: TrackedFile | undefined;
  let hookPublished: TrackedFile | undefined;
  try {
    throwIfCancelled(options);
    operationLock = await acquireLock(cwd, operationId, dependencies);
    await checkpoint(dependencies, "lock_created");
    await requireInstallable(cwd, options, dependencies, operationId);

    await ensureDirectory(cwd, ".codex", dependencies);
    const agenthawk = await ensureDirectory(cwd, ".agenthawk", dependencies);
    await ensureDirectory(agenthawk.path, "integrations", dependencies);
    await checkpoint(dependencies, "parents_ready");
    await requireInstallable(cwd, options, dependencies, operationId);

    const stagingName = `.agenthawk-codex-integration-${operationId}`;
    staging = await createDirectory(cwd, stagingName, dependencies);
    await checkpoint(dependencies, "staging_ready");

    const adapterEntry = await realpath(
      dependencies.adapterEntry ??
        fileURLToPath(new URL("./codex-pretooluse-entry.js", import.meta.url)),
    );
    throwIfCancelled(options);
    const nodeExecutable = await realpath(dependencies.nodeExecutable ?? process.execPath);
    throwIfCancelled(options);
    const adapterBytes = await readRegular(
      adapterEntry,
      maximumAdapterBytes,
      undefined,
      dependencies,
    );
    const rootStats = await stableDirectory(cwd);
    if (!sameIdentity(rootStats.stats, authority.repositoryIdentity)) {
      throw new LifecycleInputError();
    }
    const artifacts = buildCodexProjectHookArtifacts({
      adapterBytes,
      adapterEntry,
      adapterVersion: dependencies.adapterVersion ?? AGENTHAWK_CLI_VERSION,
      installationId: identifier(dependencies),
      nodeExecutable,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      repositoryIdentity: { dev: rootStats.stats.dev, ino: rootStats.stats.ino },
      repositoryRoot: rootStats.path,
    });
    const receiptStage = await createStageFile(
      staging.path,
      "codex-v1.json",
      artifacts.receiptBytes,
      dependencies,
    );
    staged.push(receiptStage);
    const hookStage = await createStageFile(
      staging.path,
      "hooks.json",
      artifacts.hookBytes,
      dependencies,
    );
    staged.push(hookStage);
    await checkpoint(dependencies, "staged_files_ready");
    await verifyNoReplaceCapability(staging, receiptStage, hookStage, dependencies);
    await checkpoint(dependencies, "capability_verified");
    await requireInstallable(cwd, options, dependencies, operationId);

    throwIfCancelled(options);
    await checkpoint(dependencies, "before_receipt_publish");
    throwIfCancelled(options);
    receiptPublished = await publish(
      receiptStage,
      join(cwd, ".agenthawk", "integrations", "codex-v1.json"),
      dependencies,
    );
    staged.splice(staged.indexOf(receiptStage), 1);
    await checkpoint(dependencies, "receipt_published");
    if (options.signal?.aborted) {
      const rolledBack = await removeTrackedFile(receiptPublished, dependencies);
      receiptPublished = undefined;
      if (!rolledBack) throw new LifecycleRecoveryError();
      throw cancellationError(options.signal);
    }

    await checkpoint(dependencies, "before_hook_publish");
    throwIfCancelled(options);
    hookPublished = await publish(hookStage, join(cwd, ".codex", "hooks.json"), dependencies);
    staged.splice(staged.indexOf(hookStage), 1);
    await checkpoint(dependencies, "hook_published");

    await checkpoint(dependencies, "before_cleanup");
    const cleaned = await cleanupOperation(staged, staging, operationLock, dependencies);
    staging = undefined;
    operationLock = undefined;
    if (!cleaned) return lifecycleRecovery("install", options.format, cwd, dependencies);
    const final = await observe(cwd, {}, dependencies);
    if (
      final.ownership !== "owned_exact" ||
      final.readiness !== "current" ||
      final.blockers.length > 0
    ) {
      return lifecycleRecovery("install", options.format, cwd, dependencies);
    }
    return lifecycleSuccess("install", options.format, "installed", final);
  } catch (error) {
    const receiptRollback =
      hookPublished || !receiptPublished
        ? true
        : await removeTrackedFile(receiptPublished, dependencies);
    const cleaned = await cleanupOperation(staged, staging, operationLock, dependencies);
    if (hookPublished || !receiptRollback || !cleaned || error instanceof LifecycleRecoveryError) {
      return lifecycleRecovery("install", options.format, cwd, dependencies);
    }
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("install", options.format, error);
  }
}

export async function removeCodexProjectHook(
  options: CodexProjectHookLifecycleOptions,
  dependencies: CodexProjectHookTransactionDependencies = {},
): Promise<CheckResult> {
  let authority: RepositoryAuthority;
  try {
    authority = await (dependencies.loadAuthority ?? loadRepositoryAuthority)(
      dependencies.cwd ?? process.cwd(),
      options,
    );
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("remove", options.format, error);
  }
  const cwd = authority.repositoryRoot;
  const initial = await observe(cwd, options, dependencies);
  if (
    !["owned_exact", "owned_inactive"].includes(initial.ownership) ||
    initial.blockers.includes("operation_locked")
  ) {
    return lifecycleFailure("remove", options.format, new LifecycleInputError());
  }

  const operationId = identifier(dependencies);
  let operationLock: OperationLock | undefined;
  let committed = false;
  try {
    throwIfCancelled(options);
    operationLock = await acquireLock(cwd, operationId, dependencies);
    await checkpoint(dependencies, "lock_created");
    const underLock = await observe(cwd, options, dependencies, operationId);
    if (!["owned_exact", "owned_inactive"].includes(underLock.ownership)) {
      throw new LifecycleInputError();
    }
    const receiptPath = join(cwd, ".agenthawk", "integrations", "codex-v1.json");
    const receipt = await readRegular(receiptPath, maximumReceiptBytes, 1n, dependencies);
    const parsedReceipt = parseCodexProjectHookReceiptBytes(receipt);
    const root = await stableDirectory(cwd);
    if (
      !sameIdentity(root.stats, authority.repositoryIdentity) ||
      !parsedReceipt ||
      !verifyCodexProjectHookReceiptBinding(parsedReceipt, root.path, {
        dev: root.stats.dev,
        ino: root.stats.ino,
      })
    ) {
      throw new LifecycleInputError();
    }

    if (underLock.ownership === "owned_exact") {
      throwIfCancelled(options);
      const hookPath = join(cwd, ".codex", "hooks.json");
      const hook = await trackedExistingFile(hookPath, maximumHookBytes, dependencies);
      if (!verifyCodexProjectHookBytes(parsedReceipt, hook.bytes)) throw new LifecycleInputError();
      await checkpoint(dependencies, "before_hook_remove");
      throwIfCancelled(options);
      if (!(await removeTrackedFile(hook, dependencies))) throw new LifecycleRecoveryError();
      committed = true;
      await checkpoint(dependencies, "hook_removed");
    }

    const settledOptions = committed ? {} : options;
    const inactive = await observe(cwd, settledOptions, dependencies, operationId);
    if (inactive.ownership !== "owned_inactive") throw new LifecycleRecoveryError();
    const trackedReceipt = await trackedExistingFile(
      receiptPath,
      maximumReceiptBytes,
      dependencies,
    );
    if (!trackedReceipt.bytes.equals(receipt)) throw new LifecycleRecoveryError();
    if (!committed) throwIfCancelled(options);
    await checkpoint(dependencies, "before_receipt_remove");
    if (!committed) throwIfCancelled(options);
    if (!(await removeTrackedFile(trackedReceipt, dependencies)))
      throw new LifecycleRecoveryError();
    committed = true;
    await checkpoint(dependencies, "receipt_removed");
    const absent = await observe(cwd, {}, dependencies, operationId);
    if (absent.ownership !== "absent") throw new LifecycleRecoveryError();
    const released = await releaseLock(operationLock, dependencies);
    operationLock = undefined;
    if (!released) return lifecycleRecovery("remove", options.format, cwd, dependencies);
    const final = await observe(cwd, {}, dependencies);
    if (final.ownership !== "absent" || final.blockers.includes("operation_locked")) {
      return lifecycleRecovery("remove", options.format, cwd, dependencies);
    }
    return lifecycleSuccess("remove", options.format, "removed", final);
  } catch (error) {
    const released = operationLock ? await releaseLock(operationLock, dependencies) : true;
    operationLock = undefined;
    if (committed || !released || error instanceof LifecycleRecoveryError) {
      return lifecycleRecovery("remove", options.format, cwd, dependencies);
    }
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("remove", options.format, error);
  }
}

async function observe(
  cwd: string,
  options: OperationContext,
  dependencies: CodexProjectHookTransactionDependencies,
  ownedOperationId?: string,
) {
  const result = await statusCodexProjectHook(
    { format: "json", signal: options.signal, ownedOperationId },
    { ...dependencies, cwd },
  );
  if (result.exitCode === 4) throw new Error("Status observation failed.");
  return codexProjectHookStatusReportSchema.parse(JSON.parse(result.output));
}

async function requireInstallable(
  cwd: string,
  options: OperationContext,
  dependencies: CodexProjectHookTransactionDependencies,
  operationId: string,
): Promise<void> {
  const report = await observe(cwd, options, dependencies, operationId);
  if (report.ownership !== "absent" || report.blockers.length > 0) {
    throw new LifecycleInputError();
  }
}

async function acquireLock(
  root: string,
  operationId: string,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<OperationLock> {
  const path = join(root, lockName);
  const bytes = buildCodexProjectHookLockBytes(operationId);
  const handle = await (dependencies.openFile ?? open)(path, "wx+", 0o600);
  let createdStats: BigIntStats | undefined;
  try {
    createdStats = await handle.stat({ bigint: true });
    if (!safeRegular(createdStats, 0, 1n)) throw new Error("Lock is unsafe.");
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    if (!safeRegular(stats, bytes.length, 1n)) throw new Error("Lock is unsafe.");
    const named = await lstat(path, { bigint: true });
    if (!sameIdentity(stats, named) || !safeRegular(named, bytes.length, 1n)) {
      throw new Error("Lock identity changed.");
    }
    return { bytes, handle, operationId, path, stats };
  } catch (error) {
    const closed = await handle
      .close()
      .then(() => true)
      .catch(() => false);
    const removed = createdStats
      ? await removeTrackedFile({ bytes: Buffer.alloc(0), path, stats: createdStats }, dependencies)
      : false;
    if (!closed || !removed) throw new LifecycleRecoveryError();
    throw error;
  }
}

async function ensureDirectory(
  parent: string,
  name: string,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<TrackedDirectory> {
  const path = join(parent, name);
  try {
    await (dependencies.makeDirectory ?? mkdir)(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  return await stableDirectory(path);
}

async function createDirectory(
  parent: string,
  name: string,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<TrackedDirectory> {
  const path = join(parent, name);
  await (dependencies.makeDirectory ?? mkdir)(path, { mode: 0o700 });
  return await stableDirectory(path);
}

async function stableDirectory(path: string): Promise<TrackedDirectory> {
  const canonical = await realpath(path);
  const stats = await lstat(path, { bigint: true });
  const canonicalStats = await lstat(canonical, { bigint: true });
  if (
    resolve(canonical) !== resolve(path) ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameIdentity(stats, canonicalStats)
  ) {
    throw new LifecycleInputError();
  }
  return { path: resolve(canonical), stats };
}

async function createStageFile(
  parent: string,
  name: string,
  bytes: Buffer,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<TrackedFile> {
  const path = join(parent, name);
  const handle = await (dependencies.openFile ?? open)(path, "wx+", 0o600);
  let stats: BigIntStats;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    stats = await handle.stat({ bigint: true });
    if (!safeRegular(stats, bytes.length, 1n)) throw new Error("Stage file is unsafe.");
  } finally {
    await handle.close();
  }
  const tracked = { bytes, path, stats };
  if (!(await verifyTrackedFile(tracked, 1n, dependencies))) throw new Error("Stage changed.");
  return tracked;
}

async function verifyNoReplaceCapability(
  staging: TrackedDirectory,
  first: TrackedFile,
  second: TrackedFile,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<void> {
  const probePath = join(staging.path, ".no-replace-probe");
  const linkFile = dependencies.linkFile ?? link;
  const attempts = await Promise.allSettled([
    linkFile(first.path, probePath),
    linkFile(second.path, probePath),
  ]);
  const winners = attempts
    .map((result, index) => ({ result, source: index === 0 ? first : second }))
    .filter(({ result }) => result.status === "fulfilled");
  const losers = attempts.filter((result) => result.status === "rejected");
  if (
    winners.length !== 1 ||
    losers.length !== 1 ||
    !hasCode((losers[0] as PromiseRejectedResult).reason, "EEXIST")
  ) {
    throw new LifecycleInputError();
  }
  const winner = winners[0]?.source;
  if (!winner) throw new LifecycleInputError();
  const probe = await trackedExistingFile(probePath, winner.bytes.length, dependencies, 2n);
  if (!probe.bytes.equals(winner.bytes) || !sameIdentity(probe.stats, winner.stats)) {
    throw new LifecycleInputError();
  }
  if (!(await removeTrackedFile(probe, dependencies))) throw new LifecycleInputError();
  if (!(await verifyTrackedFile(winner, 1n, dependencies))) throw new LifecycleInputError();
  const occupiedPath = join(staging.path, ".occupied-probe");
  const occupied = await createStageFile(
    staging.path,
    ".occupied-probe",
    Buffer.from("agenthawk-no-replace\n", "utf8"),
    dependencies,
  );
  try {
    await linkFile(first.path, occupiedPath);
    throw new LifecycleInputError();
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  if (!(await verifyTrackedFile(occupied, 1n, dependencies))) throw new LifecycleInputError();
  if (!(await removeTrackedFile(occupied, dependencies))) throw new LifecycleInputError();
  if (!(await verifyTrackedFile(first, 1n, dependencies))) throw new LifecycleInputError();
  if (!(await verifyTrackedFile(second, 1n, dependencies))) throw new LifecycleInputError();
}

async function publish(
  source: TrackedFile,
  destination: string,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<TrackedFile> {
  try {
    await (dependencies.linkFile ?? link)(source.path, destination);
  } catch {
    try {
      const destinationStats = await lstat(destination, { bigint: true });
      if (!sameIdentity(destinationStats, source.stats)) throw new LifecycleInputError();
    } catch (inspectionError) {
      if (inspectionError instanceof LifecycleInputError) throw inspectionError;
      if (hasCode(inspectionError, "ENOENT")) throw new LifecycleInputError();
      throw new LifecycleRecoveryError();
    }
  }
  const published = await trackedExistingFile(destination, source.bytes.length, dependencies, 2n);
  if (!published.bytes.equals(source.bytes) || !sameIdentity(published.stats, source.stats)) {
    throw new LifecycleRecoveryError();
  }
  if (!(await removeTrackedFile(source, dependencies))) throw new LifecycleRecoveryError();
  const final = await trackedExistingFile(destination, source.bytes.length, dependencies, 1n);
  if (!final.bytes.equals(source.bytes) || !sameIdentity(final.stats, source.stats)) {
    throw new LifecycleRecoveryError();
  }
  return final;
}

async function trackedExistingFile(
  path: string,
  maximumBytes: number,
  dependencies: CodexProjectHookTransactionDependencies,
  expectedLinks = 1n,
): Promise<TrackedFile> {
  const stats = await lstat(path, { bigint: true });
  if (!safeRegular(stats, undefined, expectedLinks) || stats.size > BigInt(maximumBytes)) {
    throw new LifecycleInputError();
  }
  const bytes = await readRegular(path, maximumBytes, expectedLinks, dependencies);
  return { bytes, path, stats };
}

async function readRegular(
  path: string,
  maximumBytes: number,
  expectedLinks: bigint | undefined,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<Buffer> {
  const initial = await lstat(path, { bigint: true });
  if (!safeRegular(initial, undefined, expectedLinks) || initial.size > BigInt(maximumBytes)) {
    throw new LifecycleInputError();
  }
  const handle = await (dependencies.openFile ?? open)(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(initial, opened)) throw new LifecycleInputError();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const final = await lstat(path, { bigint: true });
    if (
      offset > maximumBytes ||
      BigInt(offset) !== initial.size ||
      !sameIdentity(initial, final) ||
      !safeRegular(final, offset, expectedLinks)
    ) {
      throw new LifecycleInputError();
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function verifyTrackedFile(
  tracked: TrackedFile,
  expectedLinks: bigint,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<boolean> {
  try {
    const current = await trackedExistingFile(
      tracked.path,
      tracked.bytes.length,
      dependencies,
      expectedLinks,
    );
    return sameIdentity(current.stats, tracked.stats) && current.bytes.equals(tracked.bytes);
  } catch {
    return false;
  }
}

async function removeTrackedFile(
  tracked: TrackedFile,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<boolean> {
  try {
    const current = await lstat(tracked.path, { bigint: true });
    if (!sameIdentity(current, tracked.stats) || !current.isFile() || current.isSymbolicLink()) {
      return false;
    }
    await (dependencies.unlinkFile ?? unlink)(tracked.path);
    try {
      await lstat(tracked.path, { bigint: true });
      return false;
    } catch (error) {
      return hasCode(error, "ENOENT");
    }
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function cleanupOperation(
  staged: readonly TrackedFile[],
  staging: TrackedDirectory | undefined,
  operationLock: OperationLock | undefined,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<boolean> {
  let confirmed = true;
  for (const file of [...staged].reverse()) {
    confirmed = (await removeTrackedFile(file, dependencies)) && confirmed;
  }
  if (staging) confirmed = (await removeTrackedDirectory(staging, dependencies)) && confirmed;
  if (operationLock) confirmed = (await releaseLock(operationLock, dependencies)) && confirmed;
  return confirmed;
}

async function removeTrackedDirectory(
  tracked: TrackedDirectory,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<boolean> {
  try {
    const current = await lstat(tracked.path, { bigint: true });
    if (
      !sameIdentity(current, tracked.stats) ||
      !current.isDirectory() ||
      current.isSymbolicLink()
    ) {
      return false;
    }
    await (dependencies.removeDirectory ?? rmdir)(tracked.path);
    return true;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function releaseLock(
  lock: OperationLock,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<boolean> {
  let closed = true;
  try {
    await lock.handle.close();
  } catch {
    closed = false;
  }
  return (await removeTrackedFile(lock, dependencies)) && closed;
}

function safeRegular(stats: BigIntStats, expectedBytes?: number, expectedLinks?: bigint): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    (expectedBytes === undefined || stats.size === BigInt(expectedBytes)) &&
    (expectedLinks === undefined || stats.nlink === expectedLinks) &&
    stats.dev >= 0n &&
    stats.ino > 0n
  );
}

function sameIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.dev >= 0n && left.ino > 0n;
}

function identifier(dependencies: CodexProjectHookTransactionDependencies): string {
  return dependencies.createIdentifier?.() ?? createCodexProjectHookIdentifier(randomBytes);
}

async function checkpoint(
  dependencies: CodexProjectHookTransactionDependencies,
  name: TransactionCheckpoint,
): Promise<void> {
  await dependencies.checkpoint?.(name);
}

async function lifecycleRecovery(
  command: "install" | "remove",
  format: OutputFormat,
  cwd: string,
  dependencies: CodexProjectHookTransactionDependencies,
): Promise<CheckResult> {
  try {
    const report = await observe(cwd, {}, dependencies);
    return lifecycleSuccess(command, format, "recovery_required", report, 1);
  } catch {
    return lifecycleFailure(command, format, new LifecycleRecoveryError());
  }
}

function lifecycleSuccess(
  command: "install" | "remove",
  format: OutputFormat,
  outcome: "installed" | "removed" | "recovery_required",
  status: ReturnType<typeof codexProjectHookStatusReportSchema.parse>,
  exitCode: 0 | 1 = 0,
): CheckResult {
  const report = codexProjectHookLifecycleReportSchema.parse({
    schemaVersion: "1.0",
    toolVersion: AGENTHAWK_CLI_VERSION,
    command: `integrations_codex_${command}`,
    outcome,
    ownership: status.ownership,
    readiness: status.readiness,
    blockers: status.blockers,
    providersContacted: false,
  });
  return {
    exitCode,
    output:
      format === "json"
        ? `${JSON.stringify(report)}\n`
        : `${[
            `AgentHawk Codex project hook: ${outcome.toUpperCase()}`,
            `Ownership: ${status.ownership}`,
            `Readiness: ${status.readiness}`,
            `Blockers: ${status.blockers.length === 0 ? "none" : status.blockers.join(", ")}`,
          ]
            .map(escapeTerminal)
            .join("\n")}\n`,
  };
}

function lifecycleFailure(
  command: "install" | "remove",
  format: OutputFormat,
  error: unknown,
): CheckResult {
  const invalid = error instanceof LifecycleInputError || error instanceof RepositoryAuthorityError;
  const recovery = error instanceof LifecycleRecoveryError;
  const exitCode = invalid ? 2 : 4;
  const message = invalid
    ? `Codex project-hook ${command} cannot continue because fixed state is unavailable or unsafe.`
    : recovery
      ? `Codex project-hook ${command} requires bounded recovery review.`
      : `Codex project-hook ${command} failed safely.`;
  return {
    exitCode,
    output:
      format === "json"
        ? `${JSON.stringify(
            cliErrorReportSchema.parse({
              schemaVersion: "1.0",
              error: { code: invalid ? "invalid_input" : "internal_error", message },
              exitCode,
            }),
          )}\n`
        : `AgentHawk: ${escapeTerminal(message)}\n`,
  };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
