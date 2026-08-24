import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { type AgentDecision, agentDecisionSchema } from "@agenthawk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CONTRACT_RELEASE,
  CLAUDE_EMERGENCY_DENIAL,
  claudePreToolUseInputSchema,
  parseClaudePreToolUseInput,
  runClaudePreToolUse,
  serializeClaudePreToolUseDecision,
  translateClaudePreToolUse,
} from "../src/claude-pretooluse.js";

const fixtureDirectory = resolve("packages/cli/test/fixtures/claude/v2.1.241");
const bashFixture = JSON.parse(
  await readFile(resolve(fixtureDirectory, "pre-tool-use-bash.json"), "utf8"),
);
const powershellFixture = JSON.parse(
  await readFile(resolve(fixtureDirectory, "pre-tool-use-powershell.json"), "utf8"),
);
const fixtureRoot = resolve("claude-hook-fixture");

afterEach(() => vi.useRealTimers());

describe("Claude Code PreToolUse contract", () => {
  it("pins the reviewed release and strips every private framing field", () => {
    const action = translateClaudePreToolUse(
      parseClaudePreToolUseInput({
        ...bashFixture,
        agent_id: "agent-private",
        agent_type: "worker-private",
        cwd: fixtureRoot,
        prompt_id: "prompt-private",
      }),
    );
    expect(CLAUDE_CONTRACT_RELEASE).toBe("v2.1.241");
    expect(action).toEqual({
      adapter: { id: "claude_code", version: expect.stringContaining("v2.1.241/") },
      deploymentTrust: "unknown",
      event: "pre_tool_use",
      repositoryRoot: fixtureRoot,
      schemaVersion: "1.0",
      tool: { command: "npm add example@1.0.0", dialect: "posix", kind: "shell_command" },
      workingDirectory: fixtureRoot,
    });
    expect(JSON.stringify(action)).not.toMatch(/private|description|session-fixture|transcript/u);
  });

  it("maps the canonical tools to distinct authenticated dialects", () => {
    const bash = translateClaudePreToolUse(
      parseClaudePreToolUseInput({ ...bashFixture, cwd: fixtureRoot }),
    );
    const powershell = translateClaudePreToolUse(
      parseClaudePreToolUseInput({ ...powershellFixture, cwd: fixtureRoot }),
    );
    expect(bash.tool.dialect).toBe("posix");
    expect(powershell.tool.dialect).toBe("powershell");
  });

  it.each([
    ["array root", []],
    ["unknown top-level field", { ...bashFixture, extra: true }],
    ["wrong event", { ...bashFixture, hook_event_name: "PostToolUse" }],
    ["unknown tool", { ...bashFixture, tool_name: "Shell" }],
    ["unknown effort field", { ...bashFixture, effort: { level: "high", extra: true } }],
    ["invalid effort level", { ...bashFixture, effort: { level: "unbounded" } }],
    ["unknown tool field", { ...bashFixture, tool_input: { command: "git status", extra: true } }],
    ["invalid timeout", { ...bashFixture, tool_input: { command: "git status", timeout: 0 } }],
    ["relative cwd", { ...bashFixture, cwd: "relative" }],
    ["control transcript", { ...bashFixture, transcript_path: "private\npath" }],
    ["empty identifier", { ...bashFixture, session_id: "" }],
    ["oversized identifier", { ...bashFixture, tool_use_id: "x".repeat(257) }],
    ["oversized UTF-8 command", { ...bashFixture, tool_input: { command: "é".repeat(8193) } }],
  ])("rejects %s", (_label, value) => {
    expect(() => translateClaudePreToolUse(claudePreToolUseInputSchema.parse(value))).toThrow();
  });

  it("requires every release-pinned framing field", () => {
    for (const field of [
      "cwd",
      "hook_event_name",
      "permission_mode",
      "session_id",
      "tool_input",
      "tool_name",
      "tool_use_id",
      "transcript_path",
    ]) {
      const candidate = { ...bashFixture };
      delete candidate[field];
      expect(claudePreToolUseInputSchema.safeParse(candidate).success, field).toBe(false);
    }
  });
});

describe("Claude Code PreToolUse output", () => {
  it("serializes neutral as exactly zero stdout bytes", () => {
    expect(serializeClaudePreToolUseDecision(decision("unrelated"))).toBe("");
  });

  it("matches the pinned deny-only fixture", async () => {
    const expected = await readFile(resolve(fixtureDirectory, "deny-output.json"), "utf8");
    const output = serializeClaudePreToolUseDecision(decision("dependency_review"));
    expect(output).toBe(`${JSON.stringify(JSON.parse(expected))}\n`);
    expect(output).not.toMatch(
      /"(?:allow|ask|defer)"|updatedInput|additionalContext|systemMessage/u,
    );
  });

  it("keeps unrelated Bash commands silent without provider or authority access", async () => {
    const stdout: string[] = [];
    const exitCode = await runClaudePreToolUse(stream("git status"), {
      loadAuthority: async () => {
        throw new Error("authority must not run");
      },
      writeError: () => undefined,
      writeOutput: (text) => {
        stdout.push(text);
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toEqual([]);
  });

  it.each(["git status", "npm add example@1.0.0"])(
    "denies every PowerShell command without loading providers: %s",
    async (command) => {
      const stdout: string[] = [];
      const exitCode = await runClaudePreToolUse(
        Readable.from([
          JSON.stringify({
            ...powershellFixture,
            cwd: fixtureRoot,
            tool_input: { command },
          }),
        ]),
        {
          loadAuthority: async () => {
            throw new Error("authority must not run");
          },
          writeError: () => undefined,
          writeOutput: (text) => {
            stdout.push(text);
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    },
  );

  it.each([
    ["malformed input", { source: "not-json" }],
    ["duplicate input", { source: '{"cwd":"a","cwd":"b"}' }],
    ["trailing input", { source: `${JSON.stringify(payload("git status"))} true` }],
    [
      "evaluator escape",
      {
        evaluateAction: async () => {
          throw new Error("private command");
        },
      },
    ],
    [
      "serializer failure",
      {
        serializeDecision: () => {
          throw new Error("private");
        },
      },
    ],
    [
      "output failure",
      {
        evaluateAction: async () => decision("dependency_review"),
        writeOutput: async () => {
          throw new Error("private sink");
        },
      },
    ],
  ])("uses only the constant emergency denial for %s", async (_label, overrides) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source =
      "source" in overrides ? overrides.source : JSON.stringify(payload("npm add private"));
    const exitCode = await runClaudePreToolUse(Readable.from([source]), {
      evaluateAction: async () => decision("dependency_review"),
      serializeDecision: serializeClaudePreToolUseDecision,
      writeError: (text) => {
        stderr.push(text);
      },
      writeOutput: (text) => {
        stdout.push(text);
      },
      ...overrides,
    });
    expect(exitCode).toBe(2);
    expect(stderr).toEqual([CLAUDE_EMERGENCY_DENIAL]);
    expect(stderr.join("")).not.toMatch(/private|npm add/u);
    if (_label !== "output failure") expect(stdout).toEqual([]);
  });

  it("creates the deadline before reading input and disposes it after output", async () => {
    const order: string[] = [];
    const exitCode = await runClaudePreToolUse(stream("git status"), {
      createDeadline: () => ({
        deadlineAtNanoseconds: 2n,
        dispose: () => {
          order.push("dispose");
        },
        signal: new AbortController().signal,
        startedAtNanoseconds: 1n,
      }),
      evaluateAction: async () => decision("unrelated"),
      readInput: async () => {
        order.push("read");
        return payload("git status");
      },
      writeError: () => undefined,
      writeOutput: () => {
        order.push("write");
      },
    });
    expect(exitCode).toBe(0);
    expect(order).toEqual(["read", "dispose"]);
  });

  it("cancels stalled stdin at the owned deadline", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const stderr: string[] = [];
    const pending = runClaudePreToolUse(input, {
      writeError: (text) => {
        stderr.push(text);
      },
      writeOutput: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toBe(2);
    expect(input.destroyed).toBe(true);
    expect(stderr).toEqual([CLAUDE_EMERGENCY_DENIAL]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function payload(command: string) {
  return { ...bashFixture, cwd: fixtureRoot, tool_input: { command } };
}

function stream(command: string): Readable {
  return Readable.from([JSON.stringify(payload(command))]);
}

function decision(reason: "dependency_review" | "unrelated"): AgentDecision {
  const base = {
    adapter: { id: "claude_code", version: "v2.1.241/0.1.0-alpha.1" },
    deploymentTrust: "unknown",
    schemaVersion: "1.0",
  } as const;
  return agentDecisionSchema.parse(
    reason === "unrelated"
      ? {
          ...base,
          message: "The action is outside dependency admission scope.",
          outcome: "neutral",
          reasonCode: "unrelated",
        }
      : {
          ...base,
          approvalApplied: false,
          message: "Dependency policy evaluation requires review.",
          originalVerdict: "review",
          outcome: "deny",
          reasonCode: "dependency_review",
          reportDigest: `sha256:${"a".repeat(64)}`,
          verdict: "review",
        },
  );
}
