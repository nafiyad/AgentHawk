import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CodexProjectHookBlocker,
  type CodexProjectHookOwnership,
  type CodexProjectHookReadiness,
  cliErrorReportSchema,
  codexProjectHookStatusReportSchema,
  isOperationCancelled,
  type OperationContext,
  throwIfCancelled,
} from "@agenthawk/core";
import type { CheckResult, OutputFormat } from "./check.js";
import {
  buildCodexProjectHookArtifacts,
  type CodexProjectHookReceipt,
  codexProjectHookLockSchema,
  parseCodexProjectHookReceiptBytes,
  verifyCodexProjectHookBytes,
  verifyCodexProjectHookReceiptBinding,
} from "./codex-project-hook-format.js";
import { runBoundedGit } from "./diff.js";
import { parseStrictJson } from "./hook-json.js";
import {
  loadRepositoryAuthority,
  type RepositoryAuthority,
  RepositoryAuthorityError,
} from "./repository-authority.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

const maximumDirectoryEntries = 4_096;
const maximumHookBytes = 65_536;
const maximumReceiptBytes = 8_192;
const maximumLockBytes = 1_024;
const maximumConfigBytes = 262_144;
const maximumAdapterBytes = 1_048_576;
const topologyArguments = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir",
] as const;

export interface CodexProjectHookStatusOptions extends OperationContext {
  readonly format: OutputFormat;
}

export interface CodexProjectHookStatusDependencies {
  readonly adapterEntry?: string;
  readonly adapterVersion?: string;
  readonly cwd?: string;
  readonly inspectPath?: (path: string) => Promise<BigIntStats>;
  readonly loadAuthority?: typeof loadRepositoryAuthority;
  readonly nodeExecutable?: string;
  readonly nodeVersion?: string;
  readonly openFile?: typeof open;
  readonly readDirectory?: (path: string) => Promise<string[]>;
  readonly realPath?: typeof realpath;
  readonly runTopologyGit?: typeof runBoundedGit;
}

interface FixedFileObservation {
  readonly state: "absent" | "present" | "oversize";
  readonly bytes?: Buffer;
  readonly signature: string;
}

interface Snapshot {
  readonly hook: FixedFileObservation;
  readonly receipt: FixedFileObservation;
  readonly config: FixedFileObservation;
  readonly lock: FixedFileObservation;
  readonly linkedWorktree: boolean;
  readonly rootSignature: string;
  readonly topologySignature: string;
}

export async function statusCodexProjectHook(
  options: CodexProjectHookStatusOptions,
  dependencies: CodexProjectHookStatusDependencies = {},
): Promise<CheckResult> {
  try {
    const authority = await (dependencies.loadAuthority ?? loadRepositoryAuthority)(
      dependencies.cwd ?? process.cwd(),
      { signal: options.signal },
    );
    let result: ReturnType<typeof classifySnapshot>;
    try {
      const snapshot = await observeStableSnapshot(authority, options, dependencies);
      result = classifySnapshot(authority, snapshot, dependencies, options);
    } catch (error) {
      if (isOperationCancelled(error)) throw error;
      result = {
        ownership: "unsafe",
        blockers: [],
        readiness: Promise.resolve("not_applicable"),
      };
    }
    const report = codexProjectHookStatusReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: AGENTHAWK_CLI_VERSION,
      command: "integrations_codex_status",
      ownership: result.ownership,
      readiness: await result.readiness,
      blockers: result.blockers,
      remediation: remediation(result.ownership),
      providersContacted: false,
    });
    throwIfCancelled(options);
    const healthy =
      report.blockers.length === 0 &&
      (report.ownership === "absent" ||
        (report.ownership === "owned_exact" && report.readiness === "current"));
    return {
      exitCode: healthy ? 0 : 1,
      output: options.format === "json" ? `${JSON.stringify(report)}\n` : renderStatus(report),
    };
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    if (error instanceof RepositoryAuthorityError) return unsafeResult(options.format);
    const message = "Codex project-hook status could not be observed safely.";
    return {
      exitCode: 4,
      output:
        options.format === "json"
          ? `${JSON.stringify(
              cliErrorReportSchema.parse({
                schemaVersion: "1.0",
                error: { code: "internal_error", message },
                exitCode: 4,
              }),
            )}\n`
          : `AgentHawk: ${escapeTerminal(message)}\n`,
    };
  }
}

function unsafeResult(format: OutputFormat): CheckResult {
  const report = codexProjectHookStatusReportSchema.parse({
    schemaVersion: "1.0",
    toolVersion: AGENTHAWK_CLI_VERSION,
    command: "integrations_codex_status",
    ownership: "unsafe",
    readiness: "not_applicable",
    blockers: [],
    remediation: "resolve_unsafe_state",
    providersContacted: false,
  });
  return {
    exitCode: 1,
    output: format === "json" ? `${JSON.stringify(report)}\n` : renderStatus(report),
  };
}

async function observeStableSnapshot(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<Snapshot> {
  const first = await observeSnapshot(authority, options, dependencies);
  throwIfCancelled(options);
  const second = await observeSnapshot(authority, options, dependencies);
  if (snapshotSignature(first) !== snapshotSignature(second)) {
    throw new Error("Codex project-hook state changed during observation.");
  }
  return second;
}

async function observeSnapshot(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<Snapshot> {
  const rootSignature = await assertRootIdentity(authority, options, dependencies);
  const topology = await detectLinkedWorktree(authority, options, dependencies);
  const hook = await observeFixedFile(
    authority.repositoryRoot,
    [".codex", "hooks.json"],
    maximumHookBytes,
    options,
    dependencies,
  );
  const receipt = await observeFixedFile(
    authority.repositoryRoot,
    [".agenthawk", "integrations", "codex-v1.json"],
    maximumReceiptBytes,
    options,
    dependencies,
  );
  const config = await observeFixedFile(
    authority.repositoryRoot,
    [".codex", "config.toml"],
    maximumConfigBytes,
    options,
    dependencies,
  );
  const lock = await observeFixedFile(
    authority.repositoryRoot,
    [".agenthawk-codex-integration.lock"],
    maximumLockBytes,
    options,
    dependencies,
  );
  const finalRootSignature = await assertRootIdentity(authority, options, dependencies);
  if (rootSignature !== finalRootSignature) throw new Error("Repository root changed.");
  return {
    hook,
    receipt,
    config,
    lock,
    linkedWorktree: topology.linkedWorktree,
    rootSignature,
    topologySignature: topology.signature,
  };
}

function classifySnapshot(
  authority: RepositoryAuthority,
  snapshot: Snapshot,
  dependencies: CodexProjectHookStatusDependencies,
  options: OperationContext,
): {
  ownership: CodexProjectHookOwnership;
  blockers: CodexProjectHookBlocker[];
  readiness: Promise<CodexProjectHookReadiness>;
} {
  const blockers: CodexProjectHookBlocker[] = [];
  if (snapshot.config.state === "present") blockers.push("config_collision");
  if (snapshot.config.state === "oversize") throw new Error("Unsafe Codex configuration.");
  if (snapshot.lock.state !== "absent") {
    if (!parseLock(snapshot.lock)) throw new Error("Unsafe Codex operation lock.");
    blockers.push("operation_locked");
  }
  if (snapshot.linkedWorktree) blockers.push("linked_worktree");

  if (snapshot.receipt.state === "absent") {
    const ownership = snapshot.hook.state === "absent" ? "absent" : "unowned_hook";
    return { ownership, blockers, readiness: Promise.resolve("not_applicable") };
  }
  const receipt = parseReceipt(snapshot.receipt);
  if (
    !receipt ||
    !verifyCodexProjectHookReceiptBinding(
      receipt,
      authority.repositoryRoot,
      authority.repositoryIdentity,
    )
  ) {
    return {
      ownership: "record_collision",
      blockers,
      readiness: Promise.resolve("not_applicable"),
    };
  }
  if (snapshot.hook.state === "absent") {
    return {
      ownership: "owned_inactive",
      blockers,
      readiness: currentReadiness(receipt, authority, dependencies, options),
    };
  }
  const verified =
    snapshot.hook.state === "present" && snapshot.hook.bytes
      ? verifyCodexProjectHookBytes(receipt, snapshot.hook.bytes)
      : undefined;
  if (!verified) {
    return {
      ownership: "owned_modified",
      blockers,
      readiness: currentReadiness(receipt, authority, dependencies, options),
    };
  }
  return {
    ownership: "owned_exact",
    blockers,
    readiness: currentReadiness(receipt, authority, dependencies, options),
  };
}

async function currentReadiness(
  receipt: CodexProjectHookReceipt,
  authority: RepositoryAuthority,
  dependencies: CodexProjectHookStatusDependencies,
  options: OperationContext,
): Promise<CodexProjectHookReadiness> {
  try {
    throwIfCancelled(options);
    const resolveRealPath = dependencies.realPath ?? realpath;
    const nodeExecutable = await resolveRealPath(dependencies.nodeExecutable ?? process.execPath);
    throwIfCancelled(options);
    const adapterEntry = await resolveRealPath(
      dependencies.adapterEntry ??
        fileURLToPath(new URL("./codex-pretooluse-entry.js", import.meta.url)),
    );
    throwIfCancelled(options);
    const adapter = await readAbsoluteRegularFile(
      adapterEntry,
      maximumAdapterBytes,
      options,
      dependencies,
    );
    const current = buildCodexProjectHookArtifacts({
      adapterBytes: adapter,
      adapterEntry,
      adapterVersion: dependencies.adapterVersion ?? AGENTHAWK_CLI_VERSION,
      installationId: receipt.installationId,
      nodeExecutable,
      nodeVersion: dependencies.nodeVersion ?? process.version,
      repositoryIdentity: authority.repositoryIdentity,
      repositoryRoot: authority.repositoryRoot,
    }).receipt;
    return current.adapterSha256 === receipt.adapterSha256 &&
      current.adapterVersion === receipt.adapterVersion &&
      current.nodeVersion === receipt.nodeVersion &&
      current.launchArgumentsSha256 === receipt.launchArgumentsSha256
      ? "current"
      : "artifact_drift";
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    return "artifact_unavailable";
  }
}

async function detectLinkedWorktree(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<{ linkedWorktree: boolean; signature: string }> {
  const output = await (dependencies.runTopologyGit ?? runBoundedGit)(
    [...topologyArguments],
    authority.repositoryRoot,
    options,
  );
  throwIfCancelled(options);
  const lines = parseTopologyOutput(output);
  const top = await stableDirectory(lines[0] ?? "", options, dependencies);
  const git = await stableDirectory(lines[1] ?? "", options, dependencies);
  const common = await stableDirectory(lines[2] ?? "", options, dependencies);
  if (
    top.path !== authority.repositoryRoot ||
    !sameIdentity(top.stats, authority.repositoryIdentity)
  ) {
    throw new Error("Git topology does not match repository authority.");
  }
  return {
    linkedWorktree: git.path !== common.path || !sameIdentity(git.stats, common.stats),
    signature: [directorySignature(top), directorySignature(git), directorySignature(common)].join(
      "|",
    ),
  };
}

function parseTopologyOutput(output: string): readonly [string, string, string] {
  if (Buffer.byteLength(output, "utf8") > 65_536) throw new Error("Git topology is too large.");
  const match = /^([^\r\n]+)\r?\n([^\r\n]+)\r?\n([^\r\n]+)\r?\n$/u.exec(output);
  if (!match) throw new Error("Git topology is invalid.");
  const values = match.slice(1) as [string, string, string];
  for (const value of values) {
    if (
      !isAbsolute(value) ||
      value.length > 16_384 ||
      Buffer.byteLength(value, "utf8") > 16_384 ||
      /\p{C}/u.test(value)
    ) {
      throw new Error("Git topology path is invalid.");
    }
  }
  return values;
}

async function stableDirectory(
  path: string,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<{ path: string; stats: BigIntStats }> {
  const inspect = dependencies.inspectPath ?? inspectBigInt;
  const resolveRealPath = dependencies.realPath ?? realpath;
  throwIfCancelled(options);
  const first = await inspect(path);
  throwIfCancelled(options);
  const canonical = await resolveRealPath(path);
  throwIfCancelled(options);
  const second = await inspect(canonical);
  if (
    !first.isDirectory() ||
    first.isSymbolicLink() ||
    !second.isDirectory() ||
    second.isSymbolicLink() ||
    !sameIdentity(first, second) ||
    resolve(canonical) !== resolve(path)
  ) {
    throw new Error("Git topology directory is unsafe.");
  }
  return { path: resolve(canonical), stats: second };
}

async function observeFixedFile(
  root: string,
  segments: readonly string[],
  maximumBytes: number,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<FixedFileObservation> {
  let parent = root;
  const parentSignatures: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    const state = await exactEntry(parent, segment, options, dependencies);
    if (state === "absent") {
      return { state: "absent", signature: `absent:${parentSignatures.join("|")}` };
    }
    parent = join(parent, segment);
    const observed = await stableContainedDirectory(root, parent, options, dependencies);
    parentSignatures.push(directorySignature(observed));
  }
  const name = segments.at(-1);
  if (!name) throw new Error("Fixed path is invalid.");
  const state = await exactEntry(parent, name, options, dependencies);
  if (state === "absent") {
    return { state: "absent", signature: `absent:${parentSignatures.join("|")}` };
  }
  const path = join(parent, name);
  const inspect = dependencies.inspectPath ?? inspectBigInt;
  const openFile = dependencies.openFile ?? open;
  throwIfCancelled(options);
  const initial = await inspect(path);
  throwIfCancelled(options);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) {
    throw new Error("Fixed file is unsafe.");
  }
  if (initial.size > BigInt(maximumBytes)) {
    return {
      state: "oversize",
      signature: `${parentSignatures.join("|")}:${statSignature(initial, "oversize")}`,
    };
  }
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await openFile(path, flags);
  try {
    throwIfCancelled(options);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(initial, opened)) {
      throw new Error("Fixed file changed before read.");
    }
    const bytes = await readBoundedHandle(handle, maximumBytes, options);
    const openedFinal = await handle.stat({ bigint: true });
    const final = await inspect(path);
    throwIfCancelled(options);
    if (
      !sameIdentity(initial, openedFinal) ||
      !sameIdentity(initial, final) ||
      final.isSymbolicLink() ||
      !final.isFile() ||
      final.nlink !== 1n ||
      final.size !== initial.size ||
      BigInt(bytes.length) !== initial.size
    ) {
      throw new Error("Fixed file changed during read.");
    }
    return {
      state: "present",
      bytes,
      signature: `${parentSignatures.join("|")}:${statSignature(
        final,
        createHash("sha256").update(bytes).digest("hex"),
      )}`,
    };
  } finally {
    await handle.close();
  }
}

async function exactEntry(
  parent: string,
  expected: string,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<"absent" | "present"> {
  throwIfCancelled(options);
  const entries = await (dependencies.readDirectory ?? (async (path) => await readdir(path)))(
    parent,
  );
  throwIfCancelled(options);
  if (entries.length > maximumDirectoryEntries) throw new Error("Directory is too large.");
  const expectedKey = entryKey(expected);
  const equivalents = entries.filter((entry) => entryKey(entry) === expectedKey);
  if (equivalents.some((entry) => entry !== expected) || equivalents.length > 1) {
    throw new Error("Fixed path has an alias collision.");
  }
  return entries.includes(expected) ? "present" : "absent";
}

async function stableContainedDirectory(
  root: string,
  path: string,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<{ path: string; stats: BigIntStats }> {
  const contained = relative(root, path);
  if (!contained || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
    throw new Error("Fixed parent escapes repository root.");
  }
  const observed = await stableDirectory(path, options, dependencies);
  if (observed.path !== resolve(path)) throw new Error("Fixed parent is redirected.");
  return observed;
}

async function assertRootIdentity(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<string> {
  const current = await stableDirectory(authority.repositoryRoot, options, dependencies);
  if (!sameIdentity(current.stats, authority.repositoryIdentity)) {
    throw new Error("Repository root identity changed.");
  }
  return directorySignature(current);
}

async function readAbsoluteRegularFile(
  path: string,
  maximumBytes: number,
  options: OperationContext,
  dependencies: CodexProjectHookStatusDependencies,
): Promise<Buffer> {
  const inspect = dependencies.inspectPath ?? inspectBigInt;
  const openFile = dependencies.openFile ?? open;
  throwIfCancelled(options);
  const stats = await inspect(path);
  throwIfCancelled(options);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) {
    throw new Error("Current adapter is unavailable.");
  }
  const handle = await openFile(path, constants.O_RDONLY);
  try {
    throwIfCancelled(options);
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(stats, opened)) throw new Error("Current adapter changed.");
    const bytes = await readBoundedHandle(handle, maximumBytes, options);
    const final = await inspect(path);
    throwIfCancelled(options);
    if (!sameIdentity(stats, final) || BigInt(bytes.length) !== stats.size) {
      throw new Error("Current adapter changed.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedHandle(
  handle: FileHandle,
  maximumBytes: number,
  options: OperationContext,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    throwIfCancelled(options);
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    throwIfCancelled(options);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maximumBytes) throw new Error("Fixed file exceeds its size limit.");
  return buffer.subarray(0, offset);
}

function parseReceipt(observation: FixedFileObservation): CodexProjectHookReceipt | undefined {
  if (observation.state !== "present" || !observation.bytes) return undefined;
  return parseCodexProjectHookReceiptBytes(observation.bytes);
}

function parseLock(observation: FixedFileObservation): boolean {
  if (observation.state !== "present" || !observation.bytes) return false;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(observation.bytes);
    codexProjectHookLockSchema.parse(parseStrictJson(source));
    return true;
  } catch {
    return false;
  }
}

function snapshotSignature(snapshot: Snapshot): string {
  return JSON.stringify({
    hook: snapshot.hook.signature,
    receipt: snapshot.receipt.signature,
    config: snapshot.config.signature,
    lock: snapshot.lock.signature,
    linkedWorktree: snapshot.linkedWorktree,
    rootSignature: snapshot.rootSignature,
    topologySignature: snapshot.topologySignature,
  });
}

function statSignature(stats: BigIntStats, content: string): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.nlink,
    stats.ctimeNs,
    stats.mtimeNs,
    content,
  ].join(":");
}

function sameIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  return (
    left.dev >= 0n &&
    left.ino > 0n &&
    right.dev >= 0n &&
    right.ino > 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function entryKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function directorySignature(observation: { path: string; stats: BigIntStats }): string {
  return `${observation.path}:${statSignature(observation.stats, "directory")}`;
}

function inspectBigInt(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function remediation(ownership: CodexProjectHookOwnership): string {
  return {
    absent: "install_available",
    owned_inactive: "remove_then_install",
    owned_exact: "remove_owned",
    unowned_hook: "inspect_unowned_hook",
    record_collision: "inspect_receipt_collision",
    owned_modified: "inspect_modified_hook",
    unsafe: "resolve_unsafe_state",
  }[ownership];
}

function renderStatus(report: ReturnType<typeof codexProjectHookStatusReportSchema.parse>): string {
  return [
    `AgentHawk v${report.toolVersion}`,
    "",
    "Codex project hook: OBSERVED",
    `Ownership: ${report.ownership}`,
    `Readiness: ${report.readiness}`,
    `Blockers: ${report.blockers.length === 0 ? "none" : report.blockers.join(", ")}`,
    `Remediation: ${report.remediation}`,
    "",
    "This bounded snapshot does not prove Codex loaded, trusted, enabled, or executed the hook.",
    "No provider was contacted and no file was changed.",
    "",
  ].join("\n");
}
