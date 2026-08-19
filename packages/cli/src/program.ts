import { Command } from "commander";

export function createProgram(): Command {
  return new Command()
    .name("agenthawk")
    .description("Deterministic dependency admission control for AI coding agents.")
    .version("0.0.0")
    .showSuggestionAfterError()
    .configureOutput({
      outputError: (message, write) => write(`AgentHawk: ${message}`),
    });
}
