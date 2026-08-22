import { isAbsolute } from "node:path";
import { z } from "zod";

export const adapterIdSchema = z.enum(["codex", "claude_code", "cursor", "github_copilot"]);
export type AdapterId = z.infer<typeof adapterIdSchema>;

export const deploymentTrustSchema = z.enum(["project", "user", "managed", "unknown"]);
export type DeploymentTrust = z.infer<typeof deploymentTrustSchema>;

export const shellDialectSchema = z.enum(["posix", "powershell"]);
export type ShellDialect = z.infer<typeof shellDialectSchema>;

const printableAscii = /^[\x20-\x7e]+$/u;
const boundedPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isAbsolute, { message: "Path must be absolute." })
  .refine((value) => !/\p{C}/u.test(value), {
    message: "Path contains a control character.",
  });

export const agentAdapterSchema = z
  .object({
    id: adapterIdSchema,
    version: z.string().min(1).max(128).regex(printableAscii),
  })
  .strict();
export type AgentAdapter = z.infer<typeof agentAdapterSchema>;

export const agentActionSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    adapter: agentAdapterSchema,
    deploymentTrust: deploymentTrustSchema,
    event: z.literal("pre_tool_use"),
    repositoryRoot: boundedPathSchema,
    workingDirectory: boundedPathSchema,
    tool: z
      .object({
        kind: z.literal("shell_command"),
        dialect: shellDialectSchema,
        command: z
          .string()
          .min(1)
          .max(16_384)
          .refine((value) => Buffer.byteLength(value, "utf8") <= 16_384, {
            message: "Command exceeds the 16384-byte UTF-8 limit.",
          })
          .refine((value) => !value.includes("\u0000"), {
            message: "Command contains a NUL character.",
          }),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.repositoryRoot === value.workingDirectory, {
    message:
      "The initial hook contract requires the action directory to equal the repository root.",
    path: ["workingDirectory"],
  });
export type AgentAction = z.infer<typeof agentActionSchema>;

export const decisionReasonCodeSchema = z.enum([
  "unrelated",
  "dependency_allowed",
  "dependency_warning",
  "warning_requires_review",
  "dependency_review",
  "dependency_blocked",
  "evaluation_error",
  "invalid_action",
  "unsupported_dependency_action",
  "ephemeral_execution_denied",
  "repository_identity_error",
  "configuration_error",
  "deadline_exceeded",
  "internal_error",
]);
export type DecisionReasonCode = z.infer<typeof decisionReasonCodeSchema>;

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const verdictSchema = z.enum(["allow", "warn", "review", "block", "error"]);

const decisionBase = {
  schemaVersion: z.literal("1.0"),
  adapter: agentAdapterSchema,
  deploymentTrust: deploymentTrustSchema,
};

const fixedDecision = <
  Reason extends DecisionReasonCode,
  Outcome extends "neutral" | "deny",
  Message extends string,
>(
  reasonCode: Reason,
  outcome: Outcome,
  message: Message,
) =>
  z
    .object({
      ...decisionBase,
      outcome: z.literal(outcome),
      reasonCode: z.literal(reasonCode),
      message: z.literal(message),
    })
    .strict();

const evaluatedDecision = <
  Reason extends DecisionReasonCode,
  Outcome extends "neutral" | "deny",
  Verdict extends "allow" | "warn" | "review" | "block" | "error",
  Message extends string,
>(
  reasonCode: Reason,
  outcome: Outcome,
  verdict: Verdict,
  message: Message,
) =>
  z
    .object({
      ...decisionBase,
      outcome: z.literal(outcome),
      reasonCode: z.literal(reasonCode),
      message: z.literal(message),
      verdict: z.literal(verdict),
      originalVerdict: verdictSchema,
      approvalApplied: z.boolean(),
      reportDigest: digestSchema,
    })
    .strict()
    .superRefine((value, context) => {
      const validApprovalTransition = value.approvalApplied
        ? (value.originalVerdict === "review" &&
            (value.verdict === "allow" ||
              value.verdict === "warn" ||
              value.verdict === "review")) ||
          (value.originalVerdict === "block" && value.verdict === "block")
        : value.originalVerdict === value.verdict;
      if (!validApprovalTransition) {
        context.addIssue({
          code: "custom",
          message: "The approval state is inconsistent with the original and final verdicts.",
          path: ["originalVerdict"],
        });
      }
    });

export const agentDecisionSchema = z.union([
  fixedDecision("unrelated", "neutral", "The action is outside dependency admission scope."),
  evaluatedDecision(
    "dependency_allowed",
    "neutral",
    "allow",
    "Dependency policy evaluation allowed the request.",
  ),
  evaluatedDecision(
    "dependency_warning",
    "neutral",
    "warn",
    "Dependency policy evaluation produced a visible warning.",
  ),
  evaluatedDecision(
    "warning_requires_review",
    "deny",
    "warn",
    "A dependency warning requires review on this adapter.",
  ),
  evaluatedDecision(
    "dependency_review",
    "deny",
    "review",
    "Dependency policy evaluation requires review.",
  ),
  evaluatedDecision(
    "dependency_blocked",
    "deny",
    "block",
    "Dependency policy evaluation blocked the request.",
  ),
  evaluatedDecision(
    "evaluation_error",
    "deny",
    "error",
    "Dependency policy evaluation could not complete safely.",
  ),
  fixedDecision("invalid_action", "deny", "The action input is invalid."),
  fixedDecision(
    "unsupported_dependency_action",
    "deny",
    "The dependency-like action is not supported by this contract.",
  ),
  fixedDecision(
    "ephemeral_execution_denied",
    "deny",
    "Ephemeral package execution is not supported by this contract.",
  ),
  fixedDecision(
    "repository_identity_error",
    "deny",
    "A consistent repository identity could not be established.",
  ),
  fixedDecision("configuration_error", "deny", "Required security configuration is invalid."),
  fixedDecision("deadline_exceeded", "deny", "The security evaluation deadline expired."),
  fixedDecision("internal_error", "deny", "The security evaluation failed internally."),
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export function serializeAgentDecision(input: AgentDecision): string {
  const decision = agentDecisionSchema.parse(input);
  const serialized = `${JSON.stringify(decision)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 8192) {
    throw new Error("Agent decision exceeds the 8192-byte output limit.");
  }
  return serialized;
}
