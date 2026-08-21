import {
  AGENTHAWK_VERSION,
  type ApprovalFile,
  approvalFileSchema,
  approvalValidationReportSchema,
  cliErrorReportSchema,
  summarizeApprovalTimes,
} from "@agenthawk/core";
import {
  type CheckResult,
  type OutputFormat,
  PolicyInputError,
  readApprovalFile,
  stableDigest,
} from "./check.js";
import { escapeTerminal } from "./terminal.js";

export interface ApprovalVerifyOptions {
  format: OutputFormat;
}

export interface ApprovalVerifyDependencies {
  now?: () => Date;
  readApprovals?: (path: string, required: boolean) => Promise<unknown | undefined>;
}

export async function verifyApprovalFile(
  path: string,
  options: ApprovalVerifyOptions,
  dependencies: ApprovalVerifyDependencies = {},
): Promise<CheckResult> {
  try {
    const approvals = approvalFileSchema.parse(
      await (dependencies.readApprovals ?? readApprovalFile)(path, true),
    );
    const summary = summarizeApprovalTimes(approvals, (dependencies.now ?? (() => new Date()))());
    const report = approvalValidationReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: AGENTHAWK_VERSION,
      command: "approvals_verify",
      valid: true,
      approvalVersion: approvals.version,
      approvalCount: approvals.approvals.length,
      ...summary,
      approvalDigest: stableDigest(normalizedApprovalSemantics(approvals)),
    });
    return {
      exitCode: 0,
      output:
        options.format === "json"
          ? `${JSON.stringify(report)}\n`
          : [
              `AgentHawk v${AGENTHAWK_VERSION}`,
              "",
              "Approvals: valid",
              `Version: ${report.approvalVersion}`,
              `Records: ${report.approvalCount}`,
              `Time-eligible: ${report.timeEligibleCount}`,
              `Expired: ${report.expiredCount}`,
              `Not yet effective: ${report.notYetEffectiveCount}`,
              `Checked: ${report.checkedAt}`,
              `Digest: ${report.approvalDigest}`,
              "",
              "No approval was applied.",
              "No provider was contacted.",
              "",
            ].join("\n"),
    };
  } catch (error) {
    const invalid =
      error instanceof PolicyInputError || (error instanceof Error && error.name === "ZodError");
    const exitCode = invalid ? 2 : 4;
    const message =
      error instanceof PolicyInputError
        ? error.message
        : invalid
          ? "Approval file is invalid."
          : "Unexpected internal error.";
    return {
      exitCode,
      output:
        options.format === "json"
          ? `${JSON.stringify(
              cliErrorReportSchema.parse({
                schemaVersion: "1.0",
                error: { code: invalid ? "invalid_input" : "internal_error", message },
                exitCode,
              }),
            )}\n`
          : `AgentHawk: ${escapeTerminal(message)}\n`,
    };
  }
}

function normalizedApprovalSemantics(file: ApprovalFile): ApprovalFile {
  return {
    version: file.version,
    approvals: file.approvals
      .map((record) => ({
        ...record,
        approvedAt: new Date(record.approvedAt).toISOString(),
        expiresAt: new Date(record.expiresAt).toISOString(),
      }))
      .sort((left, right) =>
        `${left.ecosystem}\0${left.name}\0${left.version}`.localeCompare(
          `${right.ecosystem}\0${right.name}\0${right.version}`,
        ),
      ),
  };
}
