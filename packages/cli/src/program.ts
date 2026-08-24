import { cliErrorReportSchema, initIntegrationSchema } from "@agenthawk/core";
import { Command } from "commander";
import { verifyApprovalFile } from "./approvals.js";
import { type CheckDependencies, checkNpmPackage, type OutputFormat } from "./check.js";
import {
  type CodexProjectHookStatusDependencies,
  statusCodexProjectHook,
} from "./codex-project-hook-status.js";
import { diffDependencies } from "./diff.js";
import { type DoctorDependencies, runDoctor } from "./doctor.js";
import { type InitDependencies, initializeRepository } from "./init.js";
import { validatePolicyFile } from "./policy.js";
import { scanDependencies } from "./scan.js";
import { escapeTerminal } from "./terminal.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

export type ProgramDependencies = CheckDependencies &
  DoctorDependencies &
  InitDependencies &
  CodexProjectHookStatusDependencies & {
    writeError?: (text: string) => void;
    write?: (text: string) => void;
    setExitCode?: (code: number) => void;
  };

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const safeOutput = {
    outputError: (message: string, write: (text: string) => void) =>
      write(`AgentHawk: ${escapeTerminal(message)}`),
    ...(dependencies.writeError ? { writeErr: dependencies.writeError } : {}),
  };
  const program = new Command()
    .name("agenthawk")
    .description("Deterministic dependency admission control for AI coding agents.")
    .version(AGENTHAWK_CLI_VERSION)
    .showSuggestionAfterError()
    .configureOutput(safeOutput);

  const initCommand = program
    .command("init")
    .description(
      "Create deterministic local policy and advisory agent instructions without overwriting files.",
    )
    .option(
      "--integration <integration>",
      "integration: none, codex, claude, cursor, or generic",
      "none",
    )
    .option("--format <format>", "output format: terminal or json", "terminal")
    .configureOutput(safeOutput);
  initCommand.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    const integration = initIntegrationSchema.safeParse(options.integration);
    if (!integration.success) {
      writeInvalidInput(
        "Integration must be none, codex, claude, cursor, or generic.",
        format,
        dependencies,
      );
      return;
    }
    writeResult(
      await initializeRepository({ format, integration: integration.data }, dependencies),
      dependencies,
    );
  });

  const check = program
    .command("check")
    .description("Evaluate a proposed dependency.")
    .configureOutput(safeOutput);
  const npmCheck = check
    .command("npm")
    .description("Evaluate an npm package specification without installing it.")
    .argument("<package-spec>")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .option("--offline", "use cached provider evidence without network access", false)
    .option("--no-cache", "bypass cache reads and writes", false)
    .option("--approvals <path>", "path to a strict AgentHawk approvals YAML file")
    .option("--policy <path>", "path to a strict AgentHawk YAML policy")
    .option("--registry <url>", "npm registry base URL")
    .option("--strict", "return a failing exit code for review or block findings", false)
    .configureOutput(safeOutput);
  npmCheck.action(async (packageSpec: string, options: Record<string, unknown>) => {
    const format = options.format;
    if (format !== "terminal" && format !== "json") {
      (dependencies.write ?? process.stdout.write.bind(process.stdout))(
        "AgentHawk: output format must be terminal or json.\n",
      );
      (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(2);
      return;
    }
    const result = await checkNpmPackage(
      packageSpec,
      {
        ...(typeof options.approvals === "string" ? { approvalsPath: options.approvals } : {}),
        format: format as OutputFormat,
        noCache: options.cache === false,
        offline: options.offline === true,
        ...(typeof options.policy === "string" ? { policyPath: options.policy } : {}),
        ...(typeof options.registry === "string" ? { registryUrl: options.registry } : {}),
        strict: options.strict === true,
      },
      dependencies,
    );
    (dependencies.write ?? process.stdout.write.bind(process.stdout))(result.output);
    (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(result.exitCode);
  });

  const scan = program
    .command("scan")
    .description("Evaluate all direct dependencies without executing repository code.")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .option("--offline", "use cached provider evidence without network access", false)
    .option("--no-cache", "bypass cache reads and writes", false)
    .option("--approvals <path>", "path to a strict AgentHawk approvals YAML file")
    .option("--policy <path>", "path to a strict AgentHawk YAML policy")
    .option("--registry <url>", "npm registry base URL")
    .option("--strict", "return a failing exit code for review or block findings", false)
    .configureOutput(safeOutput);
  scan.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    const result = await scanDependencies(
      {
        ...(typeof options.approvals === "string" ? { approvalsPath: options.approvals } : {}),
        format,
        noCache: options.cache === false,
        offline: options.offline === true,
        ...(typeof options.policy === "string" ? { policyPath: options.policy } : {}),
        ...(typeof options.registry === "string" ? { registryUrl: options.registry } : {}),
        strict: options.strict === true,
      },
      dependencies,
    );
    writeResult(result, dependencies);
  });

  const policy = program
    .command("policy")
    .description("Inspect AgentHawk policy configuration.")
    .configureOutput(safeOutput);
  const policyValidate = policy
    .command("validate")
    .description("Validate a strict AgentHawk policy file without contacting providers.")
    .requiredOption("--file <path>", "path to a strict AgentHawk YAML policy")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .configureOutput(safeOutput);
  policyValidate.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    const result = await validatePolicyFile(String(options.file), { format }, dependencies);
    writeResult(result, dependencies);
  });

  const approvals = program
    .command("approvals")
    .description("Inspect exact AgentHawk approval records.")
    .configureOutput(safeOutput);
  const approvalsVerify = approvals
    .command("verify")
    .description("Verify a strict approvals file without applying an approval.")
    .requiredOption("--file <path>", "path to a strict AgentHawk approvals YAML file")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .configureOutput(safeOutput);
  approvalsVerify.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    const result = await verifyApprovalFile(String(options.file), { format }, dependencies);
    writeResult(result, dependencies);
  });

  const doctor = program
    .command("doctor")
    .description("Check bounded local AgentHawk readiness without contacting providers.")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .configureOutput(safeOutput);
  doctor.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    writeResult(await runDoctor({ format }, dependencies), dependencies);
  });

  const integrations = program
    .command("integrations")
    .description("Inspect native agent integration state.")
    .configureOutput(safeOutput);
  const codexIntegration = integrations
    .command("codex")
    .description("Inspect the Codex project-hook integration.")
    .configureOutput(safeOutput);
  const codexStatus = codexIntegration
    .command("status")
    .description("Observe fixed Codex project-hook state without changing files.")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .configureOutput(safeOutput);
  codexStatus.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    writeResult(await statusCodexProjectHook({ format }, dependencies), dependencies);
  });

  const diff = program
    .command("diff")
    .description("Compare direct dependency changes against a Git base ref.")
    .requiredOption("--base <git-ref>", "Git base ref to compare")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .option("--strict", "return a failing exit code for PG014 review findings", false)
    .configureOutput(safeOutput);
  diff.action(async (options: Record<string, unknown>) => {
    const format = parseOutputFormat(options.format, dependencies);
    if (!format) return;
    const result = await diffDependencies({
      base: String(options.base),
      format,
      strict: options.strict === true,
    });
    writeResult(result, dependencies);
  });

  return program;
}

function parseOutputFormat(
  value: unknown,
  dependencies: ProgramDependencies,
): OutputFormat | undefined {
  if (value === "terminal" || value === "json") return value;
  (dependencies.write ?? process.stdout.write.bind(process.stdout))(
    "AgentHawk: output format must be terminal or json.\n",
  );
  (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(2);
  return undefined;
}

function writeResult(
  result: { exitCode: number; output: string },
  dependencies: ProgramDependencies,
) {
  (dependencies.write ?? process.stdout.write.bind(process.stdout))(result.output);
  (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(result.exitCode);
}

function writeInvalidInput(
  message: string,
  format: OutputFormat,
  dependencies: ProgramDependencies,
): void {
  const output =
    format === "json"
      ? `${JSON.stringify(
          cliErrorReportSchema.parse({
            schemaVersion: "1.0",
            error: { code: "invalid_input", message },
            exitCode: 2,
          }),
        )}\n`
      : `AgentHawk: ${escapeTerminal(message)}\n`;
  (dependencies.write ?? process.stdout.write.bind(process.stdout))(output);
  (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(2);
}
