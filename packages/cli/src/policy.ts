import {
  AGENTHAWK_VERSION,
  agentHawkConfigSchema,
  cliErrorReportSchema,
  policyValidationReportSchema,
} from "@agenthawk/core";
import {
  type CheckResult,
  type OutputFormat,
  PolicyInputError,
  readPolicyFile,
  stableDigest,
} from "./check.js";
import { escapeTerminal } from "./terminal.js";

export interface PolicyValidateOptions {
  format: OutputFormat;
}

export interface PolicyValidateDependencies {
  readPolicy?: (path: string) => Promise<unknown>;
}

export async function validatePolicyFile(
  path: string,
  options: PolicyValidateOptions,
  dependencies: PolicyValidateDependencies = {},
): Promise<CheckResult> {
  try {
    const config = agentHawkConfigSchema.parse(
      await (dependencies.readPolicy ?? readPolicyFile)(path),
    );
    const report = policyValidationReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: AGENTHAWK_VERSION,
      command: "policy_validate",
      valid: true,
      policyVersion: config.version,
      mode: config.mode,
      policyDigest: stableDigest(config),
    });
    return {
      exitCode: 0,
      output:
        options.format === "json"
          ? `${JSON.stringify(report)}\n`
          : [
              `AgentHawk v${AGENTHAWK_VERSION}`,
              "",
              "Policy: valid",
              `Version: ${report.policyVersion}`,
              `Mode: ${report.mode}`,
              `Digest: ${report.policyDigest}`,
              "",
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
          ? "Policy configuration is invalid."
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
