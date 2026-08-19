import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  compareDirectDependencies,
  type DependencyChange,
  directDependencies,
  packageManifestSchema,
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
}

export interface ScanOptions {
  cwd?: string;
  format: DiffOutputFormat;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<string>;
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
    const cwd = resolve(options.cwd ?? process.cwd());
    const manifest = await readManifest(join(cwd, "package.json"));
    const report = {
      schemaVersion: "1.0",
      manifest: "package.json",
      dependencies: directDependencies(manifest),
    };
    return { exitCode: 0, output: render(report, options.format) };
  } catch (error) {
    return inputFailure(error, options.format);
  }
}

export async function diffDependencies(
  options: DiffOptions,
  dependencies: DiffDependencies = {},
): Promise<DiffResult> {
  try {
    validateBase(options.base);
    const cwd = resolve(options.cwd ?? process.cwd());
    const git = dependencies.git ?? defaultGitRunner;
    const rootOutput = await git.run(["rev-parse", "--show-toplevel"], cwd);
    const repositoryRoot = rootOutput.trim();
    if (!isAbsolute(repositoryRoot)) throw new DiffInputError("Git returned an invalid root path.");

    const commitOutput = await git.run(
      ["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`],
      repositoryRoot,
    );
    const baseCommit = commitOutput.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) {
      throw new DiffInputError("Git returned an invalid base commit.");
    }

    const [baseSource, currentManifest, changedLockfiles] = await Promise.all([
      git.run(
        ["show", "--no-textconv", "--no-ext-diff", `${baseCommit}:package.json`],
        repositoryRoot,
      ),
      readManifest(join(repositoryRoot, "package.json")),
      git.run(
        ["diff", "--name-only", "-z", "--no-ext-diff", baseCommit, "--", ...lockfileNames],
        repositoryRoot,
      ),
    ]);
    const baseManifest = parseManifest(baseSource);
    const changes = compareDirectDependencies(baseManifest, currentManifest);
    const present = await presentLockfiles(repositoryRoot);
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
    const report = {
      schemaVersion: "1.0",
      base: options.base,
      baseCommit,
      manifest: "package.json",
      changes,
      lockfiles: { present, updated: usableUpdates },
      findings,
      verdict,
    };
    return {
      exitCode: options.strict && verdict === "review" ? 1 : 0,
      output: render(report, options.format),
    };
  } catch (error) {
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

async function readManifest(path: string): Promise<ReturnType<typeof packageManifestSchema.parse>> {
  try {
    const pathStats = await lstat(path);
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      throw new DiffInputError("package.json must be a regular non-symlink file.");
    }
  } catch (error) {
    if (error instanceof DiffInputError) throw error;
    throw new DiffInputError("Unable to open package.json.");
  }
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch {
    throw new DiffInputError("Unable to open package.json.");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new DiffInputError("package.json must be a regular file.");
    if (stats.size > maximumManifestBytes)
      throw new DiffInputError("package.json exceeds the 1 MiB limit.");
    const buffer = Buffer.alloc(maximumManifestBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const chunk = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    if (offset > maximumManifestBytes)
      throw new DiffInputError("package.json exceeds the 1 MiB limit.");
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

async function presentLockfiles(repositoryRoot: string): Promise<string[]> {
  const results = await Promise.all(
    lockfileNames.map(async (name) => {
      try {
        const pathStats = await lstat(join(repositoryRoot, name));
        if (!pathStats.isFile() || pathStats.isSymbolicLink()) return undefined;
        const handle = await open(join(repositoryRoot, name), constants.O_RDONLY);
        try {
          return (await handle.stat()).isFile() ? name : undefined;
        } finally {
          await handle.close();
        }
      } catch {
        return undefined;
      }
    }),
  );
  return results.filter((value) => value !== undefined);
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
  const message =
    error instanceof DiffInputError ? error.message : "Dependency diff failed safely.";
  return {
    exitCode: 2,
    output:
      format === "json"
        ? `${JSON.stringify({ error: { code: "invalid_input", message } })}\n`
        : `AgentHawk: ${escapeTerminal(message)}\n`,
  };
}

class DiffInputError extends Error {}

const defaultGitRunner: GitRunner = {
  run: async (args, cwd) =>
    await new Promise<string>((resolveOutput, reject) => {
      const environment = gitEnvironment();
      execFile(
        "git",
        ["-c", "core.pager=cat", "-c", "diff.external=", "--no-pager", ...args],
        {
          cwd,
          encoding: "buffer",
          env: environment,
          maxBuffer: maximumGitOutputBytes,
          timeout: gitTimeoutMilliseconds,
          windowsHide: true,
        },
        (error, stdout) => {
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
