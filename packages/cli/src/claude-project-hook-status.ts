import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import {
  type ClaudeLocalSettingsIgnored,
  type ClaudeProjectHookBlocker,
  type ClaudeSettingsState,
  type ClaudeSharedDisableAllHooks,
  type ClaudeSharedPreToolUse,
  cancellationError,
  claudeProjectHookStatusReportSchema,
  cliErrorReportSchema,
  isOperationCancelled,
  type OperationContext,
  throwIfCancelled,
} from "@agenthawk/core";
import type { CheckResult, OutputFormat } from "./check.js";
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
const maximumSettingsBytes = 262_144;
const maximumJsonDepth = 32;
const maximumJsonNodes = 4_096;
const maximumJsonMembers = 1_024;
const gitTimeoutMilliseconds = 10_000;
const localSettingsRelativePath = ".claude/settings.local.json";
const topologyArguments = [
  "rev-parse",
  "--path-format=absolute",
  "--show-toplevel",
  "--absolute-git-dir",
  "--git-common-dir",
] as const;

export interface ClaudeProjectHookStatusOptions extends OperationContext {
  readonly format: OutputFormat;
}

export interface ClaudeProjectHookStatusDependencies {
  readonly cwd?: string;
  readonly inspectPath?: (path: string) => Promise<BigIntStats>;
  readonly loadAuthority?: typeof loadRepositoryAuthority;
  readonly observeIgnore?: (
    root: string,
    options: OperationContext,
  ) => Promise<ClaudeLocalSettingsIgnored>;
  readonly openDirectory?: (path: string) => Promise<DirectoryReader>;
  readonly openFile?: typeof open;
  readonly realPath?: typeof realpath;
  readonly runTopologyGit?: typeof runBoundedGit;
}

interface DirectoryReader {
  read(): Promise<{ readonly name: string } | null>;
  close(): Promise<void>;
}

interface FixedFileObservation {
  readonly state: ClaudeSettingsState;
  readonly bytes?: Buffer;
  readonly signature: string;
}

interface Snapshot {
  readonly localSettings: ClaudeSettingsState;
  readonly sharedSettings: ClaudeSettingsState;
  readonly sharedPreToolUse: ClaudeSharedPreToolUse;
  readonly sharedDisableAllHooks: ClaudeSharedDisableAllHooks;
  readonly localSettingsIgnored: ClaudeLocalSettingsIgnored;
  readonly linkedWorktree: boolean;
  readonly signature: string;
}

export async function statusClaudeProjectHook(
  options: ClaudeProjectHookStatusOptions,
  dependencies: ClaudeProjectHookStatusDependencies = {},
): Promise<CheckResult> {
  try {
    const authority = await (dependencies.loadAuthority ?? loadRepositoryAuthority)(
      dependencies.cwd ?? process.cwd(),
      { signal: options.signal },
    );
    let snapshot: Snapshot;
    try {
      snapshot = await observeStableSnapshot(authority, options, dependencies);
    } catch (error) {
      if (isOperationCancelled(error)) throw error;
      return statusResult(unsafeSnapshot(), options.format);
    }
    return statusResult(snapshot, options.format);
  } catch (error) {
    if (isOperationCancelled(error)) throw error;
    if (error instanceof RepositoryAuthorityError) {
      return statusResult(unsafeSnapshot(), options.format);
    }
    const message = "Claude project-hook status could not be observed safely.";
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

function statusResult(snapshot: Snapshot, format: OutputFormat): CheckResult {
  const blockers = blockersFor(snapshot);
  const healthy =
    snapshot.localSettings === "absent" &&
    snapshot.sharedSettings === "absent" &&
    snapshot.sharedPreToolUse === "absent" &&
    snapshot.sharedDisableAllHooks === false &&
    snapshot.localSettingsIgnored === "ignored" &&
    blockers.length === 0;
  const report = claudeProjectHookStatusReportSchema.parse({
    schemaVersion: "1.0",
    toolVersion: AGENTHAWK_CLI_VERSION,
    command: "integrations_claude_status",
    localSettings: snapshot.localSettings,
    sharedSettings: snapshot.sharedSettings,
    sharedPreToolUse: snapshot.sharedPreToolUse,
    sharedDisableAllHooks: snapshot.sharedDisableAllHooks,
    localSettingsIgnored: snapshot.localSettingsIgnored,
    blockers,
    activation: "unproven",
    providersContacted: false,
    exitCodeMeaning: healthy ? "future_installation_precondition_met" : "attention_required",
  });
  return {
    exitCode: healthy ? 0 : 1,
    output: format === "json" ? `${JSON.stringify(report)}\n` : renderStatus(report),
  };
}

async function observeStableSnapshot(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<Snapshot> {
  const first = await observeSnapshot(authority, options, dependencies);
  throwIfCancelled(options);
  const second = await observeSnapshot(authority, options, dependencies);
  if (first.signature !== second.signature) {
    throw new Error("Claude project-hook state changed during observation.");
  }
  return second;
}

async function observeSnapshot(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<Snapshot> {
  const directoryListings = new Map<string, Promise<readonly string[]>>();
  const rootSignature = await assertRootIdentity(authority, options, dependencies);
  const topology = await detectLinkedWorktree(authority, options, dependencies);
  const local = await observeSettingsFile(
    authority.repositoryRoot,
    [".claude", "settings.local.json"],
    false,
    directoryListings,
    options,
    dependencies,
  ).catch((error: unknown) => unsafeObservation(error, options));
  const shared = await observeSettingsFile(
    authority.repositoryRoot,
    [".claude", "settings.json"],
    true,
    directoryListings,
    options,
    dependencies,
  ).catch((error: unknown) => unsafeObservation(error, options));
  const ignored = await observeIgnoreStatus(authority.repositoryRoot, options, dependencies);
  const finalRootSignature = await assertRootIdentity(authority, options, dependencies);
  if (rootSignature !== finalRootSignature) throw new Error("Repository root changed.");

  const sharedState = classifySharedSettings(shared);
  const signature = JSON.stringify({
    local: local.signature,
    shared: shared.signature,
    ignored,
    linkedWorktree: topology.linkedWorktree,
    rootSignature,
    topologySignature: topology.signature,
  });
  return {
    localSettings: local.state,
    sharedSettings: sharedState.state,
    sharedPreToolUse: sharedState.preToolUse,
    sharedDisableAllHooks: sharedState.disableAllHooks,
    localSettingsIgnored: ignored,
    linkedWorktree: topology.linkedWorktree,
    signature,
  };
}

function unsafeObservation(error: unknown, options: OperationContext): FixedFileObservation {
  if (options.signal?.aborted) throw cancellationError(options.signal);
  if (isOperationCancelled(error)) throw error;
  return { state: "unsafe", signature: "unsafe" };
}

function unsafeSnapshot(): Snapshot {
  return {
    localSettings: "unsafe",
    sharedSettings: "unsafe",
    sharedPreToolUse: "unknown",
    sharedDisableAllHooks: "unknown",
    localSettingsIgnored: "unknown",
    linkedWorktree: false,
    signature: "unsafe",
  };
}

function classifySharedSettings(observation: FixedFileObservation): {
  state: ClaudeSettingsState;
  preToolUse: ClaudeSharedPreToolUse;
  disableAllHooks: ClaudeSharedDisableAllHooks;
} {
  if (observation.state === "absent") {
    return { state: "absent", preToolUse: "absent", disableAllHooks: false };
  }
  if (observation.state === "unsafe" || !observation.bytes) {
    return { state: "unsafe", preToolUse: "unknown", disableAllHooks: "unknown" };
  }
  try {
    const value = parseStrictJson(
      new TextDecoder("utf-8", { fatal: true }).decode(observation.bytes),
    );
    assertBoundedJson(value);
    if (!isRecord(value)) throw new Error("Shared settings must be an object.");
    const disableAllHooks = value.disableAllHooks;
    if (disableAllHooks !== undefined && typeof disableAllHooks !== "boolean") {
      throw new Error("Shared disableAllHooks is invalid.");
    }
    const hooks = value.hooks;
    let preToolUse: ClaudeSharedPreToolUse = "absent";
    if (hooks !== undefined) {
      if (!isRecord(hooks)) throw new Error("Shared hooks is invalid.");
      const groups = hooks.PreToolUse;
      if (groups !== undefined) {
        if (!Array.isArray(groups) || groups.some((group) => !isRecord(group))) {
          throw new Error("Shared PreToolUse is invalid.");
        }
        preToolUse = groups.length > 0 ? "present" : "absent";
      }
    }
    return {
      state: "present",
      preToolUse,
      disableAllHooks: disableAllHooks === true,
    };
  } catch {
    return { state: "unsafe", preToolUse: "unknown", disableAllHooks: "unknown" };
  }
}

function assertBoundedJson(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maximumJsonNodes || current.depth > maximumJsonDepth) {
      throw new Error("Shared settings structure exceeds its bound.");
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > maximumJsonMembers) {
        throw new Error("Shared settings array exceeds its bound.");
      }
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      const children = Object.values(current.value);
      if (children.length > maximumJsonMembers) {
        throw new Error("Shared settings object exceeds its bound.");
      }
      for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function blockersFor(snapshot: Snapshot): ClaudeProjectHookBlocker[] {
  const blockers: ClaudeProjectHookBlocker[] = [];
  if (snapshot.localSettings === "unsafe") blockers.push("local_settings_unsafe");
  if (snapshot.sharedSettings === "unsafe") blockers.push("shared_settings_unsafe");
  if (snapshot.localSettings === "present") blockers.push("local_settings_present");
  if (snapshot.localSettingsIgnored === "not_ignored") blockers.push("local_settings_not_ignored");
  if (snapshot.localSettingsIgnored === "unknown") blockers.push("ignore_status_unavailable");
  if (snapshot.sharedPreToolUse === "present") blockers.push("project_hooks_present");
  if (snapshot.sharedDisableAllHooks === true) blockers.push("project_hooks_declared_disabled");
  if (snapshot.linkedWorktree) blockers.push("linked_worktree");
  return blockers;
}

async function observeSettingsFile(
  root: string,
  segments: readonly string[],
  retainBytes: boolean,
  directoryListings: Map<string, Promise<readonly string[]>>,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<FixedFileObservation> {
  let parent = root;
  const parentSignatures: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    const state = await exactEntry(parent, segment, directoryListings, options, dependencies);
    if (state === "absent") {
      return { state: "absent", signature: `absent:${parentSignatures.join("|")}` };
    }
    parent = join(parent, segment);
    const observed = await stableContainedDirectory(root, parent, options, dependencies);
    parentSignatures.push(directorySignature(observed));
  }
  const name = segments.at(-1);
  if (!name) throw new Error("Fixed path is invalid.");
  if ((await exactEntry(parent, name, directoryListings, options, dependencies)) === "absent") {
    return { state: "absent", signature: `absent:${parentSignatures.join("|")}` };
  }

  const path = join(parent, name);
  const inspect = dependencies.inspectPath ?? inspectBigInt;
  const openFile = dependencies.openFile ?? open;
  throwIfCancelled(options);
  const initial = await inspect(path);
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.nlink !== 1n ||
    initial.size > BigInt(maximumSettingsBytes)
  ) {
    throw new Error("Claude settings path is unsafe.");
  }
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const handle = await openFile(path, flags);
  try {
    throwIfCancelled(options);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(initial, opened)) {
      throw new Error("Claude settings changed before read.");
    }
    const bytes = await readBoundedHandle(handle, options);
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
      throw new Error("Claude settings changed during read.");
    }
    return {
      state: "present",
      ...(retainBytes ? { bytes } : {}),
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
  directoryListings: Map<string, Promise<readonly string[]>>,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<"absent" | "present"> {
  throwIfCancelled(options);
  let listing = directoryListings.get(parent);
  if (!listing) {
    listing = readBoundedDirectory(parent, options, dependencies);
    directoryListings.set(parent, listing);
  }
  const entries = await listing;
  const expectedKey = entryKey(expected);
  const equivalents = entries.filter((entry) => entryKey(entry) === expectedKey);
  if (equivalents.some((entry) => entry !== expected) || equivalents.length > 1) {
    throw new Error("Fixed path has an alias collision.");
  }
  return entries.includes(expected) ? "present" : "absent";
}

async function readBoundedDirectory(
  path: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<readonly string[]> {
  throwIfCancelled(options);
  const directory = await (dependencies.openDirectory ?? opendir)(path);
  const entries: string[] = [];
  let failure: unknown;
  try {
    while (true) {
      throwIfCancelled(options);
      const entry = await directory.read();
      throwIfCancelled(options);
      if (!entry) break;
      entries.push(entry.name);
      if (entries.length > maximumDirectoryEntries) throw new Error("Directory is too large.");
    }
  } catch (error) {
    failure = error;
  }
  try {
    await directory.close();
  } catch (error) {
    if (!hasErrorCode(error, "ERR_DIR_CLOSED") && !failure) failure = error;
  }
  if (failure) throw failure;
  return entries;
}

async function readBoundedHandle(handle: FileHandle, options: OperationContext): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumSettingsBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    throwIfCancelled(options);
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    throwIfCancelled(options);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maximumSettingsBytes) throw new Error("Claude settings exceeds its size limit.");
  return buffer.subarray(0, offset);
}

async function observeIgnoreStatus(
  root: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<ClaudeLocalSettingsIgnored> {
  try {
    throwIfCancelled(options);
    const result = await (dependencies.observeIgnore ?? observeQuietGitIgnore)(root, options);
    throwIfCancelled(options);
    return result;
  } catch (error) {
    if (isOperationCancelled(error) || options.signal?.aborted) throw error;
    return "unknown";
  }
}

async function observeQuietGitIgnore(
  root: string,
  options: OperationContext,
): Promise<ClaudeLocalSettingsIgnored> {
  throwIfCancelled(options);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  return await new Promise<ClaudeLocalSettingsIgnored>((resolvePromise, reject) => {
    let settled = false;
    const child = spawn(
      "git",
      [
        "-c",
        "core.pager=cat",
        "-c",
        "core.quotepath=false",
        "check-ignore",
        "-q",
        "--",
        localSettingsRelativePath,
      ],
      {
        cwd: root,
        env: {
          ...environment,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        },
        signal: options.signal,
        stdio: "ignore",
        timeout: gitTimeoutMilliseconds,
        windowsHide: true,
      },
    );
    const settle = (value: ClaudeLocalSettingsIgnored) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    child.once("error", () => {
      if (options.signal?.aborted) {
        if (!settled) {
          settled = true;
          reject(cancellationError(options.signal));
        }
      } else settle("unknown");
    });
    child.once("close", (code) => {
      if (options.signal?.aborted) {
        if (!settled) {
          settled = true;
          reject(cancellationError(options.signal));
        }
        return;
      }
      settle(code === 0 ? "ignored" : code === 1 ? "not_ignored" : "unknown");
    });
  });
}

async function detectLinkedWorktree(
  authority: RepositoryAuthority,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<{ linkedWorktree: boolean; signature: string }> {
  const output = await (dependencies.runTopologyGit ?? runBoundedGit)(
    [...topologyArguments],
    authority.repositoryRoot,
    options,
  );
  throwIfCancelled(options);
  const lines = parseTopologyOutput(output);
  const top = await stableDirectory(lines[0], options, dependencies);
  const git = await stableDirectory(lines[1], options, dependencies);
  const common = await stableDirectory(lines[2], options, dependencies);
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
      !isCanonicalNativeTopologyPath(value) ||
      value.length > 16_384 ||
      Buffer.byteLength(value, "utf8") > 16_384 ||
      /\p{C}/u.test(value)
    ) {
      throw new Error("Git topology path is invalid.");
    }
  }
  return values;
}

async function stableContainedDirectory(
  root: string,
  path: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
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
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<string> {
  const current = await stableDirectory(authority.repositoryRoot, options, dependencies);
  if (!sameIdentity(current.stats, authority.repositoryIdentity)) {
    throw new Error("Repository root identity changed.");
  }
  return directorySignature(current);
}

async function stableDirectory(
  path: string,
  options: OperationContext,
  dependencies: ClaudeProjectHookStatusDependencies,
): Promise<{ path: string; stats: BigIntStats }> {
  const inspect = dependencies.inspectPath ?? inspectBigInt;
  const resolveRealPath = dependencies.realPath ?? realpath;
  throwIfCancelled(options);
  const first = await inspect(path);
  const canonical = await resolveRealPath(path);
  const second = await inspect(canonical);
  throwIfCancelled(options);
  if (
    !first.isDirectory() ||
    first.isSymbolicLink() ||
    !second.isDirectory() ||
    second.isSymbolicLink() ||
    !sameIdentity(first, second) ||
    resolve(canonical) !== resolve(path)
  ) {
    throw new Error("Directory is unsafe.");
  }
  return { path: resolve(canonical), stats: second };
}

function isCanonicalNativeTopologyPath(value: string): boolean {
  if (process.platform !== "win32") {
    return (
      posix.isAbsolute(value) && posix.normalize(value) === value && posix.resolve(value) === value
    );
  }
  const native = value.replaceAll("/", "\\");
  const fullyQualified =
    /^[A-Za-z]:\\/u.test(native) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(native);
  return fullyQualified && win32.normalize(native) === native && win32.resolve(native) === native;
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

function directorySignature(observation: { path: string; stats: BigIntStats }): string {
  return `${observation.path}:${statSignature(observation.stats, "directory")}`;
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

function inspectBigInt(path: string): Promise<BigIntStats> {
  return lstat(path, { bigint: true });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderStatus(
  report: ReturnType<typeof claudeProjectHookStatusReportSchema.parse>,
): string {
  return [
    `AgentHawk v${report.toolVersion}`,
    "",
    "Claude project hook: PREFLIGHT",
    `Local settings: ${report.localSettings}`,
    `Shared settings: ${report.sharedSettings}`,
    `Shared PreToolUse: ${report.sharedPreToolUse}`,
    `Shared disableAllHooks: ${String(report.sharedDisableAllHooks)}`,
    `Local settings ignored: ${report.localSettingsIgnored}`,
    `Blockers: ${report.blockers.length === 0 ? "none" : report.blockers.join(", ")}`,
    `Activation: ${report.activation}`,
    "",
    "This is only a future installation preflight; it does not prove Claude loaded or enforces a hook.",
    "No provider was contacted and no file was changed.",
    "",
  ]
    .map(escapeTerminal)
    .join("\n");
}
