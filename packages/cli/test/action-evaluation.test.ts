import { resolve } from "node:path";
import {
  type AgentAction,
  agentHawkConfigSchema,
  DeadlineExceededError,
  type EvaluationReport,
  evaluationReportSchema,
  type NpmProviderResult,
  OperationCancelledError,
  serializeAgentDecision,
  type Verdict,
} from "@agenthawk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ActionEvaluationDependencies,
  createActionDeadline,
  evaluateAgentAction,
  evaluateDependencyAdd,
} from "../src/action-evaluation.js";
import { type RepositoryAuthority, RepositoryAuthorityError } from "../src/repository-authority.js";

const root = resolve("agenthawk-action-evaluation-fixture");
const digest = `sha256:${"a".repeat(64)}`;
const config = agentHawkConfigSchema.parse({ version: 1 });
const successProviderResult: Extract<NpmProviderResult, { ok: true }> = {
  data: {
    lifecycleScripts: [],
    name: "example",
    packagePublishedAt: "2020-01-01T00:00:00.000Z",
    releasePublishedAt: "2025-01-01T00:00:00.000Z",
    repositoryUrl: "https://github.com/example/example",
    requestedSpec: "1.0.0",
    resolvedVersion: "1.0.0",
  },
  fetchedAt: "2026-08-23T00:00:00.000Z",
  ok: true,
  status: "ok",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("action deadline", () => {
  it("uses one fixed eight-second deadline and disposes idempotently", async () => {
    vi.useFakeTimers();
    const deadline = createActionDeadline();
    expect(deadline.deadlineAtNanoseconds - deadline.startedAtNanoseconds).toBe(8_000_000_000n);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.reason).toBeInstanceOf(DeadlineExceededError);
    deadline.dispose();
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the first parent cancellation cause and removes its listener", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createActionDeadline(parent.signal);
    parent.abort(new Error("secret host reason"));
    expect(deadline.signal.reason).toBeInstanceOf(OperationCancelledError);
    expect(deadline.signal.reason).not.toBeInstanceOf(DeadlineExceededError);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(deadline.signal.reason).toBeInstanceOf(OperationCancelledError);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a parent cancellation that already exists at construction", () => {
    const parent = new AbortController();
    parent.abort(new Error("secret host reason"));
    const deadline = createActionDeadline(parent.signal);
    expect(deadline.signal.reason).toEqual(new OperationCancelledError());
    deadline.dispose();
  });

  it("does not replace a deadline cause when the parent aborts later", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const deadline = createActionDeadline(parent.signal);
    await vi.advanceTimersByTimeAsync(8_000);
    parent.abort(new Error("later host cause"));
    expect(deadline.signal.reason).toBeInstanceOf(DeadlineExceededError);
    deadline.dispose();
  });
});

describe("evaluateAgentAction", () => {
  it("rejects an action that was not validated at the vendor boundary", async () => {
    await expect(
      runAction({ ...action("npm add zod"), unexpected: true } as AgentAction),
    ).rejects.toThrow("Agent action must be validated at the vendor boundary.");
  });

  it.each(["git status", "npm add zod"])(
    "maps a pre-expired deadline before qualifying %j",
    async (command) => {
      vi.useFakeTimers();
      const deadline = createActionDeadline();
      await vi.advanceTimersByTimeAsync(8_000);
      try {
        await expect(evaluateAgentAction(action(command), deadline)).resolves.toMatchObject({
          outcome: "deny",
          reasonCode: "deadline_exceeded",
        });
      } finally {
        deadline.dispose();
      }
    },
  );

  it.each([
    ["git status", "unrelated", "neutral"],
    ["npm add --save zod", "unsupported_dependency_action", "deny"],
    ["npx cowsay", "ephemeral_execution_denied", "deny"],
    ["npm add", "unsupported_dependency_action", "deny"],
    ["npm add a b c d e f g h i", "invalid_action", "deny"],
  ])("maps non-evaluated command %j without authority access", async (command, reason, outcome) => {
    let authorityCalls = 0;
    const decision = await runAction(action(command), {
      loadAuthority: async () => {
        authorityCalls += 1;
        return authority();
      },
    });
    expect(decision).toMatchObject({ outcome, reasonCode: reason });
    expect(authorityCalls).toBe(0);
  });

  it.each([
    ["repository_identity", "repository_identity_error"],
    ["configuration", "configuration_error"],
  ] as const)(
    "maps typed %s authority failures without message inspection",
    async (code, reason) => {
      const decision = await runAction(action("npm add zod"), {
        loadAuthority: async () => {
          throw new RepositoryAuthorityError(code, "host path secret");
        },
      });
      expect(decision).toMatchObject({ outcome: "deny", reasonCode: reason });
      expect(JSON.stringify(decision)).not.toContain("secret");
    },
  );

  it("maps an unexpected authority failure to a fixed redacted denial", async () => {
    const decision = await runAction(action("npm add zod"), {
      loadAuthority: async () => {
        throw new Error("C:/private/repository");
      },
    });
    expect(decision).toMatchObject({ outcome: "deny", reasonCode: "internal_error" });
    expect(JSON.stringify(decision)).not.toContain("private");
  });

  it("preserves caller cancellation raised by authority loading", async () => {
    await expect(
      runAction(action("npm add zod"), {
        loadAuthority: async () => {
          throw new OperationCancelledError();
        },
      }),
    ).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("maps deadline expiry while repository authority is loading", async () => {
    vi.useFakeTimers();
    const deadline = createActionDeadline();
    const pending = evaluateAgentAction(action("npm add zod"), deadline, {
      loadAuthority: async (_root, options) =>
        await new Promise<RepositoryAuthority>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) throw new Error("missing signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toMatchObject({ reasonCode: "deadline_exceeded" });
    deadline.dispose();
  });

  it("rethrows parent cancellation while repository authority is loading", async () => {
    const parent = new AbortController();
    const deadline = createActionDeadline(parent.signal);
    const pending = evaluateAgentAction(action("npm add zod"), deadline, {
      loadAuthority: async (_root, options) =>
        await new Promise<RepositoryAuthority>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) throw new Error("missing signal");
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    parent.abort(new Error("secret"));
    await expect(pending).rejects.toEqual(new OperationCancelledError());
    deadline.dispose();
  });

  it("uses the production prepared evaluator without rendering or path reads", async () => {
    const decision = await runAction(action("npm add @scope/example@1.0.0"), {
      getPackage: async (name, requestedSpec) => {
        expect(name).toBe("@scope/example");
        expect(requestedSpec).toBe("1.0.0");
        return {
          ...successProviderResult,
          data: {
            ...successProviderResult.data,
            name,
            requestedSpec,
          },
        };
      },
      loadAuthority: async () => authority(),
      now: () => new Date("2026-08-23T00:00:00.000Z"),
      queryOsv: async () => ({
        fetchedAt: "2026-08-23T00:00:00.000Z",
        ok: true,
        records: [],
        status: "ok",
      }),
    });
    expect(decision).toMatchObject({ outcome: "neutral", reasonCode: "dependency_allowed" });
  });

  it("loads authority once and evaluates packages with a concurrency ceiling of two", async () => {
    let authorityCalls = 0;
    let active = 0;
    let highWater = 0;
    const starts: string[] = [];
    const decision = await runAction(action("npm add a@1 b@1 c@1 d@1 e@1"), {
      evaluatePackage: async (spec) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        starts.push(spec.name);
        active += 1;
        highWater = Math.max(highWater, active);
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
        active -= 1;
        return report(spec.name, "allow");
      },
      loadAuthority: async () => {
        authorityCalls += 1;
        return authority();
      },
    });
    expect(authorityCalls).toBe(1);
    expect(starts).toHaveLength(5);
    expect(highWater).toBe(2);
    expect(decision).toMatchObject({ outcome: "neutral", reasonCode: "dependency_allowed" });
  });

  it("preserves repository policy mode because every non-allow verdict already denies", async () => {
    const decision = await runAction(action("npm add zod@1"), {
      evaluatePackage: async (spec, prepared) => {
        expect(prepared.config.mode).toBe("review");
        return report(spec.name ?? "zod", "review");
      },
      loadAuthority: async () => authority(),
    });
    expect(decision).toMatchObject({ outcome: "deny", reasonCode: "dependency_review" });
  });

  it("preserves input order and digest despite reversed completion order", async () => {
    const delays: Record<string, number> = { alpha: 20, beta: 1, gamma: 5 };
    const dependencies: ActionEvaluationDependencies = {
      evaluatePackage: async (spec) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, delays[spec.name] ?? 0),
        );
        return report(spec.name, "allow");
      },
      loadAuthority: async () => authority(),
    };
    const first = await runAction(action("npm add alpha@1 beta@1 gamma@1"), dependencies);
    const second = await runAction(action("npm add alpha@1 beta@1 gamma@1"), dependencies);
    if (!("reportDigest" in first) || !("reportDigest" in second)) throw new Error("unexpected");
    expect(first.reportDigest).toBe(second.reportDigest);
  });

  it("deduplicates provider work while retaining duplicate operand semantics", async () => {
    let evaluations = 0;
    const deadline = createActionDeadline();
    try {
      const result = await evaluateDependencyAdd(
        [
          { name: "zod", requestedSpec: "4.4.3", selectorKind: "exact" },
          { name: "zod", requestedSpec: "4.4.3", selectorKind: "exact" },
        ],
        authority(),
        deadline.signal,
        {
          evaluatePackage: async () => {
            evaluations += 1;
            return report("zod", "allow");
          },
        },
      );
      expect(evaluations).toBe(1);
      expect(result.reports).toHaveLength(2);
      expect(result.reports[0]).toBe(result.reports[1]);
    } finally {
      deadline.dispose();
    }
  });

  it("supplies co-root and sibling names to PG005 context", async () => {
    const contexts = new Map<string, readonly string[]>();
    await runAction(action("npm add mature-package@1 mature-packagee@1"), {
      evaluatePackage: async (spec, prepared) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        contexts.set(spec.name, prepared.existingDependencies ?? []);
        return report(spec.name, "review");
      },
      loadAuthority: async () => authority(["existing-package"]),
    });
    expect(contexts.get("mature-package")).toEqual(["existing-package", "mature-packagee"]);
    expect(contexts.get("mature-packagee")).toEqual(["existing-package", "mature-package"]);
  });

  it.each([
    [["allow", "warn"], "warn", "warning_requires_review"],
    [["review", "block"], "block", "dependency_blocked"],
    [["block", "error"], "error", "evaluation_error"],
  ] as const)("aggregates %j deterministically as %s", async (verdicts, verdict, reason) => {
    let index = 0;
    const decision = await runAction(action("npm add first@1 second@1"), {
      evaluatePackage: async (spec) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        const selected = verdicts[index] ?? "allow";
        index += 1;
        return report(spec.name, selected);
      },
      loadAuthority: async () => authority(),
    });
    expect(decision).toMatchObject({ outcome: "deny", reasonCode: reason, verdict });
  });

  it("does not expose a subordinate approval when an error dominates", async () => {
    let index = 0;
    const decision = await runAction(action("npm add approved@1 failed@1"), {
      evaluatePackage: async (spec) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        index += 1;
        return index === 1
          ? report(spec.name, "allow", "review", true)
          : report(spec.name, "error");
      },
      loadAuthority: async () => authority(),
    });
    expect(decision).toMatchObject({ approvalApplied: false, verdict: "error" });
  });

  it("records an exact approval that resolves the aggregate review", async () => {
    const decision = await runAction(action("npm add approved@1"), {
      evaluatePackage: async (spec) => report(spec.name ?? "approved", "allow", "review", true),
      loadAuthority: async () => authority(),
    });
    expect(decision).toMatchObject({
      approvalApplied: true,
      originalVerdict: "review",
      outcome: "neutral",
      verdict: "allow",
    });
  });

  it("records a subordinate approval without weakening an aggregate block", async () => {
    const decisions = new Map<string, EvaluationReport>([
      ["approved", report("approved", "allow", "review", true)],
      ["blocked", report("blocked", "block")],
    ]);
    const decision = await runAction(action("npm add approved@1 blocked@1"), {
      evaluatePackage: async (spec) => decisions.get(spec.name ?? "") ?? report("missing", "error"),
      loadAuthority: async () => authority(),
    });
    expect(decision).toMatchObject({
      approvalApplied: true,
      originalVerdict: "block",
      outcome: "deny",
      verdict: "block",
    });
  });

  it("stops queued work, aborts active siblings, and waits for settlement on internal failure", async () => {
    const starts: string[] = [];
    let siblingSettled = false;
    const decision = await runAction(action("npm add first@1 second@1 third@1 fourth@1"), {
      evaluatePackage: async (spec, prepared) => {
        if (spec.type !== "registry") throw new Error("unexpected");
        starts.push(spec.name);
        if (spec.name === "first") throw new Error("provider implementation bug");
        await new Promise<void>((_resolve, reject) => {
          prepared.signal?.addEventListener(
            "abort",
            () => {
              siblingSettled = true;
              reject(new OperationCancelledError());
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
      loadAuthority: async () => authority(),
    });
    expect(decision.reasonCode).toBe("internal_error");
    expect(starts).toEqual(["first", "second"]);
    expect(siblingSettled).toBe(true);
  });

  it("returns a deadline denial only after active evaluation settles", async () => {
    vi.useFakeTimers();
    let settled = false;
    const deadline = createActionDeadline();
    const pending = evaluateAgentAction(action("npm add zod@1"), deadline, {
      evaluatePackage: async (_spec, prepared) =>
        await new Promise<EvaluationReport>((_resolve, reject) => {
          prepared.signal?.addEventListener(
            "abort",
            () => {
              settled = true;
              reject(new DeadlineExceededError());
            },
            { once: true },
          );
        }),
      loadAuthority: async () => authority(),
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(pending).resolves.toMatchObject({ reasonCode: "deadline_exceeded" });
    expect(settled).toBe(true);
    deadline.dispose();
  });

  it("removes no parent listener when setup fails before listener registration", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    await expect(
      evaluateDependencyAdd(
        [{ name: "zod", requestedSpec: "1", selectorKind: "range" }],
        authority(),
        parent.signal,
        {
          now: () => {
            throw new Error("clock failed");
          },
        },
      ),
    ).rejects.toThrow("clock failed");
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("balances the parent listener when worker cancellation is the first cause", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const pending = evaluateDependencyAdd(
      [{ name: "zod", requestedSpec: "1", selectorKind: "range" }],
      authority(),
      parent.signal,
      {
        evaluatePackage: async (_spec, prepared) =>
          await new Promise<EvaluationReport>((_resolve, reject) => {
            prepared.signal?.addEventListener("abort", () => reject(prepared.signal?.reason), {
              once: true,
            });
          }),
      },
    );
    parent.abort(new Error("secret"));
    await expect(pending).rejects.toEqual(new OperationCancelledError());
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each([new OperationCancelledError(), new DeadlineExceededError()])(
    "preserves typed worker cancellation %s without converting it to internal failure",
    async (failure) => {
      await expect(
        runAction(action("npm add zod@1"), {
          evaluatePackage: async () => {
            throw failure;
          },
          loadAuthority: async () => authority(),
        }),
      ).rejects.toBeInstanceOf(failure.constructor);
    },
  );

  it("observes cancellation that begins during synchronous evaluation setup", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    await expect(
      evaluateDependencyAdd(
        [{ name: "zod", requestedSpec: "1", selectorKind: "range" }],
        authority(),
        parent.signal,
        {
          now: () => {
            parent.abort(new Error("secret"));
            return new Date("2026-08-23T00:00:00.000Z");
          },
        },
      ),
    ).rejects.toEqual(new OperationCancelledError());
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rethrows caller cancellation with a redacted fixed identity", async () => {
    const parent = new AbortController();
    const deadline = createActionDeadline(parent.signal);
    parent.abort(new Error("secret"));
    try {
      await expect(
        evaluateAgentAction(action("npm add zod"), deadline, {
          loadAuthority: async () => authority(),
        }),
      ).rejects.toEqual(new OperationCancelledError());
    } finally {
      deadline.dispose();
    }
  });

  it("serializes a bounded decision without raw command or repository path", async () => {
    const input = action("npm add private-package-name@1");
    const decision = await runAction(input, {
      evaluatePackage: async () => report("private-package-name", "block"),
      loadAuthority: async () => authority(),
    });
    const serialized = serializeAgentDecision(decision);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8_192);
    expect(serialized).not.toContain(input.tool.command);
    expect(serialized).not.toContain(root);
  });
});

function action(command: string): AgentAction {
  return {
    adapter: { id: "codex", version: "fixture-1" },
    deploymentTrust: "project",
    event: "pre_tool_use",
    repositoryRoot: root,
    schemaVersion: "1.0",
    tool: { command, dialect: "posix", kind: "shell_command" },
    workingDirectory: root,
  };
}

function authority(existing: readonly string[] = []): RepositoryAuthority {
  return {
    approvals: { approvals: [], version: 1 },
    config,
    directDependencyNames: existing,
    repositoryRoot: root,
  };
}

function report(
  name: string,
  verdict: Verdict,
  originalVerdict: Verdict = verdict,
  approved = false,
): EvaluationReport {
  return evaluationReportSchema.parse({
    ...(approved
      ? {
          approval: {
            approvedBy: "github:maintainer",
            expiresAt: "2027-01-01T00:00:00.000Z",
            reason: "Reviewed exact release.",
          },
        }
      : {}),
    evidenceDigest: digest,
    exitCodeMeaning: "prepared",
    findings: [],
    generatedAt: "2026-08-23T00:00:00.000Z",
    originalVerdict,
    policyDigest: digest,
    providerStatus: [],
    schemaVersion: "1.0",
    target: {
      ecosystem: "npm",
      name,
      requestedSpec: "1",
      resolvedVersion: "1.0.0",
    },
    toolVersion: "0.1.0-alpha.1",
    verdict,
  });
}

async function runAction(
  input: AgentAction,
  dependencies: Parameters<typeof evaluateAgentAction>[2] = {},
) {
  const deadline = createActionDeadline();
  try {
    return await evaluateAgentAction(input, deadline, dependencies);
  } finally {
    deadline.dispose();
  }
}
