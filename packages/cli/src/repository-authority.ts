import { type BigIntStats, constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  type AgentHawkConfig,
  type ApprovalFile,
  agentHawkConfigSchema,
  approvalFileSchema,
  cancellationError,
  type DirectDependency,
  directDependencies,
  isOperationCancelled,
  type OperationContext,
  type PackageManifest,
  packageManifestSchema,
  throwIfCancelled,
} from "@agenthawk/core";
import { inspectOptionalRegularFile, readApprovalFile, readPolicyFile } from "./check.js";
import { parseManifest, runBoundedGit } from "./diff.js";

const maximumDirectoryInputCharacters = 4_096;
const maximumDirectoryInputBytes = 16_384;
const maximumGitRootBytes = 16_384;
const maximumManifestBytes = 1_048_576;

export interface RepositoryAuthority {
  readonly repositoryRoot: string;
  readonly repositoryIdentity: {
    readonly dev: bigint;
    readonly ino: bigint;
  };
  readonly config: AgentHawkConfig;
  readonly approvals: ApprovalFile;
  readonly manifest?: PackageManifest;
  readonly directDependencyNames: readonly string[];
}

export interface RepositoryAuthorityDependencies {
  inspectPath?: typeof lstat;
  inspectIdentity?: (path: string) => Promise<BigIntStats>;
  openFile?: typeof open;
  readApprovals?: typeof readApprovalFile;
  readPolicy?: (path: string, options?: OperationContext) => Promise<unknown | undefined>;
  realPath?: typeof realpath;
  runGit?: typeof runBoundedGit;
}

export class RepositoryAuthorityError extends Error {
  constructor(
    readonly code: "configuration" | "repository_identity",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryAuthorityError";
  }
}

export async function loadRepositoryAuthority(
  actionDirectory: string,
  options: OperationContext = {},
  dependencies: RepositoryAuthorityDependencies = {},
): Promise<RepositoryAuthority> {
  const inspectPath = dependencies.inspectPath ?? lstat;
  const inspectIdentity =
    dependencies.inspectIdentity ?? (async (path: string) => await lstat(path, { bigint: true }));
  const resolveRealPath = dependencies.realPath ?? realpath;
  const runGit = dependencies.runGit ?? runBoundedGit;
  try {
    throwIfCancelled(options);
    validateDirectoryInput(actionDirectory);
    const actionRoot = await canonicalDirectory(
      actionDirectory,
      resolveRealPath,
      inspectPath,
      options,
    );
    const initialIdentity = await inspectDirectoryIdentity(actionRoot, inspectIdentity, options);
    const rootOutput = await runGit(["rev-parse", "--show-toplevel"], actionRoot, options);
    throwIfCancelled(options);
    const declaredRoot = parseGitRoot(rootOutput);
    const repositoryRoot = await canonicalDirectory(
      declaredRoot,
      resolveRealPath,
      inspectPath,
      options,
    );
    const gitIdentity = await inspectDirectoryIdentity(repositoryRoot, inspectIdentity, options);
    if (repositoryRoot !== actionRoot || !sameDirectoryIdentity(initialIdentity, gitIdentity)) {
      throw new RepositoryAuthorityError(
        "repository_identity",
        "Action directory must be the canonical Git worktree root.",
      );
    }

    const policyPath = join(repositoryRoot, ".agenthawk.yml");
    const approvalsPath = join(repositoryRoot, ".agenthawk", "approvals.yml");
    const manifestPath = join(repositoryRoot, "package.json");
    const reads = await Promise.allSettled([
      dependencies.readPolicy
        ? dependencies.readPolicy(policyPath, { signal: options.signal })
        : readAuthorityPolicy(policyPath, options, dependencies),
      dependencies.readApprovals
        ? dependencies.readApprovals(approvalsPath, false, { signal: options.signal })
        : readAuthorityApprovals(approvalsPath, options, dependencies),
      readOptionalManifest(manifestPath, options, dependencies),
    ]);
    throwIfCancelled(options);
    const cancelled = reads.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && isOperationCancelled(result.reason),
    );
    if (cancelled) throw cancelled.reason;
    const rejected = reads.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) {
      if (rejected.reason instanceof RepositoryAuthorityError) throw rejected.reason;
      throw new RepositoryAuthorityError(
        "configuration",
        "Repository configuration could not be loaded.",
      );
    }
    const [policyDocument, approvalDocument, manifest] = reads.map(
      (result) => (result as PromiseFulfilledResult<unknown>).value,
    ) as [unknown | undefined, unknown | undefined, PackageManifest | undefined];
    if (policyDocument === undefined)
      await assertStillAbsent(policyPath, inspectPath, options, "Policy");
    if (approvalDocument === undefined)
      await assertStillAbsent(approvalsPath, inspectPath, options, "Approval");
    if (manifest === undefined)
      await assertStillAbsent(manifestPath, inspectPath, options, "Manifest");
    throwIfCancelled(options);
    const finalIdentity = await inspectDirectoryIdentity(repositoryRoot, inspectIdentity, options);
    if (!sameDirectoryIdentity(initialIdentity, finalIdentity)) {
      throw new RepositoryAuthorityError(
        "repository_identity",
        "Repository root changed during authority loading.",
      );
    }
    let config: AgentHawkConfig;
    let approvals: ApprovalFile;
    try {
      config = agentHawkConfigSchema.parse(policyDocument ?? { version: 1 });
      approvals = approvalFileSchema.parse(approvalDocument ?? { version: 1, approvals: [] });
    } catch {
      throw new RepositoryAuthorityError("configuration", "Repository configuration is invalid.");
    }
    const dependenciesList: DirectDependency[] = manifest ? directDependencies(manifest) : [];
    return {
      repositoryRoot,
      repositoryIdentity: { dev: finalIdentity.dev, ino: finalIdentity.ino },
      config,
      approvals,
      ...(manifest ? { manifest } : {}),
      directDependencyNames: [...new Set(dependenciesList.map(({ name }) => name))],
    };
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error) || error instanceof RepositoryAuthorityError) throw error;
    throw new RepositoryAuthorityError(
      "repository_identity",
      "Repository authority could not be established.",
    );
  }
}

function validateDirectoryInput(value: string): void {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length < 1 ||
    value.length > maximumDirectoryInputCharacters ||
    Buffer.byteLength(value, "utf8") > maximumDirectoryInputBytes ||
    hasControl(value)
  ) {
    throw new RepositoryAuthorityError("repository_identity", "Action directory is invalid.");
  }
}

function parseGitRoot(output: string): string {
  const root = output.replace(/\r?\n$/u, "");
  if (
    Buffer.byteLength(output, "utf8") < 2 ||
    Buffer.byteLength(output, "utf8") > maximumGitRootBytes ||
    hasControl(root) ||
    !/^(?:[^\r\n]+)\r?\n$/u.test(output)
  ) {
    throw new RepositoryAuthorityError(
      "repository_identity",
      "Git returned an invalid worktree root.",
    );
  }
  if (!isAbsolute(root))
    throw new RepositoryAuthorityError(
      "repository_identity",
      "Git returned an invalid worktree root.",
    );
  return root;
}

async function canonicalDirectory(
  path: string,
  resolveRealPath: typeof realpath,
  inspectPath: typeof lstat,
  options: OperationContext,
): Promise<string> {
  try {
    throwIfCancelled(options);
    await inspectDirectoryPath(path, inspectPath, options);
    const canonical = await resolveRealPath(path);
    throwIfCancelled(options);
    await inspectDirectoryPath(canonical, inspectPath, options);
    const stats = await inspectPath(canonical);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("invalid directory");
    return resolve(canonical);
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error) || error instanceof RepositoryAuthorityError) throw error;
    throw new RepositoryAuthorityError(
      "repository_identity",
      "Repository directory could not be resolved.",
    );
  }
}

async function inspectDirectoryPath(
  path: string,
  inspectPath: typeof lstat,
  options: OperationContext,
): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    throwIfCancelled(options);
    current = join(current, segment);
    const stats = await inspectPath(current);
    throwIfCancelled(options);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new RepositoryAuthorityError(
        "repository_identity",
        "Repository path must not use symbolic redirection.",
      );
    }
  }
}

async function inspectDirectoryIdentity(
  path: string,
  inspectIdentity: (path: string) => Promise<BigIntStats>,
  options: OperationContext,
): Promise<BigIntStats> {
  throwIfCancelled(options);
  const stats = await inspectIdentity(path);
  throwIfCancelled(options);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new RepositoryAuthorityError(
      "repository_identity",
      "Repository root must remain a regular directory.",
    );
  }
  return stats;
}

async function readOptionalManifest(
  path: string,
  options: OperationContext,
  dependencies: RepositoryAuthorityDependencies,
): Promise<PackageManifest | undefined> {
  const inspectPath = dependencies.inspectPath ?? lstat;
  const openFile = dependencies.openFile ?? open;
  let initial: Stats;
  try {
    initial = await inspectRegularPath(path, inspectPath, options);
    throwIfCancelled(options);
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isMissing(error)) return undefined;
    throw error;
  }
  let handle: FileHandle;
  try {
    handle = await openFile(path, constants.O_RDONLY);
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error)) throw error;
    throw new RepositoryAuthorityError("configuration", "Repository manifest could not be read.");
  }
  try {
    throwIfCancelled(options);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFileIdentity(initial, opened) ||
      opened.size > maximumManifestBytes
    ) {
      throw new RepositoryAuthorityError("configuration", "Repository manifest is unsafe.");
    }
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfCancelled(options);
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maximumManifestBytes) {
      throw new RepositoryAuthorityError(
        "configuration",
        "Repository manifest exceeds the 1 MiB limit.",
      );
    }
    const final = await inspectRegularPath(path, inspectPath, options);
    throwIfCancelled(options);
    if (
      !sameFileIdentity(initial, final) ||
      final.size !== initial.size ||
      offset !== initial.size
    ) {
      throw new RepositoryAuthorityError(
        "configuration",
        "Repository manifest changed while it was being read.",
      );
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new RepositoryAuthorityError(
        "configuration",
        "Repository manifest must be valid UTF-8.",
      );
    }
    return packageManifestSchema.parse(parseManifest(source));
  } finally {
    await handle.close();
  }
}

async function inspectRegularPath(
  path: string,
  inspectPath: typeof lstat,
  options: OperationContext,
): Promise<Stats> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let stats: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    throwIfCancelled(options);
    current = join(current, segment);
    stats = await inspectPath(current);
    throwIfCancelled(options);
    const final = index === segments.length - 1;
    if (stats.isSymbolicLink() || (final ? !stats.isFile() : !stats.isDirectory())) {
      throw new RepositoryAuthorityError("configuration", "Repository manifest is unsafe.");
    }
  }
  if (!stats || stats.size > maximumManifestBytes) {
    throw new RepositoryAuthorityError("configuration", "Repository manifest is unsafe.");
  }
  return stats;
}

function sameDirectoryIdentity(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
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

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readAuthorityPolicy(
  path: string,
  options: OperationContext,
  dependencies: RepositoryAuthorityDependencies,
): Promise<unknown | undefined> {
  const inspectPath = dependencies.inspectPath ?? lstat;
  const state = await inspectOptionalRegularFile(path, inspectPath);
  throwIfCancelled(options);
  if (state === "absent") return undefined;
  if (state === "invalid")
    throw new RepositoryAuthorityError("configuration", "Policy path is unsafe.");
  return await readPolicyFile(path, {
    inspectPath,
    openFile: dependencies.openFile ?? open,
    signal: options.signal,
  });
}

async function readAuthorityApprovals(
  path: string,
  options: OperationContext,
  dependencies: RepositoryAuthorityDependencies,
): Promise<unknown | undefined> {
  const inspectPath = dependencies.inspectPath ?? lstat;
  const state = await inspectOptionalRegularFile(path, inspectPath);
  throwIfCancelled(options);
  if (state === "absent") return undefined;
  if (state === "invalid")
    throw new RepositoryAuthorityError("configuration", "Approval path is unsafe.");
  return await readApprovalFile(path, true, {
    inspectPath,
    openFile: dependencies.openFile ?? open,
    signal: options.signal,
  });
}

async function assertStillAbsent(
  path: string,
  inspectPath: typeof lstat,
  options: OperationContext,
  kind: "Approval" | "Manifest" | "Policy",
): Promise<void> {
  throwIfCancelled(options);
  try {
    await inspectPath(path);
    throwIfCancelled(options);
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isMissing(error)) return;
    throw new RepositoryAuthorityError("configuration", `${kind} path could not be revalidated.`);
  }
  throw new RepositoryAuthorityError(
    "configuration",
    `${kind} path changed during authority loading.`,
  );
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
