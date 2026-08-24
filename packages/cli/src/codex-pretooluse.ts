import type { Readable } from "node:stream";
import {
  type AgentAction,
  type AgentDecision,
  agentActionSchema,
  agentDecisionSchema,
  type OperationContext,
  throwIfCancelled,
} from "@agenthawk/core";
import { z } from "zod";
import {
  type ActionEvaluationDependencies,
  createActionDeadline,
  evaluateAgentAction,
  type OwnedActionDeadline,
} from "./action-evaluation.js";
import { readBoundedJsonInput } from "./hook-json.js";
import type { RepositoryAuthority } from "./repository-authority.js";
import { AGENTHAWK_CLI_VERSION } from "./version.js";

export const CODEX_CONTRACT_RELEASE = "rust-v0.149.0";
export const CODEX_EMERGENCY_DENIAL =
  "AgentHawk denied the tool call because security evaluation failed.\n";

const boundedIdentifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{C}/u.test(value));
const boundedPrivatePath = z
  .string()
  .max(4096)
  .refine((value) => !/\p{C}/u.test(value));
const boundedCommand = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 16_384)
  .refine((value) => !value.includes("\u0000"));

export const codexPreToolUseInputSchema = z
  .object({
    agent_id: boundedIdentifier.optional(),
    agent_type: boundedIdentifier.optional(),
    cwd: z.string().min(1).max(4096),
    hook_event_name: z.literal("PreToolUse"),
    model: boundedIdentifier,
    permission_mode: z.enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]),
    session_id: boundedIdentifier,
    tool_input: z.object({ command: boundedCommand }).strict(),
    tool_name: z.literal("Bash"),
    tool_use_id: boundedIdentifier,
    transcript_path: boundedPrivatePath.nullable(),
    turn_id: boundedIdentifier,
  })
  .strict();
export type CodexPreToolUseInput = z.infer<typeof codexPreToolUseInputSchema>;

const codexDenialSchema = z
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

export interface CodexHookDependencies extends ActionEvaluationDependencies {
  readonly createDeadline?: typeof createActionDeadline;
  readonly evaluateAction?: typeof evaluateAgentAction;
  readonly parseProjectLaunchArguments?: (
    arguments_: readonly string[],
  ) => CodexProjectLaunchContext;
  readonly readInput?: typeof readBoundedJsonInput;
  readonly serializeDecision?: typeof serializeCodexPreToolUseDecision;
  readonly verifyProjectInvocation?: (
    authority: RepositoryAuthority,
    context: CodexProjectLaunchContext,
    options?: OperationContext,
  ) => Promise<boolean>;
  readonly writeError: (text: string) => Promise<void> | void;
  readonly writeOutput: (text: string) => Promise<void> | void;
}

export interface CodexProjectLaunchContext {
  readonly deploymentTrust: "project";
  readonly installationId: string;
  readonly rootBinding: string;
}

export function parseCodexPreToolUseInput(input: unknown): CodexPreToolUseInput {
  return codexPreToolUseInputSchema.parse(input);
}

export function translateCodexPreToolUse(
  input: CodexPreToolUseInput,
  deploymentTrust: "project" | "unknown" = "unknown",
): AgentAction {
  return agentActionSchema.parse({
    adapter: {
      id: "codex",
      version: `contract-${CODEX_CONTRACT_RELEASE}/agenthawk-${AGENTHAWK_CLI_VERSION}`,
    },
    deploymentTrust,
    event: "pre_tool_use",
    repositoryRoot: input.cwd,
    schemaVersion: "1.0",
    tool: {
      command: input.tool_input.command,
      dialect: "portable",
      kind: "shell_command",
    },
    workingDirectory: input.cwd,
  });
}

export function serializeCodexPreToolUseDecision(rawDecision: AgentDecision): string {
  const decision = agentDecisionSchema.parse(rawDecision);
  if (decision.outcome === "neutral") return "";
  const output = codexDenialSchema.parse({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `AgentHawk: ${decision.message}`,
    },
  });
  const serialized = `${JSON.stringify(output)}\n`;
  /* v8 ignore next -- every message is a schema-fixed literal and the output schema caps the reason */
  if (Buffer.byteLength(serialized, "utf8") > 8192) throw new Error("Hook output is too large.");
  return serialized;
}

export async function runCodexPreToolUse(
  input: Readable,
  dependencies: CodexHookDependencies,
  launchArguments: readonly string[] = [],
): Promise<number> {
  let deadline: OwnedActionDeadline | undefined;
  try {
    deadline = (dependencies.createDeadline ?? createActionDeadline)();
    const rawInput = await (dependencies.readInput ?? readBoundedJsonInput)(input, deadline.signal);
    const parsed = parseCodexPreToolUseInput(rawInput);
    let authority: RepositoryAuthority | undefined;
    let deploymentTrust: "project" | "unknown" = "unknown";
    if (launchArguments.length > 0) {
      if (
        !dependencies.parseProjectLaunchArguments ||
        !dependencies.verifyProjectInvocation ||
        !dependencies.loadAuthority
      ) {
        throw new Error("Codex project-hook verification is unavailable.");
      }
      const context = dependencies.parseProjectLaunchArguments(launchArguments);
      authority = await dependencies.loadAuthority(parsed.cwd, { signal: deadline.signal });
      if (
        !(await dependencies.verifyProjectInvocation(authority, context, {
          signal: deadline.signal,
        }))
      ) {
        throw new Error("Codex project-hook verification failed.");
      }
      deploymentTrust = "project";
    }
    const action = translateCodexPreToolUse(parsed, deploymentTrust);
    const evaluationDependencies: ActionEvaluationDependencies = authority
      ? {
          ...dependencies,
          loadAuthority: async (actionDirectory, options = {}) => {
            throwIfCancelled(options);
            if (actionDirectory !== authority.repositoryRoot) {
              throw new Error("Codex project authority does not match the action root.");
            }
            return authority;
          },
        }
      : dependencies;
    const decision = await (dependencies.evaluateAction ?? evaluateAgentAction)(
      action,
      deadline,
      evaluationDependencies,
    );
    const output = (dependencies.serializeDecision ?? serializeCodexPreToolUseDecision)(decision);
    if (output.length > 0) {
      await dependencies.writeOutput(output);
    }
    return 0;
  } catch {
    try {
      await dependencies.writeError(CODEX_EMERGENCY_DENIAL);
    } catch {
      // A failed emergency sink cannot safely expose another error channel.
    }
    return 2;
  } finally {
    deadline?.dispose();
  }
}
