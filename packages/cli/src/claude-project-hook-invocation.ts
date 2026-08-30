import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isOperationCancelled, type OperationContext, throwIfCancelled } from "@agenthawk/core";
import {
  buildClaudeProjectHookArtifacts,
  type ClaudeProjectHookLaunchContext,
  parseClaudeProjectHookReceiptBytes,
  verifyClaudeProjectHookReceiptBinding,
  verifyClaudeProjectHookSettingsBytes,
} from "./claude-project-hook-format.js";
import type { RepositoryAuthority } from "./repository-authority.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

const maximumDirectoryEntries = 4_096;
const maximumSettingsBytes = 65_536;
const maximumReceiptBytes = 8_192;
const maximumAdapterBytes = 1_048_576;

export interface ClaudeProjectHookInvocationDependencies {
  readonly adapterEntry?: string;
  readonly adapterVersion?: string;
  readonly inspectPath?: (path: string) => Promise<BigIntStats>;
  readonly nodeExecutable?: string;
  readonly nodeVersion?: string;
  readonly openFile?: typeof open;
  readonly realPath?: (path: string) => Promise<string>;
}

interface FixedFileObservation {
  readonly bytes?: Buffer;
  readonly signature: string;
  readonly state: "absent" | "present";
}

interface InvocationSnapshot {
  readonly lock: FixedFileObservation;
  readonly receipt: FixedFileObservation;
  readonly rootSignature: string;
  readonly settings: FixedFileObservation;
}

export async function verifyClaudeProjectHookInvocation(
  authority: RepositoryAuthority,
  context: ClaudeProjectHookLaunchContext,
  options: OperationContext = {},
  dependencies: ClaudeProjectHookInvocationDependencies = {},
): Promise<boolean> {
  if (context.deploymentTrust !== "project") return false;
  try {
    const first = await observeSnapshot(authority, options, dependencies);
    throwIfCancelled(options);
    const second = await observeSnapshot(authority, options, dependencies);
    if (snapshotSignature(first) !== snapshotSignature(second) || second.lock.state !== "absent") {
      return false;
    }
    if (!second.receipt.bytes || !second.settings.bytes) return false;
    const receipt = parseClaudeProjectHookReceiptBytes(second.receipt.bytes);
    if (
      !receipt ||
      receipt.installationId !== context.installationId ||
      receipt.rootBinding !== context.rootBinding ||
      !verifyClaudeProjectHookReceiptBinding(
        receipt,
        authority.repositoryRoot,
        authority.repositoryIdentity,
      )
    ) {
      return false;
    }
    const declared = verifyClaudeProjectHookSettingsBytes(receipt, second.settings.bytes);
    if (!declared) return false;
    throwIfCancelled(options);
    const resolveRealPath = dependencies.realPath ?? realpath;
    const nodeExecutable = await resolveRealPath(dependencies.nodeExecutable ?? process.execPath);
    throwIfCancelled(options);
    const adapterEntry = await resolveRealPath(
      dependencies.adapterEntry ??
        fileURLToPath(new URL("./claude-pretooluse-entry.js", import.meta.url)),
    );
    if (declared.nodeExecutable !== nodeExecutable || declared.adapterEntry !== adapterEntry) {
      return false;
    }
    const adapterBytes = await readAbsoluteRegularFile(
      adapterEntry,
      maximumAdapterBytes,
      options,
      dependencies,
    );
    const current = buildClaudeProjectHookArtifacts({
      adapterBytes,
      adapterEntry,
      adapterVersion: dependencies.adapterVersion ?? AGENTHAWK_CLI_VERSION,
      installationId: receipt.installationId,
      nodeExecutable,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      repositoryIdentity: authority.repositoryIdentity,
      repositoryRoot: authority.repositoryRoot,
    });
    return (
      current.receiptBytes.equals(second.receipt.bytes) &&
      current.settingsBytes.equals(second.settings.bytes)
    );
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return false;
  }
}

async function observeSnapshot(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
): Promise<InvocationSnapshot> {
  const rootSignature = await assertRootIdentity(authority, options, dependencies);
  const settings = await observeFixedFile(
    authority.repositoryRoot,
    [".claude", "settings.local.json"],
    maximumSettingsBytes,
    options,
    dependencies,
  );
  const receipt = await observeFixedFile(
    authority.repositoryRoot,
    [".agenthawk", "integrations", "claude-v1.json"],
    maximumReceiptBytes,
    options,
    dependencies,
  );
  const lock = await observeFixedFile(
    authority.repositoryRoot,
    [".agenthawk-claude-integration.lock"],
    1_024,
    options,
    dependencies,
  );
  const finalRootSignature = await assertRootIdentity(authority, options, dependencies);
  if (rootSignature !== finalRootSignature) {
    throw new Error("Claude project-hook repository root changed.");
  }
  return { lock, receipt, rootSignature, settings };
}

async function observeFixedFile(
  root: string,
  segments: readonly string[],
  maximumBytes: number,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
): Promise<FixedFileObservation> {
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const child = join(parent, segment);
    const entry = await exactEntry(parent, segment, options);
    if (!entry) return { signature: "absent", state: "absent" };
    await assertStableDirectory(child, root, options, dependencies);
    parent = child;
  }
  const name = segments.at(-1);
  if (!name || !(await exactEntry(parent, name, options))) {
    return { signature: "absent", state: "absent" };
  }
  const target = join(parent, name);
  const bytes = await readRegularFile(target, maximumBytes, options, dependencies);
  return {
    bytes,
    signature: `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`,
    state: "present",
  };
}

async function exactEntry(
  parent: string,
  expected: string,
  options: OperationContext,
): Promise<boolean> {
  throwIfCancelled(options);
  let directory: Dir;
  try {
    directory = await opendir(parent);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  let count = 0;
  let exact = 0;
  let compatible = 0;
  try {
    for await (const entry of directory) {
      throwIfCancelled(options);
      count += 1;
      if (count > maximumDirectoryEntries)
        throw new Error("Claude project-hook directory is too large.");
      if (entry.name === expected) exact += 1;
      if (entryKey(entry.name) === entryKey(expected)) compatible += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (exact > 1 || compatible > exact) throw new Error("Claude project-hook path is ambiguous.");
  return exact === 1;
}

async function assertStableDirectory(
  path: string,
  root: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
): Promise<void> {
  assertContained(root, path);
  const inspectPath = dependencies.inspectPath ?? inspectBigInt;
  const resolveRealPath = dependencies.realPath ?? realpath;
  throwIfCancelled(options);
  const before = await inspectPath(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Unsafe directory.");
  const canonical = await resolveRealPath(path);
  if (canonical !== resolve(path)) throw new Error("Redirected directory.");
  const after = await inspectPath(path);
  if (!sameIdentity(before, after)) throw new Error("Directory changed.");
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
  requireSingleLink = true,
): Promise<Buffer> {
  const inspectPath = dependencies.inspectPath ?? inspectBigInt;
  const openFile = dependencies.openFile ?? open;
  throwIfCancelled(options);
  const before = await inspectPath(path);
  assertRegular(before, maximumBytes, requireSingleLink);
  const handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegular(opened, maximumBytes, requireSingleLink);
    if (!sameIdentity(before, opened))
      throw new Error("Claude project-hook file changed before open.");
    const bytes = await readBoundedHandle(handle, maximumBytes, options);
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await inspectPath(path);
    if (
      !sameIdentity(opened, afterHandle) ||
      !sameIdentity(afterHandle, afterPath) ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      throw new Error("Claude project-hook file changed during read.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readAbsoluteRegularFile(
  path: string,
  maximumBytes: number,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
): Promise<Buffer> {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    basename(path) === "" ||
    dirname(path) === path
  ) {
    throw new Error("Claude project-hook adapter path is invalid.");
  }
  const resolveRealPath = dependencies.realPath ?? realpath;
  if ((await resolveRealPath(path)) !== path)
    throw new Error("Claude project-hook adapter path drifted.");
  return await readRegularFile(path, maximumBytes, options, dependencies, false);
}

async function readBoundedHandle(
  handle: FileHandle,
  maximumBytes: number,
  options: OperationContext,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    throwIfCancelled(options);
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) throw new Error("Claude project-hook file is too large.");
    const chunk = Buffer.alloc(Math.min(16_384, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

async function assertRootIdentity(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: ClaudeProjectHookInvocationDependencies,
): Promise<string> {
  const inspectPath = dependencies.inspectPath ?? inspectBigInt;
  const resolveRealPath = dependencies.realPath ?? realpath;
  throwIfCancelled(options);
  if ((await resolveRealPath(authority.repositoryRoot)) !== authority.repositoryRoot) {
    throw new Error("Claude project-hook root is not canonical.");
  }
  const stats = await inspectPath(authority.repositoryRoot);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.dev !== authority.repositoryIdentity.dev ||
    stats.ino !== authority.repositoryIdentity.ino
  ) {
    throw new Error("Claude project-hook root identity changed.");
  }
  return `${stats.dev}:${stats.ino}:${stats.mode}`;
}

function assertRegular(stats: BigIntStats, maximumBytes: number, requireSingleLink: boolean): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    (requireSingleLink && stats.nlink !== 1n) ||
    stats.size < 0n ||
    stats.size > BigInt(maximumBytes)
  ) {
    throw new Error("Unsafe Claude project-hook file.");
  }
}

function assertContained(root: string, path: string): void {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Claude project-hook path escaped the repository.");
  }
}

function snapshotSignature(snapshot: InvocationSnapshot): string {
  return [
    snapshot.rootSignature,
    snapshot.settings.signature,
    snapshot.receipt.signature,
    snapshot.lock.signature,
  ].join("|");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function entryKey(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function inspectBigInt(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
