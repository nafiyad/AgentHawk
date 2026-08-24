import { describe, expect, it } from "vitest";
import {
  approvalValidationReportSchema,
  claudeProjectHookStatusReportSchema,
  cliErrorReportSchema,
  codexProjectHookLifecycleReportSchema,
  codexProjectHookStatusReportSchema,
  diffReportSchema,
  doctorReportSchema,
  initReportSchema,
  inventoryReportSchema,
  policyValidationReportSchema,
  scanReportSchema,
} from "../src/index.js";

describe("CLI JSON contract", () => {
  it("enforces closed and internally consistent Claude project-hook preflight reports", () => {
    const healthy = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "integrations_claude_status",
      localSettings: "absent",
      sharedSettings: "absent",
      sharedPreToolUse: "absent",
      sharedDisableAllHooks: false,
      localSettingsIgnored: "ignored",
      blockers: [],
      activation: "unproven",
      providersContacted: false,
      exitCodeMeaning: "future_installation_precondition_met",
    } as const;
    expect(claudeProjectHookStatusReportSchema.parse(healthy)).toEqual(healthy);

    const blocked = {
      ...healthy,
      localSettings: "unsafe",
      sharedSettings: "unsafe",
      sharedPreToolUse: "unknown",
      sharedDisableAllHooks: "unknown",
      localSettingsIgnored: "unknown",
      blockers: [
        "local_settings_unsafe",
        "shared_settings_unsafe",
        "ignore_status_unavailable",
        "linked_worktree",
      ],
      exitCodeMeaning: "attention_required",
    } as const;
    expect(claudeProjectHookStatusReportSchema.parse(blocked)).toEqual(blocked);
    for (const candidate of [
      { ...healthy, privatePath: "/private" },
      { ...healthy, activation: "active" },
      { ...healthy, blockers: ["local_settings_not_ignored"] },
      { ...healthy, exitCodeMeaning: "attention_required" },
      { ...blocked, blockers: [...blocked.blockers].reverse() },
      { ...blocked, blockers: [...blocked.blockers, "linked_worktree"] },
      { ...blocked, sharedPreToolUse: "absent" },
    ]) {
      expect(claudeProjectHookStatusReportSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("enforces closed and internally consistent Codex project-hook lifecycle reports", () => {
    const installed = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "integrations_codex_install",
      outcome: "installed",
      ownership: "owned_exact",
      readiness: "current",
      blockers: [],
      providersContacted: false,
    } as const;
    expect(codexProjectHookLifecycleReportSchema.parse(installed)).toEqual(installed);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...installed,
        ownership: "owned_inactive",
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...installed,
        outcome: "removed",
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({ ...installed, privatePath: "C:/secret" })
        .success,
    ).toBe(false);
    const removed = {
      ...installed,
      command: "integrations_codex_remove",
      outcome: "removed",
      ownership: "absent",
      readiness: "not_applicable",
    } as const;
    expect(codexProjectHookLifecycleReportSchema.parse(removed)).toEqual(removed);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...removed,
        blockers: ["operation_locked"],
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...removed,
        blockers: ["linked_worktree", "config_collision"],
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...removed,
        blockers: ["config_collision", "config_collision"],
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookLifecycleReportSchema.safeParse({
        ...removed,
        outcome: "recovery_required",
        ownership: "owned_inactive",
        readiness: "current",
        blockers: ["operation_locked"],
      }).success,
    ).toBe(true);
  });

  it("enforces closed and internally consistent Codex project-hook status reports", () => {
    const report = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "integrations_codex_status",
      ownership: "owned_exact",
      readiness: "current",
      blockers: ["config_collision", "operation_locked", "linked_worktree"],
      providersContacted: false,
    } as const;
    expect(codexProjectHookStatusReportSchema.parse(report)).toEqual(report);
    expect(
      codexProjectHookStatusReportSchema.safeParse({
        ...report,
        blockers: ["linked_worktree", "config_collision"],
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookStatusReportSchema.safeParse({
        ...report,
        blockers: ["config_collision", "config_collision"],
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookStatusReportSchema.safeParse({ ...report, readiness: "not_applicable" })
        .success,
    ).toBe(false);
    expect(
      codexProjectHookStatusReportSchema.safeParse({
        ...report,
        remediation: "install_available",
      }).success,
    ).toBe(false);
    expect(
      codexProjectHookStatusReportSchema.safeParse({
        ...report,
        ownership: "absent",
        readiness: "not_applicable",
        privatePath: "/private/repository",
      }).success,
    ).toBe(false);
  });

  it("accepts the versioned error envelope and rejects unknown fields", () => {
    const error = {
      schemaVersion: "1.0",
      error: { code: "invalid_input", message: "Invalid package specification." },
      exitCode: 2,
    };
    expect(cliErrorReportSchema.parse(error)).toEqual(error);
    expect(cliErrorReportSchema.safeParse({ ...error, detail: "unstable" }).success).toBe(false);
    expect(cliErrorReportSchema.safeParse({ ...error, exitCode: 0 }).success).toBe(false);
    expect(
      cliErrorReportSchema.safeParse({
        ...error,
        error: { ...error.error, code: "internal_error" },
      }).success,
    ).toBe(false);
    expect(
      cliErrorReportSchema.safeParse({
        ...error,
        error: { ...error.error, code: "output_limit" },
        exitCode: 4,
      }).success,
    ).toBe(false);
  });

  it("bounds and strictly validates inventory reports", () => {
    const report = {
      schemaVersion: "1.0",
      manifest: "package.json",
      dependencies: [{ name: "example", requestedSpec: "1.0.0", section: "dependencies" }],
    };
    expect(inventoryReportSchema.parse(report)).toEqual(report);
    expect(
      inventoryReportSchema.safeParse({
        ...report,
        dependencies: Array(65).fill(report.dependencies[0]),
      }).success,
    ).toBe(false);
  });

  it("strictly validates policy-validation reports", () => {
    const report = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "policy_validate",
      valid: true,
      policyVersion: 1,
      mode: "strict",
      policyDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(policyValidationReportSchema.parse(report)).toEqual(report);
    expect(
      policyValidationReportSchema.safeParse({ ...report, path: "C:/private/policy.yml" }).success,
    ).toBe(false);
    expect(policyValidationReportSchema.safeParse({ ...report, valid: false }).success).toBe(false);
    expect(policyValidationReportSchema.safeParse({ ...report, mode: "audit" }).success).toBe(
      false,
    );
    expect(
      policyValidationReportSchema.safeParse({ ...report, toolVersion: "x".repeat(129) }).success,
    ).toBe(false);
  });

  it("binds initialization reports to exact deterministic targets", () => {
    const report = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "init",
      initialized: true,
      integration: "cursor",
      policyVersion: 1,
      templateVersion: 1,
      created: ["policy", "cursor"],
      unchanged: [],
      providersContacted: false,
    };
    expect(initReportSchema.parse(report)).toEqual(report);
    expect(initReportSchema.safeParse({ ...report, created: ["cursor", "policy"] }).success).toBe(
      false,
    );
    expect(
      initReportSchema.safeParse({ ...report, created: ["policy"], unchanged: ["policy"] }).success,
    ).toBe(false);
    expect(initReportSchema.safeParse({ ...report, created: ["policy"] }).success).toBe(false);
    expect(initReportSchema.safeParse({ ...report, integration: "github" }).success).toBe(false);
    expect(initReportSchema.safeParse({ ...report, path: "C:/private" }).success).toBe(false);
    expect(initReportSchema.safeParse({ ...report, providersContacted: true }).success).toBe(false);
  });

  it("strictly validates bounded approval-verification reports and count consistency", () => {
    const report = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "approvals_verify",
      valid: true,
      approvalVersion: 1,
      approvalCount: 3,
      timeEligibleCount: 1,
      expiredCount: 1,
      notYetEffectiveCount: 1,
      checkedAt: "2026-08-21T15:00:00.000Z",
      approvalDigest: `sha256:${"a".repeat(64)}`,
    };
    expect(approvalValidationReportSchema.parse(report)).toEqual(report);
    expect(
      approvalValidationReportSchema.safeParse({ ...report, path: "private.yml" }).success,
    ).toBe(false);
    expect(approvalValidationReportSchema.safeParse({ ...report, expiredCount: 2 }).success).toBe(
      false,
    );
    expect(
      approvalValidationReportSchema.safeParse({ ...report, approvalCount: 1_025 }).success,
    ).toBe(false);
  });

  it("binds doctor readiness to its strict component states", () => {
    const report = {
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "doctor",
      checkedAt: "2026-08-21T22:00:00.000Z",
      supportDataAsOf: "2026-08-21",
      ready: true,
      runtime: {
        nodeVersion: "24.19.0",
        nodeRange: "^22.0.0 || ^24.0.0",
        declaredCompatible: true,
        upstreamSupported: true,
        ciTestedPlatform: true,
        platform: "linux",
        architecture: "x64",
      },
      packages: { cliVersion: "0.1.0-alpha.1", coreVersion: "0.1.0-alpha.1", aligned: true },
      cache: { state: "writable" },
      configuration: { policy: "absent", approvals: "absent" },
      git: { state: "available" },
      integrations: {
        codex: "absent",
        claudeCode: "absent",
        cursor: "absent",
        githubActions: "absent",
      },
      providersContacted: false,
    };
    expect(doctorReportSchema.parse(report)).toEqual(report);
    expect(doctorReportSchema.safeParse({ ...report, ready: false }).success).toBe(false);
    expect(
      doctorReportSchema.safeParse({ ...report, cache: { state: "unwritable" } }).success,
    ).toBe(false);
    expect(doctorReportSchema.safeParse({ ...report, cwd: "/private/repo" }).success).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ...report,
        runtime: { ...report.runtime, nodeVersion: "20.20.2" },
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ...report,
        packages: { ...report.packages, coreVersion: "0.1.0-alpha.2" },
      }).success,
    ).toBe(false);
    expect(
      doctorReportSchema.safeParse({
        ...report,
        runtime: { ...report.runtime, platform: "other" },
      }).success,
    ).toBe(false);
    for (const nodeVersion of [
      "22.01.0",
      "022.0.0",
      "24.019.0",
      "22.9007199254740992.0",
      "24.0.9007199254740992",
    ]) {
      expect(
        doctorReportSchema.safeParse({
          ...report,
          runtime: { ...report.runtime, nodeVersion },
        }).success,
      ).toBe(false);
    }
    for (const checkedAt of [
      "2026-02-30T22:00:00.000Z",
      "2026-13-01T22:00:00.000Z",
      "2026-01-01T24:00:00.000Z",
    ]) {
      expect(doctorReportSchema.safeParse({ ...report, checkedAt }).success).toBe(false);
    }
  });

  it("rejects incomplete nested scan reports", () => {
    expect(
      scanReportSchema.safeParse({
        schemaVersion: "1.0",
        manifest: "package.json",
        verdict: "allow",
        results: [{ section: "dependencies", report: { schemaVersion: "1.0" } }],
      }).success,
    ).toBe(false);
  });

  it("binds diff reports to resolved commits and known verdicts", () => {
    const report = {
      schemaVersion: "1.0",
      base: "origin/main",
      baseCommit: "a".repeat(40),
      manifest: "package.json",
      changes: [],
      lockfiles: { present: ["pnpm-lock.yaml"], updated: [] },
      findings: [],
      verdict: "allow",
    };
    expect(diffReportSchema.parse(report)).toEqual(report);
    expect(diffReportSchema.safeParse({ ...report, verdict: "warn" }).success).toBe(false);
    expect(diffReportSchema.safeParse({ ...report, base: "x".repeat(513) }).success).toBe(false);
    expect(
      diffReportSchema.safeParse({
        ...report,
        lockfiles: { present: ["unknown.lock"], updated: [] },
      }).success,
    ).toBe(false);
  });
});
