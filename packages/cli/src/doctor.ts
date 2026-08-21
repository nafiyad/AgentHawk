import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTHAWK_VERSION,
  agentHawkConfigSchema,
  approvalFileSchema,
  cliErrorReportSchema,
  doctorReportSchema,
  MetadataCache,
} from "@agenthawk/core";
import {
  type CheckResult,
  inspectOptionalRegularFile,
  type OutputFormat,
  readApprovalFile,
  readOptionalPolicyFile,
} from "./check.js";
import { runBoundedGit } from "./diff.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

export interface DoctorOptions {
  format: OutputFormat;
}

export interface DoctorDependencies {
  now?: () => Date;
  cwd?: string;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  cliVersion?: string;
  coreVersion?: string;
  probeCache?: () => Promise<"writable" | "unwritable" | "unsafe">;
  runGit?: () => Promise<string>;
  readPolicy?: (path: string) => Promise<unknown | undefined>;
  readApprovals?: (path: string, required: boolean) => Promise<unknown | undefined>;
  inspectFile?: (path: string) => Promise<"absent" | "present" | "invalid">;
}

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<CheckResult> {
  try {
    const cwd = dependencies.cwd ?? process.cwd();
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const nodeMajor = parseNodeMajor(nodeVersion);
    const operatingSystem = normalizePlatform(dependencies.platform ?? platform());
    const architecture = normalizeArchitecture(dependencies.architecture ?? arch());
    const cliVersion = dependencies.cliVersion ?? AGENTHAWK_CLI_VERSION;
    const coreVersion = dependencies.coreVersion ?? AGENTHAWK_VERSION;
    const cacheState = await safeProbe(
      dependencies.probeCache ?? (async () => await new MetadataCache().probeWritable()),
      "unwritable",
    );
    const gitState = await gitAvailability(
      dependencies.runGit ?? (async () => await runBoundedGit(["--version"], tmpdir())),
    );
    const policy = await configurationState(
      join(cwd, ".agenthawk.yml"),
      dependencies.readPolicy ?? readOptionalPolicyFile,
      (value) => agentHawkConfigSchema.parse(value),
    );
    const approvals = await configurationState(
      join(cwd, ".agenthawk", "approvals.yml"),
      (path) => (dependencies.readApprovals ?? readApprovalFile)(path, false),
      (value) => approvalFileSchema.parse(value),
    );
    const inspect = dependencies.inspectFile ?? inspectOptionalRegularFile;
    const integrations = {
      codex: await integrationState(join(cwd, "AGENTS.md"), inspect),
      claudeCode: await integrationState(join(cwd, "CLAUDE.md"), inspect),
      cursor: await integrationState(join(cwd, ".cursor", "rules", "agenthawk.mdc"), inspect),
      githubActions: await integrationState(
        join(cwd, ".github", "workflows", "agenthawk.yml"),
        inspect,
      ),
    } as const;
    const declaredCompatible = nodeMajor === 22 || nodeMajor === 24;
    const upstreamSupported = declaredCompatible;
    const ciTestedPlatform = operatingSystem !== "other";
    const aligned = cliVersion === coreVersion;
    const ready =
      declaredCompatible &&
      upstreamSupported &&
      ciTestedPlatform &&
      aligned &&
      cacheState === "writable" &&
      policy !== "invalid" &&
      approvals !== "invalid" &&
      gitState === "available" &&
      Object.values(integrations).every((state) => state !== "invalid");
    const report = doctorReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: AGENTHAWK_VERSION,
      command: "doctor",
      checkedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      supportDataAsOf: "2026-08-21",
      ready,
      runtime: {
        nodeVersion: nodeMajor === undefined ? "invalid" : nodeVersion,
        nodeRange: "^22.0.0 || ^24.0.0",
        declaredCompatible,
        upstreamSupported,
        ciTestedPlatform,
        platform: operatingSystem,
        architecture,
      },
      packages: { cliVersion, coreVersion, aligned },
      cache: { state: cacheState },
      configuration: { policy, approvals },
      git: { state: gitState },
      integrations,
      providersContacted: false,
    });
    return {
      exitCode: report.ready ? 0 : 1,
      output: options.format === "json" ? `${JSON.stringify(report)}\n` : renderDoctor(report),
    };
  } catch {
    const message = "Doctor could not safely produce a report.";
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

function parseNodeMajor(version: string): number | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  return match ? Number(match[1]) : undefined;
}

function normalizePlatform(value: NodeJS.Platform): "win32" | "darwin" | "linux" | "other" {
  return value === "win32" || value === "darwin" || value === "linux" ? value : "other";
}

function normalizeArchitecture(value: string): "x64" | "arm64" | "other" {
  return value === "x64" || value === "arm64" ? value : "other";
}

async function safeProbe<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback;
  }
}

async function gitAvailability(run: () => Promise<string>): Promise<"available" | "unavailable"> {
  const output = await safeProbe(run, "");
  return /^git version \d+\.\d+(?:\.\d+)?(?:[. -][0-9A-Za-z.-]+)?\r?\n?$/u.test(output) &&
    Buffer.byteLength(output, "utf8") <= 4_096
    ? "available"
    : "unavailable";
}

async function configurationState(
  path: string,
  read: (path: string) => Promise<unknown | undefined>,
  parse: (value: unknown) => unknown,
): Promise<"absent" | "valid" | "invalid"> {
  try {
    const value = await read(path);
    if (value === undefined) return "absent";
    parse(value);
    return "valid";
  } catch {
    return "invalid";
  }
}

async function integrationState(
  path: string,
  inspect: (path: string) => Promise<"absent" | "present" | "invalid">,
): Promise<"absent" | "present_unverified" | "invalid"> {
  const state = await safeProbe(() => inspect(path), "invalid" as const);
  return state === "present" ? "present_unverified" : state;
}

function renderDoctor(report: ReturnType<typeof doctorReportSchema.parse>): string {
  const status = report.ready ? "READY" : "ATTENTION REQUIRED";
  return [
    `AgentHawk v${AGENTHAWK_VERSION}`,
    "",
    `Doctor: ${status}`,
    `Node: ${report.runtime.nodeVersion} (${report.runtime.declaredCompatible ? "compatible" : "unsupported"})`,
    `Packages: ${report.packages.aligned ? "aligned" : "mismatched"}`,
    `Cache: ${report.cache.state}`,
    `Git: ${report.git.state}`,
    `Policy: ${report.configuration.policy}`,
    `Approvals: ${report.configuration.approvals}`,
    "",
    "Integration files are presence-only and do not prove enforcement.",
    "No provider was contacted.",
    "",
  ].join("\n");
}
