import { describe, expect, it } from "vitest";
import {
  approvalValidationReportSchema,
  cliErrorReportSchema,
  diffReportSchema,
  inventoryReportSchema,
  policyValidationReportSchema,
  scanReportSchema,
} from "../src/index.js";

describe("CLI JSON contract", () => {
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
