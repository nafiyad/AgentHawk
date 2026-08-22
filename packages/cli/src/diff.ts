import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  cancellationError,
  cliErrorReportSchema,
  compareDirectDependencies,
  type DependencyChange,
  diffReportSchema,
  directDependencies,
  inventoryReportSchema,
  isOperationCancelled,
  type OperationContext,
  packageManifestSchema,
  throwIfCancelled,
} from "@agenthawk/core";
import { parseDocument } from "yaml";
import { escapeTerminal } from "./terminal.js";

const maximumManifestBytes = 1_048_576;
const maximumGitOutputBytes = 2_097_152;
const gitTimeoutMilliseconds = 10_000;
const lockfileNames = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
] as const;

export type DiffOutputFormat = "json" | "terminal";

export interface DiffOptions {
  base: string;
  cwd?: string;
  format: DiffOutputFormat;
  strict: boolean;
  signal?: AbortSignal;
}

export interface ScanOptions {
  cwd?: string;
  format: DiffOutputFormat;
  signal?: AbortSignal;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string, options?: OperationContext): Promise<string>;
}

export interface DiffDependencies {
  git?: GitRunner;
}

export interface DiffResult {
  exitCode: number;
  output: string;
}

export async function inventoryDependencies(options: ScanOptions): Promise<DiffResult> {
  try {
    throwIfCancelled({ signal: options.signal });
    const cwd = resolve(options.cwd ?? process.cwd());
    const manifest = await readManifest(join(cwd, "package.json"), options.signal);
    throwIfCancelled({ signal: options.signal });
    const report = inventoryReportSchema.parse({
      schemaVersion: "1.0",
      manifest: "package.json",
      dependencies: directDependencies(manifest),
    });
    return { exitCode: 0, output: render(report, options.format) };
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error)) throw error;
    return inputFailure(error, options.format);
  }
}

export async function diffDependencies(
  options: DiffOptions,
  dependencies: DiffDependencies = {},
): Promise<DiffResult> {
  try {
    throwIfCancelled({ signal: options.signal });
    validateBase(options.base);
    const cwd = resolve(options.cwd ?? process.cwd());
    const git = dependencies.git ?? defaultGitRunner;
    const rootOutput = await git.run(["rev-parse", "--show-toplevel"], cwd, {
      signal: options.signal,
    });
    const repositoryRoot = rootOutput.trim();
    if (!isAbsolute(repositoryRoot)) throw new DiffInputError("Git returned an invalid root path.");

    const commitOutput = await git.run(
      ["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`],
      repositoryRoot,
      { signal: options.signal },
    );
    const baseCommit = commitOutput.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) {
      throw new DiffInputError("Git returned an invalid base commit.");
    }

    const operations = await Promise.allSettled([
      git.run(
        ["show", "--no-textconv", "--no-ext-diff", `${baseCommit}:package.json`],
        repositoryRoot,
        { signal: options.signal },
      ),
      readManifest(join(repositoryRoot, "package.json"), options.signal),
      git.run(
        ["diff", "--name-only", "-z", "--no-ext-diff", baseCommit, "--", ...lockfileNames],
        repositoryRoot,
        { signal: options.signal },
      ),
    ]);
    throwIfCancelled({ signal: options.signal });
    const cancellation = operations.find(
      (operation): operation is PromiseRejectedResult =>
        operation.status === "rejected" && isOperationCancelled(operation.reason),
    );
    if (cancellation) throw cancellation.reason;
    const rejection = operations.find(
      (operation): operation is PromiseRejectedResult => operation.status === "rejected",
    );
    if (rejection) throw rejection.reason;
    const [baseSource, currentManifest, changedLockfiles] = operations.map(
      (operation) => (operation as PromiseFulfilledResult<unknown>).value,
    ) as [string, ReturnType<typeof packageManifestSchema.parse>, string];
    const baseManifest = parseManifest(baseSource);
    const changes = compareDirectDependencies(baseManifest, currentManifest);
    const present = await presentLockfiles(repositoryRoot, options.signal);
    throwIfCancelled({ signal: options.signal });
    const updated = parseNullSeparated(changedLockfiles).filter(isLockfileName);
    const usableUpdates = updated.filter((name) => present.includes(name));
    const missingLockfileUpdate = changes.length > 0 && usableUpdates.length === 0;
    const findings = missingLockfileUpdate
      ? [
          {
            approvable: true,
            basis: "evidence",
            evidence: [],
            message:
              "Direct dependency changes were detected without a corresponding lockfile update.",
            remediation: "Regenerate and commit the repository lockfile, then rerun AgentHawk.",
            ruleId: "PG014",
            severity: "medium",
            title: "Dependency changed without lockfile update",
            verdict: "review",
          },
        ]
      : [];
    const verdict = findings.length > 0 ? "review" : "allow";
    const report = diffReportSchema.parse({
      schemaVersion: "1.0",
      base: options.base,
      baseCommit,
      manifest: "package.json",
      changes,
      lockfiles: { present, updated: usableUpdates },
      findings,
      verdict,
    });
    return {
      exitCode: options.strict && verdict === "review" ? 1 : 0,
      output: render(report, options.format),
    };
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error)) throw error;
    return inputFailure(error, options.format);
  }
}

export function parseManifest(source: string): ReturnType<typeof packageManifestSchema.parse> {
  if (Buffer.byteLength(source, "utf8") > maximumManifestBytes) {
    throw new DiffInputError("package.json exceeds the 1 MiB limit.");
  }
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) throw new DiffInputError("package.json contains duplicate keys.");
  try {
    return packageManifestSchema.parse(JSON.parse(source));
  } catch {
    throw new DiffInputError("package.json must be valid JSON with string dependency versions.");
  }
}

async function readManifest(
  path: string,
  signal?: AbortSignal,
): Promise<ReturnType<typeof packageManifestSchema.parse>> {
  throwIfCancelled({ signal });
  try {
    const pathStats = await lstat(path);
    throwIfCancelled({ signal });
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new DiffInputError("package.json must be a regular non-symlink file.");
    }
  } catch (error) {
    if (signal?.aborted) throw cancellationError(signal);
    if (isOperationCancelled(error)) throw error;
    if (error instanceof DiffInputError) throw error;
    throw new DiffInputError("Unable to open package.json.");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY);
    throwIfCancelled({ signal });
  } catch (error) {
    if (signal?.aborted) throw cancellationError(signal);
    if (isOperationCancelled(error)) throw error;
    throw new DiffInputError("Unable to open package.json.");
  }
  try {
    const stats = await handle.stat();
    throwIfCancelled({ signal });
    if (!stats.isFile()) throw new DiffInputError("package.json must be a regular file.");
    if (stats.size > maximumManifestBytes)
      throw new DiffInputError("package.json exceeds the 1 MiB limit.");
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      throwIfCancelled({ signal });
      const chunk = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    if (offset > maximumManifestBytes)
      throw new DiffInputError("package.json exceeds the 1 MiB limit.");
    throwIfCancelled({ signal });
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new DiffInputError("package.json must be valid UTF-8.");
    }
    return parseManifest(source);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function presentLockfiles(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<(typeof lockfileNames)[number][]> {
  const results: (typeof lockfileNames)[number][] = [];
  for (const name of lockfileNames) {
    throwIfCancelled({ signal });
    try {
      const pathStats = await lstat(join(repositoryRoot, name));
      throwIfCancelled({ signal });
      if (!pathStats.isFile() || pathStats.isSymbolicLink()) continue;
      const handle = await open(join(repositoryRoot, name), constants.O_RDONLY);
      try {
        throwIfCancelled({ signal });
        if ((await handle.stat()).isFile()) results.push(name);
        throwIfCancelled({ signal });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (signal?.aborted) throw cancellationError(signal);
      if (isOperationCancelled(error)) throw error;
    }
  }
  return results;
}

function parseNullSeparated(value: string): string[] {
  return value.split("\0").filter((name) => name.length > 0);
}

function isLockfileName(value: string): value is (typeof lockfileNames)[number] {
  return lockfileNames.includes(value as (typeof lockfileNames)[number]);
}

function validateBase(base: string): void {
  const containsControl = [...base].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 10 || code === 13 || code === 27;
  });
  if (base.length < 1 || base.length > 512 || containsControl) {
    throw new DiffInputError("Base ref is invalid.");
  }
}

function render(report: object, format: DiffOutputFormat): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const value = report as Record<string, unknown>;
  if ("changes" in value) {
    const changes = value.changes as DependencyChange[];
    const lines = [`AgentHawk dependency diff: ${String(value.verdict).toUpperCase()}`];
    for (const change of changes) {
      lines.push(`- ${change.kind}: ${change.name}@${change.requestedSpec} (${change.section})`);
    }
    for (const finding of value.findings as Array<{ ruleId: string; message: string }>) {
      lines.push(`${finding.ruleId}: ${finding.message}`);
    }
    return `${lines.map(escapeTerminal).join("\n")}\n`;
  }
  const dependencies = value.dependencies as Array<{
    name: string;
    requestedSpec: string;
    section: string;
  }>;
  return `${["AgentHawk direct dependencies", ...dependencies.map((item) => `- ${item.name}@${item.requestedSpec} (${item.section})`)].map(escapeTerminal).join("\n")}\n`;
}

function inputFailure(error: unknown, format: DiffOutputFormat): DiffResult {
  const invalid = error instanceof DiffInputError;
  const message = invalid ? error.message : "Dependency diff failed safely.";
  const exitCode = invalid ? 2 : 4;
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

class DiffInputError extends Error {}

const defaultGitRunner: GitRunner = {
  run: async (args, cwd, options = {}) =>
    await new Promise<string>((resolveOutput, reject) => {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      const environment = gitEnvironment();
      execFile(
        "git",
        ["-c", "core.pager=cat", "-c", "diff.external=", "--no-pager", ...args],
        {
          cwd,
          encoding: "buffer",
          env: environment,
          maxBuffer: maximumGitOutputBytes,
          signal: options.signal,
          timeout: gitTimeoutMilliseconds,
          windowsHide: true,
        },
        (error, stdout) => {
          if (options.signal?.aborted) {
            reject(cancellationError(options.signal));
            return;
          }
          if (error)
            reject(new DiffInputError("Git operation failed; verify the repository and base ref."));
          else {
            try {
              resolveOutput(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
            } catch {
              reject(new DiffInputError("Git output must be valid UTF-8."));
            }
          }
        },
      );
    }),
};

export async function runBoundedGit(
  args: string[],
  cwd: string,
  options: OperationContext = {},
): Promise<string> {
  return await defaultGitRunner.run(args, cwd, options);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}
