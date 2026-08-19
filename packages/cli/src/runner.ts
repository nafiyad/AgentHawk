import { cliErrorReportSchema } from "@agenthawk/core";
import type { Command } from "commander";
import type { ProgramDependencies } from "./program.js";
import { createProgram } from "./program.js";

export async function runCli(
  argv: readonly string[],
  dependencies: ProgramDependencies = {},
): Promise<void> {
  const json = requestsJson(argv);
  const write = dependencies.write ?? process.stdout.write.bind(process.stdout);
  const setExitCode = dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));
  const program = createProgram({
    ...dependencies,
    ...(json ? { writeError: () => undefined } : {}),
    setExitCode,
    write,
  });
  if (json) overrideExits(program);
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (!json) throw error;
    write(
      `${JSON.stringify(
        cliErrorReportSchema.parse({
          schemaVersion: "1.0",
          error: { code: "invalid_input", message: "Command-line arguments are invalid." },
          exitCode: 2,
        }),
      )}\n`,
    );
    setExitCode(2);
  }
}

function overrideExits(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) overrideExits(child);
}

function requestsJson(argv: readonly string[]): boolean {
  return argv.some(
    (value, index) =>
      value === "--format=json" || (value === "--format" && argv[index + 1] === "json"),
  );
}
