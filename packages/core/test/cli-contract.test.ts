import { describe, expect, it } from "vitest";
import {
  cliErrorReportSchema,
  diffReportSchema,
  inventoryReportSchema,
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
