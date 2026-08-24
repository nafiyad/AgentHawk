import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  type AgentDecision,
  agentDecisionSchema,
  agentHawkConfigSchema,
  OperationCancelledError,
} from "@agenthawk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_CONTRACT_RELEASE,
  CODEX_EMERGENCY_DENIAL,
  codexPreToolUseInputSchema,
  parseCodexPreToolUseInput,
  runCodexPreToolUse,
  serializeCodexPreToolUseDecision,
  translateCodexPreToolUse,
} from "../src/codex-pretooluse.js";
import { parseCodexProjectHookLaunchArguments } from "../src/codex-project-hook-format.js";
import type { RepositoryAuthority } from "../src/repository-authority.js";

const fixtureDirectory = resolve("packages/cli/test/fixtures/codex/v0.149.0");
const fixture = JSON.parse(
  await readFile(resolve(fixtureDirectory, "pre-tool-use-bash.json"), "utf8"),
);
const fixtureRoot = resolve("codex-hook-fixture");

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex PreToolUse contract", () => {
  it("pins the reviewed release and strips private host fields during translation", () => {
    const parsed = parseCodexPreToolUseInput({
      ...fixture,
      agent_id: "agent-fixture",
      agent_type: "worker",
      cwd: fixtureRoot,
      transcript_path: `${fixtureRoot}/private-transcript.jsonl`,
    });
    const action = translateCodexPreToolUse(parsed);
    expect(CODEX_CONTRACT_RELEASE).toBe("rust-v0.149.0");
    expect(action).toEqual({
      adapter: { id: "codex", version: expect.stringContaining("rust-v0.149.0/") },
      deploymentTrust: "unknown",
      event: "pre_tool_use",
      repositoryRoot: fixtureRoot,
      schemaVersion: "1.0",
      tool: { command: "npm add example@1.0.0", dialect: "portable", kind: "shell_command" },
      workingDirectory: fixtureRoot,
    });
    expect(JSON.stringify(action)).not.toContain("session-fixture");
    expect(JSON.stringify(action)).not.toContain("turn-fixture");
    expect(JSON.stringify(action)).not.toContain("private-transcript");
  });

  it("records a restricted portable grammar instead of inferring a host dialect", () => {
    const action = translateCodexPreToolUse(
      parseCodexPreToolUseInput({ ...fixture, cwd: fixtureRoot }),
    );
    expect(action.tool.dialect).toBe("portable");
  });

  it.each([
    ["array root", []],
    ["scalar root", "value"],
    ["unknown top-level field", { ...fixture, extra: true }],
    ["wrong event", { ...fixture, hook_event_name: "PostToolUse" }],
    ["wrong tool", { ...fixture, tool_name: "apply_patch" }],
    ["invalid permission mode", { ...fixture, permission_mode: "force" }],
    ["unknown tool field", { ...fixture, tool_input: { command: "git status", extra: true } }],
    ["non-object tool input", { ...fixture, tool_input: "git status" }],
    ["relative cwd", { ...fixture, cwd: "relative" }],
    ["control-bearing cwd", { ...fixture, cwd: `${fixtureRoot}\nprivate` }],
    ["control-bearing transcript", { ...fixture, transcript_path: "private\npath" }],
    ["empty identifier", { ...fixture, session_id: "" }],
    ["oversized identifier", { ...fixture, tool_use_id: "x".repeat(257) }],
    ["oversized UTF-8 command", { ...fixture, tool_input: { command: "é".repeat(8193) } }],
  ])("rejects %s", (_label, value) => {
    expect(() => translateCodexPreToolUse(codexPreToolUseInputSchema.parse(value))).toThrow();
  });

  it("requires every release-pinned field", () => {
    for (const field of [
      "cwd",
      "hook_event_name",
      "model",
      "permission_mode",
      "session_id",
      "tool_input",
      "tool_name",
      "tool_use_id",
      "transcript_path",
      "turn_id",
    ]) {
      const candidate = { ...fixture };
      delete candidate[field];
      expect(codexPreToolUseInputSchema.safeParse(candidate).success, field).toBe(false);
    }
  });
});

describe("Codex PreToolUse output", () => {
  it("serializes neutral as exactly zero stdout bytes", () => {
    expect(serializeCodexPreToolUseDecision(decision("unrelated"))).toBe("");
  });

  it("matches the release-pinned denial fixture without allowing or rewriting", async () => {
    const expected = await readFile(resolve(fixtureDirectory, "deny-output.json"), "utf8");
    const output = serializeCodexPreToolUseDecision(decision("dependency_review"));
    expect(output).toBe(`${JSON.stringify(JSON.parse(expected))}\n`);
    expect(output).not.toContain('"allow"');
    expect(output).not.toContain("updatedInput");
  });

  it("runs an unrelated command without authority, provider, cache, or stdout access", async () => {
    const writes: string[] = [];
    const exitCode = await runCodexPreToolUse(stream("git status"), {
      loadAuthority: async () => {
        throw new Error("authority must not run");
      },
      writeError: (text) => {
        writes.push(text);
      },
      writeOutput: (text) => {
        writes.push(text);
      },
    });
    expect(exitCode).toBe(0);
    expect(writes).toEqual([]);
  });

  it("authenticates an exact project launch once and reuses that authority for evaluation", async () => {
    const writes: string[] = [];
    const loadedAuthority = authority();
    const installationId = "ab".repeat(32);
    const rootBinding = "cd".repeat(32);
    let authorityLoads = 0;
    let invocationChecks = 0;
    const exitCode = await runCodexPreToolUse(
      stream("git status"),
      {
        evaluateAction: async (action, _deadline, evaluationDependencies) => {
          expect(action.deploymentTrust).toBe("project");
          expect(evaluationDependencies).toBeDefined();
          if (!evaluationDependencies) throw new Error("missing dependencies");
          const reused = await evaluationDependencies.loadAuthority?.(fixtureRoot);
          expect(reused).toBe(loadedAuthority);
          expect(authorityLoads).toBe(1);
          return decision("unrelated", "project");
        },
        loadAuthority: async () => {
          authorityLoads += 1;
          return loadedAuthority;
        },
        parseProjectLaunchArguments: parseCodexProjectHookLaunchArguments,
        verifyProjectInvocation: async (receivedAuthority, context) => {
          invocationChecks += 1;
          expect(receivedAuthority).toBe(loadedAuthority);
          expect(context).toEqual({ deploymentTrust: "project", installationId, rootBinding });
          return true;
        },
        writeError: (text) => {
          writes.push(text);
        },
        writeOutput: (text) => {
          writes.push(text);
        },
      },
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${installationId}`,
        `--agenthawk-root-binding=${rootBinding}`,
      ],
    );
    expect(exitCode).toBe(0);
    expect(authorityLoads).toBe(1);
    expect(invocationChecks).toBe(1);
    expect(writes).toEqual([]);
  });

  it.each([
    ["malformed launch arguments", ["--agenthawk-deployment-trust=project"], undefined],
    [
      "rejected project pair",
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${"ab".repeat(32)}`,
        `--agenthawk-root-binding=${"cd".repeat(32)}`,
      ],
      false,
    ],
    [
      "cancelled project verification",
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${"ab".repeat(32)}`,
        `--agenthawk-root-binding=${"cd".repeat(32)}`,
      ],
      "cancelled",
    ],
  ])("fails closed with fixed output for %s", async (_label, launchArguments, verification) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCodexPreToolUse(
      stream("git status"),
      {
        loadAuthority: async () => authority(),
        parseProjectLaunchArguments: parseCodexProjectHookLaunchArguments,
        verifyProjectInvocation: async () => {
          if (verification === "cancelled") {
            throw new OperationCancelledError();
          }
          return verification === true;
        },
        writeError: (text) => {
          stderr.push(text);
        },
        writeOutput: (text) => {
          stdout.push(text);
        },
      },
      launchArguments,
    );
    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([CODEX_EMERGENCY_DENIAL]);
    expect(stderr.join("")).not.toMatch(/private|cancelled-root|git status/u);
  });

  it("denies shell-specific syntax because target dialect is not authenticated", async () => {
    const writes: string[] = [];
    const exitCode = await runCodexPreToolUse(stream("n^pm add example"), {
      writeError: (text) => {
        writes.push(text);
      },
      writeOutput: (text) => {
        writes.push(text);
      },
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(writes.join(""))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it.each([
    [
      "deadline construction failure",
      {
        createDeadline: () => {
          throw new Error("secret clock");
        },
      },
    ],
    ["malformed input", { source: "not-json" }],
    [
      "evaluator escape",
      {
        evaluateAction: async () => {
          throw new Error("C:/private/secret");
        },
      },
    ],
    [
      "serializer failure",
      {
        serializeDecision: () => {
          throw new Error("secret");
        },
      },
    ],
    [
      "normal output failure",
      {
        evaluateAction: async () => decision("dependency_review"),
        writeOutput: async () => {
          throw new Error("sink secret");
        },
      },
    ],
  ])("uses only the constant emergency denial for %s", async (_label, overrides) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const source =
      "source" in overrides ? overrides.source : JSON.stringify(payload("npm add example"));
    const exitCode = await runCodexPreToolUse(Readable.from([source]), {
      evaluateAction: async () => decision("dependency_review"),
      serializeDecision: serializeCodexPreToolUseDecision,
      writeError: (text) => {
        stderr.push(text);
      },
      writeOutput: (text) => {
        stdout.push(text);
      },
      ...overrides,
    });
    expect(exitCode).toBe(2);
    expect(stderr).toEqual([CODEX_EMERGENCY_DENIAL]);
    expect(stderr.join("")).not.toMatch(/private|secret|npm add/u);
    if (_label !== "normal output failure") expect(stdout).toEqual([]);
  });

  it("cancels stalled stdin at the owned deadline and disposes the timer", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const stderr: string[] = [];
    const pending = runCodexPreToolUse(input, {
      writeError: (text) => {
        stderr.push(text);
      },
      writeOutput: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toBe(2);
    expect(input.destroyed).toBe(true);
    expect(stderr).toEqual([CODEX_EMERGENCY_DENIAL]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows an unavailable emergency sink and still returns exit 2", async () => {
    await expect(
      runCodexPreToolUse(Readable.from(["invalid"]), {
        writeError: async () => {
          throw new Error("unavailable");
        },
        writeOutput: () => undefined,
      }),
    ).resolves.toBe(2);
  });
});

function payload(command: string) {
  return { ...fixture, cwd: fixtureRoot, tool_input: { command } };
}

function stream(command: string): Readable {
  return Readable.from([JSON.stringify(payload(command))]);
}

function decision(
  reason: "dependency_review" | "unrelated",
  deploymentTrust: "project" | "unknown" = "unknown",
): AgentDecision {
  const base = {
    adapter: { id: "codex", version: "rust-v0.149.0/0.1.0-alpha.1" },
    deploymentTrust,
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

function authority(): RepositoryAuthority {
  return {
    approvals: { approvals: [], version: 1 },
    config: agentHawkConfigSchema.parse({ version: 1 }),
    directDependencyNames: [],
    repositoryIdentity: { dev: 1n, ino: 2n },
    repositoryRoot: fixtureRoot,
  };
}
