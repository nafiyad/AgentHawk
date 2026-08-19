import { Command } from "commander";
import { type CheckDependencies, checkNpmPackage, type OutputFormat } from "./check.js";

export interface ProgramDependencies extends CheckDependencies {
  write?: (text: string) => void;
  setExitCode?: (code: number) => void;
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const program = new Command()
    .name("agenthawk")
    .description("Deterministic dependency admission control for AI coding agents.")
    .version("0.0.0")
    .showSuggestionAfterError()
    .configureOutput({
      outputError: (message, write) => write(`AgentHawk: ${message}`),
    });

  const check = program.command("check").description("Evaluate a proposed dependency.");
  check
    .command("npm")
    .description("Evaluate an npm package specification without installing it.")
    .argument("<package-spec>")
    .option("--format <format>", "output format: terminal or json", "terminal")
    .option("--policy <path>", "path to a strict AgentHawk YAML policy")
    .option("--registry <url>", "npm registry base URL")
    .option("--strict", "return a failing exit code for review or block findings", false)
    .action(async (packageSpec: string, options: Record<string, unknown>) => {
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
