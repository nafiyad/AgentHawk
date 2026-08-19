import { Command } from "commander";
import { type CheckDependencies, checkNpmPackage, type OutputFormat } from "./check.js";
import { escapeTerminal } from "./terminal.js";

export interface ProgramDependencies extends CheckDependencies {
  writeError?: (text: string) => void;
  write?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const safeOutput = {
    outputError: (message: string, write: (text: string) => void) =>
      write(`AgentHawk: ${escapeTerminal(message)}`),
    ...(dependencies.writeError ? { writeErr: dependencies.writeError } : {}),
  };
  const program = new Command()
    .name("agenthawk")
    .description("Deterministic dependency admission control for AI coding agents.")
    .version("0.0.0")
    .showSuggestionAfterError()
    .configureOutput(safeOutput);

  const check = program
    .command("check")
    .description("Evaluate a proposed dependency.")
    .configureOutput(safeOutput);
  const npmCheck = check
    .command("npm")
    .description("Evaluate an npm package specification without installing it.")
    .argument("<package-spec>")
    .option("--format <format>", "output format: terminal or json", "terminal")
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
        format: format as OutputFormat,
        ...(typeof options.policy === "string" ? { policyPath: options.policy } : {}),
        ...(typeof options.registry === "string" ? { registryUrl: options.registry } : {}),
        strict: options.strict === true,
      },
      dependencies,
    );
    (dependencies.write ?? process.stdout.write.bind(process.stdout))(result.output);
    (dependencies.setExitCode ?? ((code) => (process.exitCode = code)))(result.exitCode);
  });

  return program;
}
