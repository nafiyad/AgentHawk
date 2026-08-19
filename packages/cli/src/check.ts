import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import {
  type ApprovalFile,
  agentHawkConfigSchema,
  applyApprovals,
  approvalFileSchema,
  type EvaluationReport,
  evaluatePolicy,
  evaluationReportSchema,
  type NpmProviderResult,
  NpmRegistryProvider,
  type ProviderStatus,
  parseNpmSpec,
  type Verdict,
} from "@agenthawk/core";
import { parseDocument } from "yaml";
import { escapeTerminal } from "./terminal.js";

const maximumPolicyBytes = 256 * 1_024;

export type OutputFormat = "json" | "terminal";

export interface CheckOptions {
  approvalsPath?: string;
  format: OutputFormat;
  policyPath?: string;
  registryUrl?: string;
  strict: boolean;
}

export interface CheckResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  output: string;
}

export interface CheckDependencies {
  getPackage?: (name: string, requestedSpec: string) => Promise<NpmProviderResult>;
  now?: () => Date;
  readPolicy?: (path: string) => Promise<unknown>;
  readApprovals?: (path: string, required: boolean) => Promise<unknown | undefined>;
}

export async function checkNpmPackage(
  rawSpec: string,
  options: CheckOptions,
  dependencies: CheckDependencies = {},
): Promise<CheckResult> {
  try {
    const spec = parseNpmSpec(rawSpec);
    const now = (dependencies.now ?? (() => new Date()))();
    const baseConfig = options.policyPath
      ? agentHawkConfigSchema.parse(
          await (dependencies.readPolicy ?? readPolicyFile)(options.policyPath),
        )
      : agentHawkConfigSchema.parse({ version: 1 });
    const config = options.strict
      ? agentHawkConfigSchema.parse({ ...baseConfig, mode: "strict" })
      : baseConfig;
    const approvalPath = options.approvalsPath ?? ".agenthawk/approvals.yml";
    const approvalDocument = await (dependencies.readApprovals ?? readApprovalFile)(
      approvalPath,
      options.approvalsPath !== undefined,
    );
    const approvals: ApprovalFile = approvalDocument
      ? approvalFileSchema.parse(approvalDocument)
      : approvalFileSchema.parse({ version: 1, approvals: [] });

    const providerResult =
      spec.type === "registry"
        ? await (dependencies.getPackage ?? defaultGetPackage(options.registryUrl))(
            spec.name,
            spec.requestedSpec,
          )
        : undefined;
    const evaluation = evaluatePolicy({
      config,
      now,
      ...(providerResult ? { providerResult } : {}),
      spec,
    });
    const target =
      spec.type === "registry"
        ? {
            ecosystem: "npm" as const,
            name: spec.name,
            requestedSpec: spec.requestedSpec,
            ...(providerResult?.ok ? { resolvedVersion: providerResult.data.resolvedVersion } : {}),
          }
        : {
            ecosystem: "npm" as const,
            name: spec.name ?? "non-registry",
            requestedSpec: spec.raw,
          };
    const approvalApplication = applyApprovals({
      approvals,
      config,
      errors: evaluation.errors,
      findings: evaluation.findings,
      now,
      target,
    });
    const exitCode =
      approvalApplication.verdict === "error"
        ? 3
        : strictExitCode(approvalApplication.verdict, options.strict);
    const report = evaluationReportSchema.parse({
      schemaVersion: "1.0",
      toolVersion: "0.0.0",
      generatedAt: now.toISOString(),
      target,
      verdict: approvalApplication.verdict,
      originalVerdict: approvalApplication.originalVerdict,
      findings: evaluation.findings,
      providerStatus: providerStatuses(providerResult),
      policyDigest: digest(config),
      evidenceDigest: digest(normalizedEvidenceForDigest(providerResult, spec.type)),
      ...(approvalApplication.approval ? { approval: approvalApplication.approval } : {}),
      exitCodeMeaning: exitMeaning(exitCode),
    });
    return {
      exitCode,
      output: options.format === "json" ? renderJson(report) : renderTerminal(report),
    };
  } catch (error) {
    const invalid = isExpectedInputError(error);
    const exitCode = invalid ? 2 : 4;
    const message = invalid ? safeMessage(error) : "Unexpected internal error.";
    return {
      exitCode,
      output:
        options.format === "json"
          ? `${JSON.stringify({ error: message, exitCodeMeaning: exitMeaning(exitCode) })}\n`
          : `AgentHawk: ${escapeTerminal(message)}\n`,
    };
  }
}

function defaultGetPackage(registryUrl?: string) {
  let provider: NpmRegistryProvider;
  try {
    provider = new NpmRegistryProvider({ ...(registryUrl ? { registryUrl } : {}) });
  } catch {
    throw new PolicyInputError("Registry URL is invalid or unsafe.");
  }
  return async (name: string, requestedSpec: string) =>
    provider.getPackage({ ecosystem: "npm", name, requestedSpec });
}

export async function readPolicyFile(path: string, openFile: typeof open = open): Promise<unknown> {
  const document = await readYamlFile(path, true, openFile, "Policy");
  if (document === undefined) throw new PolicyInputError("Policy file could not be read.");
  return document;
}

export async function readApprovalFile(
  path: string,
  required: boolean,
  openFile: typeof open = open,
): Promise<unknown | undefined> {
  return await readYamlFile(path, required, openFile, "Approval");
}

async function readYamlFile(
  path: string,
  required: boolean,
  openFile: typeof open,
  kind: "Approval" | "Policy",
): Promise<unknown | undefined> {
  let handle: FileHandle;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if (!required && isMissingFile(error)) return undefined;
    throw new PolicyInputError(`${kind} file could not be read.`);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximumPolicyBytes) {
      throw new PolicyInputError(`${kind} file must be a regular file no larger than 256 KiB.`);
    }
    const buffer = Buffer.alloc(maximumPolicyBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maximumPolicyBytes) {
      throw new PolicyInputError(`${kind} file exceeded the 256 KiB limit.`);
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new PolicyInputError(`${kind} file must be valid UTF-8.`);
    }
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) throw new PolicyInputError(`${kind} file is invalid YAML.`);
    try {
      return document.toJS({ maxAliasCount: 0 });
    } catch {
      throw new PolicyInputError(`${kind} file contains unsupported aliases.`);
    }
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function providerStatuses(result: NpmProviderResult | undefined): ProviderStatus[] {
  if (!result) return [];
  if (result.ok) return [{ fetchedAt: result.fetchedAt, provider: "npm", status: "ok" }];
  const status =
    result.status === "timeout" || result.status === "rate_limited"
      ? result.status
      : result.status === "network_error"
        ? "offline"
        : "error";
  return [
    { fetchedAt: result.fetchedAt, message: "npm provider unavailable", provider: "npm", status },
  ];
}

function strictExitCode(verdict: Verdict, strict: boolean): 0 | 1 {
  return strict && (verdict === "review" || verdict === "block") ? 1 : 0;
}

function exitMeaning(exitCode: number): string {
  const meanings: Record<number, string> = {
    0: "allowed; warnings or non-strict findings may exist",
    1: "review or block finding in strict mode",
    2: "invalid input or policy",
    3: "required provider or evaluation error",
    4: "unexpected internal error",
  };
  return meanings[exitCode] ?? "unexpected internal error";
}

function renderJson(report: EvaluationReport): string {
  return `${JSON.stringify(report)}\n`;
}

function renderTerminal(report: EvaluationReport): string {
  const lines = [
    "AgentHawk v0.0.0",
    "",
    `Target: npm:${escapeTerminal(report.target.name)}@${escapeTerminal(report.target.resolvedVersion ?? report.target.requestedSpec)}`,
    `Verdict: ${report.verdict.toUpperCase()}`,
    "",
  ];
  for (const finding of report.findings) {
    lines.push(
      `${finding.verdict.toUpperCase().padEnd(6)} ${finding.ruleId}  ${escapeTerminal(finding.message)}`,
    );
  }
  if (report.findings.length === 0) lines.push("No policy findings.");
  if (report.approval) {
    lines.push(
      "",
      `Approval: ${escapeTerminal(report.approval.approvedBy)} (expires ${report.approval.expiresAt})`,
    );
  }
  lines.push(
    "",
    `Policy: ${report.policyDigest}`,
    `Evidence: ${report.evidenceDigest}`,
    "",
    "No package was installed.",
  );
  return `${lines.join("\n")}\n`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function normalizedEvidenceForDigest(
  result: NpmProviderResult | undefined,
  specType: "non_registry" | "registry",
): unknown {
  if (!result) return { specType };
  return result.ok
    ? { data: result.data, fetchedAt: result.fetchedAt, status: result.status }
    : { fetchedAt: result.fetchedAt, status: result.status };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isExpectedInputError(error: unknown): boolean {
  return (
    error instanceof PolicyInputError ||
    (error instanceof Error && error.name === "ZodError") ||
    (error instanceof Error && error.name === "NpmSpecError")
  );
}

function safeMessage(error: unknown): string {
  if (error instanceof PolicyInputError) return error.message;
  if (error instanceof Error && error.name === "NpmSpecError") return escapeTerminal(error.message);
  return "Policy configuration is invalid.";
}

class PolicyInputError extends Error {}
