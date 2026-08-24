import type { Readable } from "node:stream";
import {
  type AgentAction,
  type AgentDecision,
  agentActionSchema,
  agentDecisionSchema,
} from "@agenthawk/core";
import { z } from "zod";
import {
  type ActionEvaluationDependencies,
  createActionDeadline,
  evaluateAgentAction,
  type OwnedActionDeadline,
} from "./action-evaluation.js";
import { readBoundedJsonInput } from "./hook-json.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

export const CLAUDE_CONTRACT_RELEASE = "v2.1.241";
export const CLAUDE_EMERGENCY_DENIAL =
  "AgentHawk denied the tool call because security evaluation failed.\n";

const boundedIdentifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{C}/u.test(value));
const boundedPrivateText = z
  .string()
  .max(4096)
  .refine((value) => !/\p{C}/u.test(value));
const boundedCommand = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 16_384)
  .refine((value) => !value.includes("\u0000"));
const permissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
const effort = z.object({ level: z.enum(["low", "medium", "high", "xhigh", "max"]) }).strict();
const toolInput = z
  .object({
    command: boundedCommand,
    description: boundedPrivateText.optional(),
    run_in_background: z.boolean().optional(),
    timeout: z.number().int().positive().max(600_000).optional(),
  })
  .strict();

export const claudePreToolUseInputSchema = z
  .object({
    agent_id: boundedIdentifier.optional(),
    agent_type: boundedIdentifier.optional(),
    cwd: z.string().min(1).max(4096),
    effort: effort.optional(),
    hook_event_name: z.literal("PreToolUse"),
    permission_mode: permissionMode,
    prompt_id: boundedIdentifier.optional(),
    session_id: boundedIdentifier,
    tool_input: toolInput,
    tool_name: z.enum(["Bash", "PowerShell"]),
    tool_use_id: boundedIdentifier,
    transcript_path: boundedPrivateText,
  })
  .strict();
export type ClaudePreToolUseInput = z.infer<typeof claudePreToolUseInputSchema>;

const claudeDenialSchema = z
  .object({
    hookSpecificOutput: z
      .object({
        hookEventName: z.literal("PreToolUse"),
        permissionDecision: z.literal("deny"),
        permissionDecisionReason: z.string().min(1).max(512),
      })
      .strict(),
  })
  .strict();

export interface ClaudeHookDependencies extends ActionEvaluationDependencies {
  readonly createDeadline?: typeof createActionDeadline;
  readonly evaluateAction?: typeof evaluateAgentAction;
  readonly readInput?: typeof readBoundedJsonInput;
  readonly serializeDecision?: typeof serializeClaudePreToolUseDecision;
  readonly writeError: (text: string) => Promise<void> | void;
  readonly writeOutput: (text: string) => Promise<void> | void;
}

export function parseClaudePreToolUseInput(input: unknown): ClaudePreToolUseInput {
  return claudePreToolUseInputSchema.parse(input);
}

export function translateClaudePreToolUse(input: ClaudePreToolUseInput): AgentAction {
  return agentActionSchema.parse({
    adapter: {
      id: "claude_code",
      version: `contract-${CLAUDE_CONTRACT_RELEASE}/agenthawk-${AGENTHAWK_CLI_VERSION}`,
    },
    deploymentTrust: "unknown",
    event: "pre_tool_use",
    repositoryRoot: input.cwd,
    schemaVersion: "1.0",
    tool: {
      command: input.tool_input.command,
      dialect: input.tool_name === "Bash" ? "posix" : "powershell",
      kind: "shell_command",
    },
    workingDirectory: input.cwd,
  });
}

export function serializeClaudePreToolUseDecision(rawDecision: AgentDecision): string {
  const decision = agentDecisionSchema.parse(rawDecision);
  if (decision.outcome === "neutral") return "";
  const output = claudeDenialSchema.parse({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `AgentHawk: ${decision.message}`,
    },
  });
  const serialized = `${JSON.stringify(output)}\n`;
  /* v8 ignore next -- fixed decision messages and the output schema bound the result */
  if (Buffer.byteLength(serialized, "utf8") > 8192) throw new Error("Hook output is too large.");
  return serialized;
}

export async function runClaudePreToolUse(
  input: Readable,
  dependencies: ClaudeHookDependencies,
): Promise<number> {
  let deadline: OwnedActionDeadline | undefined;
  try {
    deadline = (dependencies.createDeadline ?? createActionDeadline)();
    const rawInput = await (dependencies.readInput ?? readBoundedJsonInput)(input, deadline.signal);
    const action = translateClaudePreToolUse(parseClaudePreToolUseInput(rawInput));
    const decision = await (dependencies.evaluateAction ?? evaluateAgentAction)(
      action,
      deadline,
      dependencies,
    );
    const output = (dependencies.serializeDecision ?? serializeClaudePreToolUseDecision)(decision);
    if (output.length > 0) await dependencies.writeOutput(output);
    return 0;
  } catch {
    try {
      await dependencies.writeError(CLAUDE_EMERGENCY_DENIAL);
    } catch {
      // A failed emergency sink cannot safely expose another error channel.
    }
    return 2;
  } finally {
    deadline?.dispose();
  }
}
