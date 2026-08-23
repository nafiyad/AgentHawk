import { describe, expect, it } from "vitest";
import { agentActionSchema, agentDecisionSchema, serializeAgentDecision } from "../src/index.js";

const adapter = { id: "codex", version: "0.1.0-alpha.1" } as const;
const digest = `sha256:${"a".repeat(64)}`;

const action = {
  schemaVersion: "1.0",
  adapter,
  deploymentTrust: "unknown",
  event: "pre_tool_use",
  repositoryRoot: "/workspace/project",
  workingDirectory: "/workspace/project",
  tool: { kind: "shell_command", dialect: "posix", command: "npm add zod@4.4.3" },
} as const;

describe("agent action contract", () => {
  it("accepts the exact bounded v1 envelope", () => {
    expect(agentActionSchema.parse(action)).toEqual(action);
    expect(
      agentActionSchema.parse({ ...action, tool: { ...action.tool, dialect: "portable" } }).tool
        .dialect,
    ).toBe("portable");
  });

  it.each([
    [{ ...action, schemaVersion: "1.1" }],
    [{ ...action, deploymentTrust: "trusted" }],
    [{ ...action, prompt: "secret" }],
    [{ ...action, workingDirectory: "/workspace/project/packages/a" }],
    [{ ...action, adapter: { ...adapter, sessionId: "session" } }],
    [{ ...action, tool: { ...action.tool, environment: { TOKEN: "secret" } } }],
    [{ ...action, tool: { ...action.tool, command: `npm add ${"a".repeat(16_384)}` } }],
    [
      {
        ...action,
        repositoryRoot: `/${"a".repeat(4096)}`,
        workingDirectory: `/${"a".repeat(4096)}`,
      },
    ],
  ])("rejects an unknown, inconsistent, or over-limit envelope", (input) => {
    expect(() => agentActionSchema.parse(input)).toThrow();
  });

  it("rejects path controls and command NULs", () => {
    expect(() => agentActionSchema.parse({ ...action, repositoryRoot: "/work\nspace" })).toThrow();
    expect(() =>
      agentActionSchema.parse({
        ...action,
        tool: { ...action.tool, command: "npm\u0000 add zod" },
      }),
    ).toThrow();
  });

  it("enforces the command limit in UTF-8 bytes", () => {
    const atLimit = "é".repeat(8192);
    expect(
      agentActionSchema.parse({ ...action, tool: { ...action.tool, command: atLimit } }).tool
        .command,
    ).toBe(atLimit);
    expect(() =>
      agentActionSchema.parse({ ...action, tool: { ...action.tool, command: "é".repeat(8193) } }),
    ).toThrow();
  });
});

describe("agent decision contract", () => {
  const common = {
    schemaVersion: "1.0",
    adapter,
    deploymentTrust: "unknown",
  } as const;

  it.each([
    {
      ...common,
      outcome: "neutral",
      reasonCode: "unrelated",
      message: "The action is outside dependency admission scope.",
    },
    {
      ...common,
      outcome: "neutral",
      reasonCode: "dependency_allowed",
      message: "Dependency policy evaluation allowed the request.",
      verdict: "allow",
      originalVerdict: "allow",
      approvalApplied: false,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "warning_requires_review",
      message: "A dependency warning requires review on this adapter.",
      verdict: "warn",
      originalVerdict: "review",
      approvalApplied: true,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "internal_error",
      message: "The security evaluation failed internally.",
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "dependency_blocked",
      message: "Dependency policy evaluation blocked the request.",
      verdict: "block",
      originalVerdict: "block",
      approvalApplied: true,
      reportDigest: digest,
    },
  ])("accepts a legal decision variant", (decision) => {
    expect(agentDecisionSchema.parse(decision)).toEqual(decision);
  });

  it.each([
    {
      ...common,
      outcome: "neutral",
      reasonCode: "dependency_blocked",
      message: "Dependency policy evaluation blocked the request.",
      verdict: "block",
      originalVerdict: "block",
      approvalApplied: false,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "neutral",
      reasonCode: "unrelated",
      message: "The action is outside dependency admission scope.",
      verdict: "allow",
    },
    {
      ...common,
      outcome: "neutral",
      reasonCode: "dependency_allowed",
      message: "Dependency policy evaluation allowed the request.",
      verdict: "allow",
      originalVerdict: "review",
      approvalApplied: false,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "neutral",
      reasonCode: "dependency_allowed",
      message: "Dependency policy evaluation allowed the request.",
      verdict: "allow",
      originalVerdict: "block",
      approvalApplied: true,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "internal_error",
      message: "leaked exception",
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "dependency_review",
      message: "Dependency policy evaluation requires review.",
      verdict: "review",
      originalVerdict: "allow",
      approvalApplied: true,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "dependency_blocked",
      message: "Dependency policy evaluation blocked the request.",
      verdict: "block",
      originalVerdict: "allow",
      approvalApplied: true,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "neutral",
      reasonCode: "dependency_allowed",
      message: "Dependency policy evaluation allowed the request.",
      verdict: "allow",
      originalVerdict: "warn",
      approvalApplied: true,
      reportDigest: digest,
    },
    {
      ...common,
      outcome: "deny",
      reasonCode: "evaluation_error",
      message: "Dependency policy evaluation could not complete safely.",
      verdict: "error",
      originalVerdict: "error",
      approvalApplied: true,
      reportDigest: digest,
    },
  ])("rejects a contradictory or caller-authored decision", (decision) => {
    expect(() => agentDecisionSchema.parse(decision)).toThrow();
  });

  it("enforces the complete production approval transition matrix", () => {
    const verdicts = ["allow", "warn", "review", "block", "error"] as const;
    const variants = {
      allow: ["neutral", "dependency_allowed", "Dependency policy evaluation allowed the request."],
      warn: [
        "neutral",
        "dependency_warning",
        "Dependency policy evaluation produced a visible warning.",
      ],
      review: ["deny", "dependency_review", "Dependency policy evaluation requires review."],
      block: ["deny", "dependency_blocked", "Dependency policy evaluation blocked the request."],
      error: [
        "deny",
        "evaluation_error",
        "Dependency policy evaluation could not complete safely.",
      ],
    } as const;

    for (const originalVerdict of verdicts) {
      for (const verdict of verdicts) {
        for (const approvalApplied of [false, true]) {
          const [outcome, reasonCode, message] = variants[verdict];
          const expected = approvalApplied
            ? (originalVerdict === "review" &&
                (verdict === "allow" || verdict === "warn" || verdict === "review")) ||
              (originalVerdict === "block" && verdict === "block")
            : originalVerdict === verdict;
          expect(
            agentDecisionSchema.safeParse({
              ...common,
              outcome,
              reasonCode,
              message,
              verdict,
              originalVerdict,
              approvalApplied,
              reportDigest: digest,
            }).success,
            `${originalVerdict} -> ${verdict}, approvalApplied=${approvalApplied}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("serializes deterministic bounded JSON with one newline", () => {
    const decision = agentDecisionSchema.parse({
      ...common,
      outcome: "neutral",
      reasonCode: "unrelated",
      message: "The action is outside dependency admission scope.",
    });
    const serialized = serializeAgentDecision(decision);
    expect(serialized).toBe(`${JSON.stringify(decision)}\n`);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8192);
    expect(serialized).not.toContain("/workspace");
    expect(serialized).not.toContain("npm add");
  });
});
