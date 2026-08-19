import { describe, expect, it } from "vitest";
import {
  agentHawkConfigSchema,
  combineVerdicts,
  evaluatePolicy,
  type NpmPackageMetadata,
  type NpmProviderResult,
  parseNpmSpec,
} from "../src/index.js";

const now = new Date("2026-08-19T18:00:00.000Z");
const config = agentHawkConfigSchema.parse({ version: 1 });

function metadata(overrides: Partial<NpmPackageMetadata> = {}): NpmPackageMetadata {
  return {
    lifecycleScripts: [],
    name: "mature-package",
    packagePublishedAt: "2020-01-01T00:00:00.000Z",
    releasePublishedAt: "2026-01-01T00:00:00.000Z",
    repositoryUrl: "https://github.com/example/mature-package",
    requestedSpec: "1.0.0",
    resolvedVersion: "1.0.0",
    ...overrides,
  };
}

function success(overrides: Partial<NpmPackageMetadata> = {}): NpmProviderResult {
  return {
    data: metadata(overrides),
    fetchedAt: "2026-08-19T17:59:00.000Z",
    ok: true,
    status: "ok",
  };
}

function failure(
  status: Exclude<NpmProviderResult, { ok: true }>["status"],
  message = "Provider request failed.",
): NpmProviderResult {
  return { fetchedAt: "2026-08-19T17:59:00.000Z", message, ok: false, status };
}

function evaluate(providerResult: NpmProviderResult = success()) {
  return evaluatePolicy({
    config,
    now,
    providerResult,
    spec: parseNpmSpec("mature-package@1.0.0"),
  });
}

describe("policy configuration", () => {
  it("materializes the complete secure default policy", () => {
    expect(config.rules.packageAge).toEqual({ action: "review", minDays: 30 });
    expect(config.rules.releaseAge).toEqual({ action: "review", minHours: 72 });
    expect(config.rules.knownMaliciousPackage.action).toBe("block");
    expect(config.ci.failOn).toEqual(["review", "block", "error"]);
  });

  it("rejects unknown nested security-sensitive fields", () => {
    expect(() =>
      agentHawkConfigSchema.parse({
        version: 1,
        rules: { lifecycleScripts: { action: "review", bypass: true } },
      }),
    ).toThrow();
  });

  it("rejects attempts to weaken known-malicious handling", () => {
    expect(() =>
      agentHawkConfigSchema.parse({
        version: 1,
        rules: { knownMaliciousPackage: { action: "review" } },
      }),
    ).toThrow();
  });
});

describe("deterministic policy rules", () => {
  it("allows mature metadata when no rule matches", () => {
    expect(evaluate()).toEqual({ errors: [], findings: [], verdict: "allow" });
  });

  it("PG001 blocks a missing package or version", () => {
    const result = evaluate(failure("not_found", "sensitive upstream detail"));
    expect(result.verdict).toBe("block");
    expect(result.findings[0]).toMatchObject({ approvable: false, ruleId: "PG001" });
    expect(result.findings[0]?.evidence[0]).toMatchObject({
      data: { providerStatus: "not_found" },
      fetchedAt: "2026-08-19T17:59:00.000Z",
      provider: "npm",
    });
    expect(result.findings[0]?.message).not.toContain("sensitive upstream detail");
  });

  it("PG002 reviews a newly published package", () => {
    const result = evaluate(success({ packagePublishedAt: "2026-08-10T18:00:00.000Z" }));
    expect(result.findings.map((finding) => finding.ruleId)).toContain("PG002");
  });

  it("PG003 reviews an extremely fresh selected release", () => {
    const result = evaluate(success({ releasePublishedAt: "2026-08-19T17:00:00.000Z" }));
    expect(result.findings.map((finding) => finding.ruleId)).toContain("PG003");
  });

  it("PG003 enforces the default prerelease policy", () => {
    const result = evaluate(
      success({ releasePublishedAt: "2026-01-01T00:00:00.000Z", resolvedVersion: "2.0.0-beta.1" }),
    );
    const finding = result.findings.find((candidate) => candidate.ruleId === "PG003");
    expect(finding).toMatchObject({ title: "Prerelease requires review", verdict: "review" });
  });

  it("combines prerelease and freshness into one PG003 finding", () => {
    const result = evaluate(
      success({
        releasePublishedAt: "2026-08-19T17:00:00.000Z",
        resolvedVersion: "2.0.0-beta.1",
      }),
    );
    const pg003 = result.findings.filter((finding) => finding.ruleId === "PG003");
    expect(pg003).toHaveLength(1);
    expect(pg003[0]?.message).toContain("prerelease and younger");
  });

  it("allows a mature prerelease only when policy explicitly permits it", () => {
    const permissive = agentHawkConfigSchema.parse({
      version: 1,
      defaults: { allowPrerelease: true },
    });
    const result = evaluatePolicy({
      config: permissive,
      now,
      providerResult: success({
        releasePublishedAt: "2026-01-01T00:00:00.000Z",
        resolvedVersion: "2.0.0-beta.1",
      }),
      spec: parseNpmSpec("mature-package@2.0.0-beta.1"),
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("PG003");
  });

  it("does not let release-age allow bypass a disallowed prerelease", () => {
    const releaseAgeDisabled = agentHawkConfigSchema.parse({
      version: 1,
      rules: { releaseAge: { action: "allow", minHours: 72 } },
    });
    const result = evaluatePolicy({
      config: releaseAgeDisabled,
      now,
      providerResult: success({
        releasePublishedAt: "2026-01-01T00:00:00.000Z",
        resolvedVersion: "2.0.0-beta.1",
      }),
      spec: parseNpmSpec("mature-package@2.0.0-beta.1"),
    });
    expect(result.verdict).toBe("review");
    expect(result.findings[0]).toMatchObject({ ruleId: "PG003", verdict: "review" });
  });

  it("does not flag package or release age at the exact configured boundary", () => {
    const result = evaluate(
      success({
        packagePublishedAt: "2026-07-20T18:00:00.000Z",
        releasePublishedAt: "2026-08-16T18:00:00.000Z",
      }),
    );
    expect(result.findings).toEqual([]);
  });

  it("PG004 reviews registry deprecation metadata", () => {
    const result = evaluate(success({ deprecated: "Use maintained-package instead." }));
    expect(result.findings[0]).toMatchObject({ basis: "evidence", ruleId: "PG004" });
    expect(result.findings[0]?.message).not.toContain("maintained-package");
  });

  it.each([
    ["mature_package", "mature-package"],
    ["@other/mature-package", "@scope/mature-package"],
    ["lodahs", "lodash"],
    ["lodxsh", "lodash"],
    ["expresss", "express"],
    ["expres", "express"],
  ])("PG005 conservatively identifies confusable name %s", (name, existing) => {
    const result = evaluatePolicy({
      config,
      existingDependencies: [existing],
      now,
      providerResult: success({ name }),
      spec: parseNpmSpec(`${name}@1.0.0`),
    });
    expect(result.findings.map((finding) => finding.ruleId)).toContain("PG005");
  });

  it("does not flag unrelated or identical existing dependencies", () => {
    const result = evaluatePolicy({
      config,
      existingDependencies: ["mature-package", "different-package"],
      now,
      providerResult: success(),
      spec: parseNpmSpec("mature-package@1.0.0"),
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("PG005");
  });

  it.each([
    ["abc", "abd"],
    ["lxdasy", "lodash"],
    ["xxxxxx", "lodash"],
    ["long-name", "tiny"],
  ])("does not flag weak similarity %s to %s", (name, existing) => {
    const result = evaluatePolicy({
      config,
      existingDependencies: [existing],
      now,
      providerResult: success({ name }),
      spec: parseNpmSpec(`${name}@1.0.0`),
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("PG005");
  });

  it("PG006 warns when repository metadata is missing", () => {
    const data = metadata();
    delete data.repositoryUrl;
    const result = evaluate({
      data,
      fetchedAt: "2026-08-19T17:59:00.000Z",
      ok: true,
      status: "ok",
    });
    expect(result.findings[0]).toMatchObject({ ruleId: "PG006", verdict: "warn" });
  });

  it("PG007 reviews configured lifecycle scripts without retaining their bodies", () => {
    const result = evaluate(success({ lifecycleScripts: ["postinstall", "prepare"] }));
    const finding = result.findings.find((candidate) => candidate.ruleId === "PG007");
    expect(finding).toMatchObject({ severity: "high", verdict: "review" });
    expect(finding?.message).toContain("postinstall, prepare");
  });

  it("does not flag lifecycle names excluded by policy", () => {
    const custom = agentHawkConfigSchema.parse({
      version: 1,
      rules: { lifecycleScripts: { action: "review", scripts: ["postinstall"] } },
    });
    const result = evaluatePolicy({
      config: custom,
      now,
      providerResult: success({ lifecycleScripts: ["prepare"] }),
      spec: parseNpmSpec("mature-package@1.0.0"),
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("PG007");
  });

  it("suppresses a rule explicitly configured to allow", () => {
    const custom = agentHawkConfigSchema.parse({
      version: 1,
      rules: { requireRepositoryUrl: { action: "allow" } },
    });
    const data = metadata();
    delete data.repositoryUrl;
    const result = evaluatePolicy({
      config: custom,
      now,
      providerResult: {
        data,
        fetchedAt: "2026-08-19T17:59:00.000Z",
        ok: true,
        status: "ok",
      },
      spec: parseNpmSpec("mature-package"),
    });
    expect(result.findings.map((finding) => finding.ruleId)).not.toContain("PG006");
  });

  it.each([
    "alias@npm:real-package@1.0.0",
    "package@workspace:*",
    "package@file:../package",
    "package@https://example.test/package.tgz",
    "owner/repository#main",
    "../local-package",
  ])("PG015 reviews non-registry input %s without provider evidence", (raw) => {
    const result = evaluatePolicy({ config, now, spec: parseNpmSpec(raw) });
    expect(result).toMatchObject({ verdict: "review" });
    expect(result.findings[0]).toMatchObject({ ruleId: "PG015" });
  });

  it("permits non-registry input only when policy explicitly allows it", () => {
    const permissive = agentHawkConfigSchema.parse({
      version: 1,
      rules: { nonRegistrySpecifier: { action: "allow" } },
    });
    expect(
      evaluatePolicy({ config: permissive, now, spec: parseNpmSpec("owner/repository#main") }),
    ).toEqual({ errors: [], findings: [], verdict: "allow" });
  });
});

describe("provider failure and precedence", () => {
  it.each([
    "timeout",
    "rate_limited",
    "invalid_response",
    "network_error",
    "provider_error",
  ] as const)("PG013 reviews redacted %s provider failure", (status) => {
    const result = evaluate(failure(status, "token=must-not-be-reflected"));
    expect(result).toMatchObject({ verdict: "review" });
    expect(result.findings[0]).toMatchObject({ approvable: true, ruleId: "PG013" });
    expect(result.findings[0]?.message).not.toContain("must-not-be-reflected");
  });

  it("PG013 becomes a non-approvable error in strict mode", () => {
    const strict = agentHawkConfigSchema.parse({ version: 1, mode: "strict" });
    const result = evaluatePolicy({
      config: strict,
      now,
      providerResult: failure("timeout", "Provider request timed out."),
      spec: parseNpmSpec("mature-package"),
    });
    expect(result).toMatchObject({ verdict: "error" });
    expect(result.errors[0]).toMatchObject({ code: "required_provider_unavailable" });
    expect(result.findings[0]).toMatchObject({ approvable: false, verdict: "review" });
  });

  it("honors onProviderError error independently of strict mode", () => {
    const providerErrorsAreFatal = agentHawkConfigSchema.parse({
      version: 1,
      defaults: { onProviderError: "error" },
    });
    const result = evaluatePolicy({
      config: providerErrorsAreFatal,
      now,
      providerResult: failure("network_error"),
      spec: parseNpmSpec("mature-package"),
    });
    expect(result.verdict).toBe("error");
    expect(result.errors[0]?.code).toBe("required_provider_unavailable");
  });

  it("enforces onUnknownVersion error policy without widening finding verdicts", () => {
    const unknownIsError = agentHawkConfigSchema.parse({
      version: 1,
      defaults: { onUnknownVersion: "error" },
    });
    const result = evaluatePolicy({
      config: unknownIsError,
      now,
      providerResult: failure("not_found", "not found"),
      spec: parseNpmSpec("mature-package@99.0.0"),
    });
    expect(result.verdict).toBe("error");
    expect(result.errors[0]?.code).toBe("unknown_version");
    expect(result.findings[0]).toMatchObject({ ruleId: "PG001", verdict: "block" });
  });

  it("PG013 prevents allow when the npm provider is disabled or omitted", () => {
    const disabled = agentHawkConfigSchema.parse({
      version: 1,
      registries: { npm: { enabled: false } },
    });
    const disabledResult = evaluatePolicy({
      config: disabled,
      now,
      spec: parseNpmSpec("mature-package"),
    });
    const omittedResult = evaluatePolicy({
      config,
      now,
      spec: parseNpmSpec("mature-package"),
    });
    expect(disabledResult.findings[0]?.ruleId).toBe("PG013");
    expect(omittedResult.findings[0]?.ruleId).toBe("PG013");
  });

  it("PG013 prevents allow when required timestamps are absent or invalid", () => {
    const data = metadata({ releasePublishedAt: "future" });
    delete data.packagePublishedAt;
    const result = evaluate({
      data,
      fetchedAt: "2026-08-19T17:59:00.000Z",
      ok: true,
      status: "ok",
    });
    expect(result.findings.map((finding) => finding.ruleId)).toContain("PG013");
    expect(result.verdict).toBe("review");
  });

  it("makes incomplete timestamps fatal in strict mode", () => {
    const strict = agentHawkConfigSchema.parse({ version: 1, mode: "strict" });
    const data = metadata();
    delete data.releasePublishedAt;
    const result = evaluatePolicy({
      config: strict,
      now,
      providerResult: {
        data,
        fetchedAt: "2026-08-19T17:59:00.000Z",
        ok: true,
        status: "ok",
      },
      spec: parseNpmSpec("mature-package"),
    });
    expect(result.verdict).toBe("error");
    expect(result.errors[0]?.code).toBe("required_provider_unavailable");
  });

  it("handles invalid resolved versions according to onUnknownVersion", () => {
    const reviewResult = evaluate(success({ resolvedVersion: "not-semver" }));
    const errorConfig = agentHawkConfigSchema.parse({
      version: 1,
      defaults: { onUnknownVersion: "error" },
    });
    const errorResult = evaluatePolicy({
      config: errorConfig,
      now,
      providerResult: success({ resolvedVersion: "not-semver" }),
      spec: parseNpmSpec("mature-package"),
    });
    expect(reviewResult).toMatchObject({ errors: [], verdict: "review" });
    expect(errorResult).toMatchObject({ verdict: "error" });
    expect(errorResult.errors[0]?.code).toBe("unknown_version");
  });

  it("treats future publication timestamps as unavailable evidence", () => {
    const result = evaluate(success({ releasePublishedAt: "2027-01-01T00:00:00.000Z" }));
    expect(result.findings.map((finding) => finding.ruleId)).toContain("PG013");
  });

  it("rejects impossible calendar timestamps and invalid evidence retrieval time", () => {
    const impossible = evaluate(success({ packagePublishedAt: "2026-02-30T00:00:00.000Z" }));
    const invalidFetchTime = evaluate({
      data: metadata(),
      fetchedAt: "2026-02-30T00:00:00.000Z",
      ok: true,
      status: "ok",
    });
    expect(impossible.findings.map((finding) => finding.ruleId)).toContain("PG013");
    expect(invalidFetchTime.findings[0]?.ruleId).toBe("PG013");
  });

  it("uses provider-owned retrieval time in normalized evidence", () => {
    const result = evaluate(success({ deprecated: "deprecated" }));
    expect(result.findings[0]?.evidence[0]?.fetchedAt).toBe("2026-08-19T17:59:00.000Z");
    expect(result.findings[0]?.evidence[0]?.fetchedAt).not.toBe(now.toISOString());
  });

  it("uses stable error > block > review > warn > allow precedence", () => {
    expect(combineVerdicts(["warn", "allow"])).toBe("warn");
    expect(combineVerdicts(["review", "block", "warn"])).toBe("block");
    expect(combineVerdicts(["block", "error"])).toBe("error");
    expect(combineVerdicts([])).toBe("allow");
  });

  it("rejects an invalid evaluation clock", () => {
    expect(() =>
      evaluatePolicy({
        config,
        now: new Date("invalid"),
        providerResult: success(),
        spec: parseNpmSpec("mature-package"),
      }),
    ).toThrow(TypeError);
  });
});
