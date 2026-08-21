import { describe, expect, it } from "vitest";
import {
  agentHawkConfigSchema,
  applyApprovals,
  approvalFileSchema,
  type Finding,
  summarizeApprovalTimes,
} from "../src/index.js";

const now = new Date("2026-08-19T18:00:00.000Z");
const config = agentHawkConfigSchema.parse({ version: 1 });
const target = {
  ecosystem: "npm" as const,
  name: "example-package",
  requestedSpec: "^1.0.0",
  resolvedVersion: "1.2.3",
};
const review: Finding = {
  approvable: true,
  basis: "policy",
  evidence: [],
  message: "Review required.",
  remediation: "Review it.",
  ruleId: "PG003",
  severity: "medium",
  title: "Review",
  verdict: "review",
};

function approvals(overrides: Record<string, unknown> = {}) {
  return approvalFileSchema.parse({
    version: 1,
    approvals: [
      {
        ecosystem: "npm",
        name: "example-package",
        version: "1.2.3",
        approvedBy: "github:maintainer",
        approvedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-09-01T00:00:00.000Z",
        reason: "Source and release reviewed.",
        ...overrides,
      },
    ],
  });
}

describe("approval schema", () => {
  it("accepts a strict exact approval", () => {
    expect(approvals().approvals).toHaveLength(1);
  });

  it.each([
    { name: "*" },
    { name: "Example-Package" },
    { name: "example package" },
    { version: "^1.2.3" },
    { version: "latest" },
    { reason: " " },
    { approvedBy: "maintainer\u001b[31m" },
    { issue: "http://example.test/issue/1" },
    { expiresAt: "2026-07-01T00:00:00.000Z" },
    { bypass: true },
  ])("rejects malformed or weak approval %#", (override) => {
    expect(() => approvals(override)).toThrow();
  });

  it("rejects duplicate package-version approvals", () => {
    const record = approvals().approvals[0];
    expect(() => approvalFileSchema.parse({ version: 1, approvals: [record, record] })).toThrow();
  });

  it("rejects format controls and explicitly bounds records and text", () => {
    expect(() => approvals({ reason: "reviewed\u202eexe" })).toThrow();
    expect(() => approvals({ approvedBy: "x".repeat(257) })).toThrow();
    expect(() => approvals({ reason: "x".repeat(4_097) })).toThrow();
    const record = approvals().approvals[0];
    expect(record).toBeDefined();
    expect(() =>
      approvalFileSchema.parse({
        version: 1,
        approvals: Array.from({ length: 1_025 }, (_, index) => ({
          ...record,
          version: `1.0.${index}`,
        })),
      }),
    ).toThrow();
  });

  it("summarizes exact approval time boundaries from one checked instant", () => {
    const base = approvals().approvals[0];
    expect(base).toBeDefined();
    const file = approvalFileSchema.parse({
      version: 1,
      approvals: [
        { ...base, name: "effective", approvedAt: now.toISOString() },
        {
          ...base,
          name: "expired",
          approvedAt: "2026-07-01T00:00:00.000Z",
          expiresAt: now.toISOString(),
        },
        {
          ...base,
          name: "future",
          approvedAt: "2026-08-20T00:00:00.000Z",
          expiresAt: "2026-09-20T00:00:00.000Z",
        },
      ],
    });

    expect(summarizeApprovalTimes(file, now)).toEqual({
      checkedAt: now.toISOString(),
      expiredCount: 1,
      notYetEffectiveCount: 1,
      timeEligibleCount: 1,
    });
    expect(() => summarizeApprovalTimes(file, new Date(Number.NaN))).toThrow();
  });
});

describe("approval application", () => {
  it("resolves an exact, active, approvable review and preserves original verdict", () => {
    expect(
      applyApprovals({
        approvals: approvals(),
        config,
        errors: [],
        findings: [review],
        now,
        target,
      }),
    ).toMatchObject({
      approval: { approvedBy: "github:maintainer" },
      originalVerdict: "review",
      verdict: "allow",
    });
  });

  it.each([
    ["name", { name: "other-package" }],
    ["version", { version: "1.2.4" }],
    ["expired", { expiresAt: "2026-08-19T18:00:00.000Z" }],
    ["future", { approvedAt: "2026-08-20T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }],
  ])("does nothing for non-matching %s approval", (_label, override) => {
    expect(
      applyApprovals({
        approvals: approvals(override),
        config,
        errors: [],
        findings: [review],
        now,
        target,
      }),
    ).toEqual({ originalVerdict: "review", verdict: "review" });
  });

  it("does not override blocks, non-approvable reviews, or evaluation errors", () => {
    const block = {
      ...review,
      ruleId: "PG010" as const,
      verdict: "block" as const,
      approvable: false,
    };
    const hardReview = { ...review, approvable: false };
    expect(
      applyApprovals({
        approvals: approvals(),
        config,
        errors: [],
        findings: [block],
        now,
        target,
      }),
    ).toEqual({ originalVerdict: "block", verdict: "block" });
    expect(
      applyApprovals({
        approvals: approvals(),
        config,
        errors: [],
        findings: [hardReview],
        now,
        target,
      }).verdict,
    ).toBe("review");
    expect(
      applyApprovals({
        approvals: approvals(),
        config,
        errors: [{}],
        findings: [review],
        now,
        target,
      }).verdict,
    ).toBe("error");
  });

  it("preserves warnings after resolving reviews", () => {
    const warning = { ...review, ruleId: "PG006" as const, verdict: "warn" as const };
    expect(
      applyApprovals({
        approvals: approvals(),
        config,
        errors: [],
        findings: [review, warning],
        now,
        target,
      }).verdict,
    ).toBe("warn");
  });

  it("enforces configured maximum approval validity", () => {
    const long = approvals({
      approvedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
    expect(
      applyApprovals({ approvals: long, config, errors: [], findings: [review], now, target })
        .approval,
    ).toBeUndefined();
  });
});
