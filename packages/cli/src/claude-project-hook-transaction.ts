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
  claudeProjectHookLifecycleReportSchema,
  claudeProjectHookStatusReportSchema,
  cliErrorReportSchema,
  isOperationCancelled,
  type OperationContext,
  throwIfCancelled,
} from "@agenthawk/core";
import type { CheckResult, OutputFormat } from "./check.js";
import {
  buildClaudeProjectHookArtifacts,
  buildClaudeProjectHookLockBytes,
  createClaudeProjectHookIdentifier,
  parseClaudeProjectHookReceiptBytes,
  verifyClaudeProjectHookReceiptBinding,
  verifyClaudeProjectHookSettingsBytes,
} from "./claude-project-hook-format.js";
import {
  type ClaudeProjectHookStatusDependencies,
  statusClaudeProjectHook,
} from "./claude-project-hook-status.js";
import {
  loadRepositoryRootAuthority,
  RepositoryAuthorityError,
  type RepositoryRootAuthority,
} from "./repository-authority.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

const lockName = ".agenthawk-claude-integration.lock";
const maximumAdapterBytes = 1_048_576;
const maximumHookBytes = 65_536;
const maximumReceiptBytes = 8_192;

export interface ClaudeProjectHookLifecycleOptions extends OperationContext {
  readonly format: OutputFormat;
}

export interface ClaudeProjectHookTransactionDependencies
  extends ClaudeProjectHookStatusDependencies {
  readonly beforeRmdir?: (path: string) => Promise<void> | void;
  readonly beforeUnlink?: (path: string) => Promise<void> | void;
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
  readonly parent: TrackedDirectory;
}

class LifecycleInputError extends Error {}
class LifecycleRecoveryError extends Error {}

export async function installClaudeProjectHook(
  options: ClaudeProjectHookLifecycleOptions,
  dependencies: ClaudeProjectHookTransactionDependencies = {},
): Promise<CheckResult> {
  let authority: RepositoryRootAuthority;
  try {
    authority = await (dependencies.loadRootAuthority ?? loadRepositoryRootAuthority)(
      dependencies.cwd ?? process.cwd(),
      options,
    );
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("install", options.format, error);
  }
  const cwd = authority.repositoryRoot;
  let operationId: string;
  let initial: ReturnType<typeof claudeProjectHookStatusReportSchema.parse>;
  try {
    operationId = identifier(dependencies);
    initial = await observe(cwd, options, dependencies, undefined, operationId);
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("install", options.format, error);
  }
  if (initial.ownership !== "absent" || initial.blockers.length > 0) {
    return lifecycleFailure("install", options.format, new LifecycleInputError());
  }

  let operationLock: OperationLock | undefined;
  let rootDirectory: TrackedDirectory | undefined;
  let staging: TrackedDirectory | undefined;
  let stagingCreationPending = false;
  let hookParent: TrackedDirectory | undefined;
  let receiptParent: TrackedDirectory | undefined;
  let directoryChain: readonly TrackedDirectory[] = [];
  const staged: TrackedFile[] = [];
  let receiptPublished: TrackedFile | undefined;
  let hookPublished: TrackedFile | undefined;
  try {
    throwIfCancelled(options);
    rootDirectory = await stableDirectory(cwd);
    if (!sameIdentity(rootDirectory.stats, authority.repositoryIdentity)) {
      throw new LifecycleInputError();
    }
    operationLock = await acquireLock(rootDirectory, operationId, dependencies);
    await checkpoint(dependencies, "lock_created");
    await requireInstallable(cwd, options, dependencies, operationLock, [rootDirectory]);

    hookParent = await ensureDirectory(rootDirectory, ".claude", dependencies);
    const agenthawk = await ensureDirectory(rootDirectory, ".agenthawk", dependencies);
    receiptParent = await ensureDirectory(agenthawk, "integrations", dependencies);
    await checkpoint(dependencies, "parents_ready");
    await requireTrackedDirectory(hookParent);
    await requireTrackedDirectory(receiptParent);
    await requireInstallable(cwd, options, dependencies, operationLock, [
      rootDirectory,
      agenthawk,
      hookParent,
      receiptParent,
    ]);

    const stagingName = `.agenthawk-claude-integration-${operationId}`;
    stagingCreationPending = true;
    staging = await createDirectory(rootDirectory, stagingName, dependencies);
    stagingCreationPending = false;
    await checkpoint(dependencies, "staging_ready");

    const adapterEntry = await realpath(
      dependencies.adapterEntry ??
        fileURLToPath(new URL("./claude-pretooluse-entry.js", import.meta.url)),
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
    await requireTrackedDirectory(rootDirectory);
    const artifacts = buildClaudeProjectHookArtifacts({
      adapterBytes,
      adapterEntry,
      adapterVersion: dependencies.adapterVersion ?? AGENTHAWK_CLI_VERSION,
      installationId: identifier(dependencies),
      nodeExecutable,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      repositoryIdentity: { dev: rootDirectory.stats.dev, ino: rootDirectory.stats.ino },
      repositoryRoot: rootDirectory.path,
    });
    const receiptStage = await createStageFile(
      staging,
      "claude-v1.json",
      artifacts.receiptBytes,
      dependencies,
    );
    staged.push(receiptStage);
    const hookStage = await createStageFile(
      staging,
      "settings.local.json",
      artifacts.settingsBytes,
      dependencies,
    );
    staged.push(hookStage);
    await checkpoint(dependencies, "staged_files_ready");
    await verifyNoReplaceCapability(staging, receiptStage, hookStage, dependencies);
    await checkpoint(dependencies, "capability_verified");
    await requireTrackedDirectory(staging);
    await requireTrackedDirectory(hookParent);
    await requireTrackedDirectory(receiptParent);
    directoryChain = [rootDirectory, agenthawk, hookParent, receiptParent, staging] as const;
    await requireInstallable(cwd, options, dependencies, operationLock, directoryChain);

    throwIfCancelled(options);
    await checkpoint(dependencies, "before_receipt_publish");
    throwIfCancelled(options);
    await requireInstallable(cwd, options, dependencies, operationLock, directoryChain);
    receiptPublished = await publish(
      receiptStage,
      staging,
      receiptParent,
      "claude-v1.json",
      operationLock,
      directoryChain,
      dependencies,
      (file) => {
        receiptPublished = file;
      },
    );
    staged.splice(staged.indexOf(receiptStage), 1);
    await checkpoint(dependencies, "receipt_published");
    throwIfCancelled(options);

    await checkpoint(dependencies, "before_hook_publish");
    throwIfCancelled(options);
    await requireOperationLock(operationLock, dependencies);
    const inactive = await observe(cwd, options, dependencies, operationId);
    await requireOperationLock(operationLock, dependencies);
    if (
      inactive.ownership !== "owned_inactive" ||
      inactive.blockers.length > 0 ||
      !(await verifyTrackedFile(receiptPublished, 1n, dependencies))
    )
      throw new LifecycleRecoveryError();
    hookPublished = await publish(
      hookStage,
      staging,
      hookParent,
      "settings.local.json",
      operationLock,
      directoryChain,
      dependencies,
      (file) => {
        hookPublished = file;
      },
    );
    staged.splice(staged.indexOf(hookStage), 1);
    await checkpoint(dependencies, "hook_published");

    await requireOperationLock(operationLock, dependencies);
    const committed = await observe(cwd, {}, dependencies, operationId);
    await requireOperationLock(operationLock, dependencies);
    if (
      committed.ownership !== "owned_exact" ||
      committed.readiness !== "current" ||
      committed.blockers.length > 0
    )
      throw new LifecycleRecoveryError();

    await checkpoint(dependencies, "before_cleanup");
    const cleaned = await cleanupOperation(
      staged,
      staging,
      rootDirectory,
      operationLock,
      dependencies,
    );
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
    // A failed mkdir can have succeeded before reporting failure. Without a
    // validated directory identity, retain the lock for discoverable recovery.
    if (stagingCreationPending) {
      await operationLock?.handle.close().catch(() => undefined);
      return lifecycleRecovery("install", options.format, cwd, dependencies);
    }
    let receiptRollback = !receiptPublished || Boolean(hookPublished);
    if (receiptPublished && !hookPublished && operationLock) {
      try {
        await requireOperationLock(operationLock, dependencies);
        const beforeRollback = await observe(cwd, {}, dependencies, operationId);
        await requireOperationLock(operationLock, dependencies);
        if (beforeRollback.localSettings === "absent" && mutationIgnored(beforeRollback)) {
          receiptRollback = await removeTrackedFile(receiptPublished, dependencies, directoryChain);
          if (receiptRollback) {
            const rolledBack = await observe(cwd, {}, dependencies, operationId);
            await requireOperationLock(operationLock, dependencies);
            receiptRollback = rolledBack.ownership === "absent";
          }
        }
      } catch {
        receiptRollback = false;
      }
    }
    const cleaned = await cleanupOperation(
      staged,
      staging,
      rootDirectory,
      operationLock,
      dependencies,
    );
    if (hookPublished || !receiptRollback || !cleaned || error instanceof LifecycleRecoveryError) {
      return lifecycleRecovery("install", options.format, cwd, dependencies);
    }
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("install", options.format, error);
  }
}

export async function removeClaudeProjectHook(
  options: ClaudeProjectHookLifecycleOptions,
  dependencies: ClaudeProjectHookTransactionDependencies = {},
): Promise<CheckResult> {
  let authority: RepositoryRootAuthority;
  try {
    authority = await (dependencies.loadRootAuthority ?? loadRepositoryRootAuthority)(
      dependencies.cwd ?? process.cwd(),
      options,
    );
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("remove", options.format, error);
  }
  const cwd = authority.repositoryRoot;
  let operationId: string;
  let initial: ReturnType<typeof claudeProjectHookStatusReportSchema.parse>;
  try {
    operationId = identifier(dependencies);
    initial = await observe(cwd, options, dependencies, undefined, operationId);
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return lifecycleFailure("remove", options.format, error);
  }
  if (
    !["owned_exact", "owned_inactive"].includes(initial.ownership) ||
    initial.blockers.includes("operation_locked") ||
    !mutationIgnored(initial)
  ) {
    return lifecycleFailure("remove", options.format, new LifecycleInputError());
  }

  let operationLock: OperationLock | undefined;
  let committed = false;
  try {
    throwIfCancelled(options);
    const root = await stableDirectory(cwd);
    if (!sameIdentity(root.stats, authority.repositoryIdentity)) {
      throw new LifecycleInputError();
    }
    operationLock = await acquireLock(root, operationId, dependencies);
    await checkpoint(dependencies, "lock_created");
    await requireOperationLock(operationLock, dependencies);
    const underLock = await observe(cwd, options, dependencies, operationId);
    await requireOperationLock(operationLock, dependencies);
    if (
      !["owned_exact", "owned_inactive"].includes(underLock.ownership) ||
      !mutationIgnored(underLock)
    ) {
      throw new LifecycleInputError();
    }
    const agenthawk = await stableDirectory(join(root.path, ".agenthawk"));
    const receiptPath = join(cwd, ".agenthawk", "integrations", "claude-v1.json");
    const receiptParent = await stableDirectory(join(agenthawk.path, "integrations"));
    const receiptChain = [root, agenthawk, receiptParent] as const;
    await requireTrackedDirectories(receiptChain);
    await requireOperationLock(operationLock, dependencies);
    const receipt = await trackedExistingFile(receiptPath, maximumReceiptBytes, dependencies);
    const parsedReceipt = parseClaudeProjectHookReceiptBytes(receipt.bytes);
    if (
      !parsedReceipt ||
      !verifyClaudeProjectHookReceiptBinding(parsedReceipt, root.path, {
        dev: root.stats.dev,
        ino: root.stats.ino,
      })
    ) {
      throw new LifecycleInputError();
    }

    if (underLock.ownership === "owned_exact") {
      throwIfCancelled(options);
      const hookParent = await stableDirectory(join(root.path, ".claude"));
      const hookChain = [...receiptChain, hookParent] as const;
      await requireTrackedDirectories(hookChain);
      const hookPath = join(cwd, ".claude", "settings.local.json");
      const hook = await trackedExistingFile(hookPath, maximumHookBytes, dependencies);
      if (!verifyClaudeProjectHookSettingsBytes(parsedReceipt, hook.bytes))
        throw new LifecycleInputError();
      await checkpoint(dependencies, "before_hook_remove");
      throwIfCancelled(options);
      await requireOperationLock(operationLock, dependencies);
      const beforeRemove = await observe(cwd, options, dependencies, operationId);
      await requireOperationLock(operationLock, dependencies);
      if (
        beforeRemove.ownership !== "owned_exact" ||
        !mutationIgnored(beforeRemove) ||
        !(await verifyTrackedFile(receipt, 1n, dependencies))
      )
        throw new LifecycleRecoveryError();
      if (!(await removeTrackedFile(hook, dependencies, hookChain))) {
        throw new LifecycleRecoveryError();
      }
      await requireOperationLock(operationLock, dependencies);
      committed = true;
      await checkpoint(dependencies, "hook_removed");
    }

    const settledOptions = committed ? {} : options;
    const inactive = await observe(cwd, settledOptions, dependencies, operationId);
    await requireTrackedDirectories(receiptChain);
    await requireOperationLock(operationLock, dependencies);
    if (inactive.ownership !== "owned_inactive" || !mutationIgnored(inactive))
      throw new LifecycleRecoveryError();
    if (!(await verifyTrackedFile(receipt, 1n, dependencies))) {
      throw new LifecycleRecoveryError();
    }
    if (!committed) throwIfCancelled(options);
    await checkpoint(dependencies, "before_receipt_remove");
    if (!committed) throwIfCancelled(options);
    await requireOperationLock(operationLock, dependencies);
    const beforeReceiptRemove = await observe(cwd, settledOptions, dependencies, operationId);
    await requireOperationLock(operationLock, dependencies);
    if (
      beforeReceiptRemove.ownership !== "owned_inactive" ||
      !mutationIgnored(beforeReceiptRemove)
    ) {
      throw new LifecycleRecoveryError();
    }
    if (!(await removeTrackedFile(receipt, dependencies, receiptChain)))
      throw new LifecycleRecoveryError();
    await requireOperationLock(operationLock, dependencies);
    committed = true;
    await checkpoint(dependencies, "receipt_removed");
    const absent = await observe(cwd, {}, dependencies, operationId);
    await requireTrackedDirectories(receiptChain);
    await requireOperationLock(operationLock, dependencies);
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
  dependencies: ClaudeProjectHookTransactionDependencies,
  ownedOperationId?: string,
  candidateOperationId?: string,
) {
  const result = await statusClaudeProjectHook(
    { format: "json", signal: options.signal, ownedOperationId, candidateOperationId },
    { ...dependencies, cwd },
  );
  if (result.exitCode === 4) throw new Error("Status observation failed.");
  return claudeProjectHookStatusReportSchema.parse(JSON.parse(result.output));
}

function mutationIgnored(
  report: ReturnType<typeof claudeProjectHookStatusReportSchema.parse>,
): boolean {
  return (
    report.localSettingsIgnored === "ignored" &&
    report.integrationArtifactsIgnored === "ignored" &&
    !report.blockers.includes("operation_locked")
  );
}

async function requireInstallable(
  cwd: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookTransactionDependencies,
  operationLock: OperationLock,
  directories: readonly TrackedDirectory[] = [],
): Promise<void> {
  await requireTrackedDirectories(directories);
  await requireOperationLock(operationLock, dependencies);
  const report = await observe(cwd, options, dependencies, operationLock.operationId);
  await requireOperationLock(operationLock, dependencies);
  await requireTrackedDirectories(directories);
  if (report.ownership !== "absent" || report.blockers.length > 0) {
    throw new LifecycleInputError();
  }
}

async function requireOperationLock(
  lock: OperationLock,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<void> {
  await requireTrackedDirectory(lock.parent);
  const opened = await lock.handle.stat({ bigint: true });
  const named = await trackedExistingFile(lock.path, lock.bytes.length, dependencies, 1n);
  await requireTrackedDirectory(lock.parent);
  if (
    !sameIdentity(opened, lock.stats) ||
    !sameIdentity(named.stats, lock.stats) ||
    !named.bytes.equals(lock.bytes)
  ) {
    throw new LifecycleRecoveryError();
  }
}

async function acquireLock(
  root: TrackedDirectory,
  operationId: string,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<OperationLock> {
  await requireTrackedDirectory(root);
  const path = join(root.path, lockName);
  const bytes = buildClaudeProjectHookLockBytes(operationId);
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
    await requireTrackedDirectory(root);
    return { bytes, handle, operationId, parent: root, path, stats };
  } catch (error) {
    const closed = await handle
      .close()
      .then(() => true)
      .catch(() => false);
    const removed = createdStats
      ? await removeTrackedFile(
          { bytes: Buffer.alloc(0), path, stats: createdStats },
          dependencies,
          [root],
        )
      : false;
    if (!closed || !removed) throw new LifecycleRecoveryError();
    throw error;
  }
}

async function ensureDirectory(
  parent: TrackedDirectory,
  name: string,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<TrackedDirectory> {
  await requireTrackedDirectory(parent);
  const path = join(parent.path, name);
  try {
    await (dependencies.makeDirectory ?? mkdir)(path, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const created = await stableDirectory(path);
  await requireTrackedDirectory(parent);
  if (created.stats.dev !== parent.stats.dev) throw new LifecycleInputError();
  return created;
}

async function createDirectory(
  parent: TrackedDirectory,
  name: string,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<TrackedDirectory> {
  await requireTrackedDirectory(parent);
  const path = join(parent.path, name);
  await (dependencies.makeDirectory ?? mkdir)(path, { mode: 0o700 });
  const created = await stableDirectory(path);
  await requireTrackedDirectory(parent);
  if (created.stats.dev !== parent.stats.dev) throw new LifecycleInputError();
  return created;
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

async function requireTrackedDirectory(tracked: TrackedDirectory): Promise<void> {
  const current = await stableDirectory(tracked.path);
  if (!sameIdentity(current.stats, tracked.stats)) throw new LifecycleRecoveryError();
}

async function requireTrackedDirectories(directories: readonly TrackedDirectory[]): Promise<void> {
  for (const directory of directories) await requireTrackedDirectory(directory);
}

async function createStageFile(
  parent: TrackedDirectory,
  name: string,
  bytes: Buffer,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<TrackedFile> {
  await requireTrackedDirectory(parent);
  const path = join(parent.path, name);
  const handle = await (dependencies.openFile ?? open)(path, "wx+", 0o600);
  let stats: BigIntStats;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    stats = await handle.stat({ bigint: true });
    if (!safeRegular(stats, bytes.length, 1n) || stats.dev !== parent.stats.dev) {
      throw new Error("Stage file is unsafe.");
    }
  } finally {
    await handle.close();
  }
  const tracked = { bytes, path, stats };
  await requireTrackedDirectory(parent);
  if (!(await verifyTrackedFile(tracked, 1n, dependencies))) throw new Error("Stage changed.");
  return tracked;
}

async function verifyNoReplaceCapability(
  staging: TrackedDirectory,
  first: TrackedFile,
  second: TrackedFile,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<void> {
  await requireTrackedDirectory(staging);
  const probePath = join(staging.path, ".no-replace-probe");
  const linkFile = dependencies.linkFile ?? link;
  const attempts = await Promise.allSettled([
    linkFile(first.path, probePath),
    linkFile(second.path, probePath),
  ]);
  await requireTrackedDirectory(staging);
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
  if (!(await removeTrackedFile(probe, dependencies, [staging], 2n)))
    throw new LifecycleInputError();
  if (!(await verifyTrackedFile(winner, 1n, dependencies))) throw new LifecycleInputError();
  const occupiedPath = join(staging.path, ".occupied-probe");
  const occupied = await createStageFile(
    staging,
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
  if (!(await removeTrackedFile(occupied, dependencies, [staging])))
    throw new LifecycleInputError();
  if (!(await verifyTrackedFile(first, 1n, dependencies))) throw new LifecycleInputError();
  if (!(await verifyTrackedFile(second, 1n, dependencies))) throw new LifecycleInputError();
  await requireTrackedDirectory(staging);
}

async function publish(
  source: TrackedFile,
  sourceParent: TrackedDirectory,
  parent: TrackedDirectory,
  name: string,
  operationLock: OperationLock,
  directoryChain: readonly TrackedDirectory[],
  dependencies: ClaudeProjectHookTransactionDependencies,
  onPublished: (file: TrackedFile) => void,
): Promise<TrackedFile> {
  await requireTrackedDirectories(directoryChain);
  await requireOperationLock(operationLock, dependencies);
  await requireTrackedDirectories(directoryChain);
  await requireTrackedDirectory(sourceParent);
  await requireTrackedDirectory(parent);
  if (source.stats.dev !== parent.stats.dev) throw new LifecycleInputError();
  const destination = join(parent.path, name);
  if (!(await verifyTrackedFile(source, 1n, dependencies))) throw new LifecycleRecoveryError();
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
  onPublished({ ...source, path: destination });
  await requireOperationLock(operationLock, dependencies);
  await requireTrackedDirectories(directoryChain);
  await requireTrackedDirectory(sourceParent);
  await requireTrackedDirectory(parent);
  const published = await trackedExistingFile(destination, source.bytes.length, dependencies, 2n);
  if (!published.bytes.equals(source.bytes) || !sameIdentity(published.stats, source.stats)) {
    throw new LifecycleRecoveryError();
  }
  if (!(await removeTrackedFile(source, dependencies, directoryChain, 2n))) {
    throw new LifecycleRecoveryError();
  }
  const final = await trackedExistingFile(destination, source.bytes.length, dependencies, 1n);
  if (!final.bytes.equals(source.bytes) || !sameIdentity(final.stats, source.stats)) {
    throw new LifecycleRecoveryError();
  }
  await requireOperationLock(operationLock, dependencies);
  await requireTrackedDirectory(parent);
  return final;
}

async function trackedExistingFile(
  path: string,
  maximumBytes: number,
  dependencies: ClaudeProjectHookTransactionDependencies,
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
  dependencies: ClaudeProjectHookTransactionDependencies,
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
    if (!sameFileSnapshot(initial, opened)) throw new LifecycleInputError();
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const final = await lstat(path, { bigint: true });
    const settled = await handle.stat({ bigint: true });
    if (
      offset > maximumBytes ||
      BigInt(offset) !== initial.size ||
      !sameFileSnapshot(initial, final) ||
      !sameFileSnapshot(initial, settled) ||
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
  dependencies: ClaudeProjectHookTransactionDependencies,
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
  dependencies: ClaudeProjectHookTransactionDependencies,
  directories: readonly TrackedDirectory[] = [],
  expectedLinks = 1n,
): Promise<boolean> {
  let current: BigIntStats;
  try {
    await requireTrackedDirectories(directories);
  } catch {
    return false;
  }
  try {
    current = await lstat(tracked.path, { bigint: true });
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
  if (!sameIdentity(current, tracked.stats) || !current.isFile() || current.isSymbolicLink()) {
    return false;
  }
  let immediate: BigIntStats;
  try {
    await dependencies.beforeUnlink?.(tracked.path);
    await requireTrackedDirectories(directories);
    immediate = await lstat(tracked.path, { bigint: true });
  } catch {
    return false;
  }
  if (
    !sameIdentity(immediate, tracked.stats) ||
    !immediate.isFile() ||
    immediate.isSymbolicLink() ||
    immediate.nlink !== expectedLinks ||
    !(await verifyTrackedFile(tracked, expectedLinks, dependencies))
  ) {
    return false;
  }
  try {
    await (dependencies.unlinkFile ?? unlink)(tracked.path);
  } catch {
    return false;
  }
  try {
    await requireTrackedDirectories(directories);
  } catch {
    return false;
  }
  try {
    await lstat(tracked.path, { bigint: true });
    return false;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function cleanupOperation(
  staged: readonly TrackedFile[],
  staging: TrackedDirectory | undefined,
  stagingParent: TrackedDirectory | undefined,
  operationLock: OperationLock | undefined,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<boolean> {
  let confirmed = true;
  for (const file of [...staged].reverse()) {
    const directories =
      stagingParent && staging ? [stagingParent, staging] : staging ? [staging] : [];
    confirmed = (await removeTrackedFile(file, dependencies, directories)) && confirmed;
  }
  if (staging) {
    const ancestors = stagingParent ? [stagingParent] : [];
    confirmed = (await removeTrackedDirectory(staging, ancestors, dependencies)) && confirmed;
  }
  if (operationLock) {
    if (confirmed) confirmed = await releaseLock(operationLock, dependencies);
    else await operationLock.handle.close().catch(() => undefined);
  }
  return confirmed;
}

async function removeTrackedDirectory(
  tracked: TrackedDirectory,
  ancestors: readonly TrackedDirectory[],
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<boolean> {
  let current: BigIntStats;
  try {
    await requireTrackedDirectories([...ancestors, tracked]);
    current = await lstat(tracked.path, { bigint: true });
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
  if (!sameIdentity(current, tracked.stats) || !current.isDirectory() || current.isSymbolicLink()) {
    return false;
  }
  let immediate: BigIntStats;
  try {
    await dependencies.beforeRmdir?.(tracked.path);
    await requireTrackedDirectories([...ancestors, tracked]);
    immediate = await lstat(tracked.path, { bigint: true });
  } catch {
    return false;
  }
  if (
    !sameIdentity(immediate, tracked.stats) ||
    !immediate.isDirectory() ||
    immediate.isSymbolicLink()
  ) {
    return false;
  }
  try {
    await (dependencies.removeDirectory ?? rmdir)(tracked.path);
  } catch {
    return false;
  }
  try {
    await requireTrackedDirectories(ancestors);
  } catch {
    return false;
  }
  try {
    await lstat(tracked.path, { bigint: true });
    return false;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}

async function releaseLock(
  lock: OperationLock,
  dependencies: ClaudeProjectHookTransactionDependencies,
): Promise<boolean> {
  let verified = true;
  try {
    await requireOperationLock(lock, dependencies);
  } catch {
    verified = false;
  }
  let closed = true;
  try {
    await lock.handle.close();
  } catch {
    closed = false;
  }
  return verified && (await removeTrackedFile(lock, dependencies, [lock.parent])) && closed;
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

function identifier(dependencies: ClaudeProjectHookTransactionDependencies): string {
  const value = dependencies.createIdentifier?.() ?? createClaudeProjectHookIdentifier(randomBytes);
  buildClaudeProjectHookLockBytes(value);
  return value;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

async function checkpoint(
  dependencies: ClaudeProjectHookTransactionDependencies,
  name: TransactionCheckpoint,
): Promise<void> {
  await dependencies.checkpoint?.(name);
}

async function lifecycleRecovery(
  command: "install" | "remove",
  format: OutputFormat,
  cwd: string,
  dependencies: ClaudeProjectHookTransactionDependencies,
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
  status: ReturnType<typeof claudeProjectHookStatusReportSchema.parse>,
  exitCode: 0 | 1 = 0,
): CheckResult {
  const report = claudeProjectHookLifecycleReportSchema.parse({
    schemaVersion: "1.0",
    toolVersion: AGENTHAWK_CLI_VERSION,
    command: `integrations_claude_${command}`,
    outcome,
    ownership: status.ownership,
    readiness: status.readiness,
    blockers: status.blockers,
    providersContacted: false,
    activation: "unproven",
  });
  return {
    exitCode,
    output:
      format === "json"
        ? `${JSON.stringify(report)}\n`
        : `${[
            `AgentHawk Claude project hook: ${outcome.toUpperCase()}`,
            `Ownership: ${status.ownership}`,
            `Readiness: ${status.readiness}`,
            `Blockers: ${status.blockers.length === 0 ? "none" : status.blockers.join(", ")}`,
            "Activation: unproven. This does not prove Claude loaded or executed the hook.",
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
    ? `Claude project-hook ${command} cannot continue because fixed state is unavailable or unsafe.`
    : recovery
      ? `Claude project-hook ${command} requires bounded recovery review.`
      : `Claude project-hook ${command} failed safely.`;
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
