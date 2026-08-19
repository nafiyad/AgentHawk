import { describe, expect, it } from "vitest";
import {
  agentHawkConfigSchema,
  evaluationReportSchema,
  findingSchema,
  packageCoordinateSchema,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("domain schemas", () => {
  it("accepts a minimal valid evaluation report", () => {
    const report = evaluationReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: "0.0.0",
      generatedAt: "2026-08-19T18:00:00.000Z",
      target: { ecosystem: "npm", name: "example", requestedSpec: "^1.0.0" },
      verdict: "allow",
      originalVerdict: "allow",
      findings: [],
      providerStatus: [{ provider: "npm", status: "ok" }],
      policyDigest: digest,
      evidenceDigest: digest,
      exitCodeMeaning: "allowed",
    });

    expect(report.verdict).toBe("allow");
  });

  it("rejects unsupported ecosystems and unknown fields", () => {
    expect(() =>
      packageCoordinateSchema.parse({
        ecosystem: "pypi",
        name: "example",
        requestedSpec: "1.0.0",
        bypass: true,
      }),
    ).toThrow();
  });

  it("requires structured rule identifiers", () => {
    expect(() =>
      findingSchema.parse({
        ruleId: "UNKNOWN",
        verdict: "review",
        severity: "medium",
        basis: "heuristic",
        title: "Review required",
        message: "Evidence is incomplete.",
        evidence: [],
        approvable: true,
      }),
    ).toThrow();
  });
});

describe("configuration schema", () => {
  const config = {
    version: 1,
    mode: "review",
    defaults: {
      onProviderError: "review",
      onUnknownVersion: "review",
      allowPrerelease: false,
    },
    registries: { npm: { enabled: true } },
    rules: {
      knownMaliciousPackage: { action: "block" },
      requireRepositoryUrl: { action: "warn" },
    },
  } as const;

  it("accepts the secure configuration skeleton", () => {
    expect(agentHawkConfigSchema.parse(config).rules.knownMaliciousPackage.action).toBe("block");
    expect(agentHawkConfigSchema.parse(config).registries.osv.enabled).toBe(true);
  });

  it("rejects unknown security-sensitive fields", () => {
    expect(() =>
      agentHawkConfigSchema.parse({
        ...config,
        skipSecurity: true,
      }),
    ).toThrow();
  });

  it("does not permit weakening known-malicious blocks", () => {
    expect(() =>
      agentHawkConfigSchema.parse({
        ...config,
        rules: {
          ...config.rules,
          knownMaliciousPackage: { action: "allow" },
        },
      }),
    ).toThrow();
  });
});
