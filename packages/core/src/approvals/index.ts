import { valid } from "semver";
import { z } from "zod";
import type { AgentHawkConfig } from "../config.js";
import type { ApprovalMatch, Finding, PackageCoordinate, Verdict } from "../domain.js";
import { parseNpmSpec } from "../npm/spec.js";
import { combineVerdicts } from "../policy/engine.js";
import { parseStrictIsoTimestamp, validClockValue } from "../time.js";

const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !hasControlCharacter(value), "Control characters are not allowed.");

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function isExactNpmName(value: string): boolean {
  try {
    const parsed = parseNpmSpec(`${value}@1.0.0`);
    return parsed.type === "registry" && parsed.name === value;
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const timestampSchema = z.string().refine((value) => parseStrictIsoTimestamp(value) !== undefined, {
  message: "Approval timestamp must be a strict ISO 8601 instant.",
});

export const approvalRecordSchema = z
  .object({
    ecosystem: z.literal("npm"),
    name: z
      .string()
      .min(1)
      .refine(isExactNpmName, "Name must be an exact normalized npm package name."),
    version: z.string().refine((value) => valid(value) === value, "Version must be exact SemVer."),
    approvedBy: safeTextSchema,
    approvedAt: timestampSchema,
    expiresAt: timestampSchema,
    reason: safeTextSchema,
    issue: z.url().refine(isHttpsUrl, "Issue URL must use HTTPS.").optional(),
  })
  .strict()
  .superRefine((record, context) => {
    const approvedAt = parseStrictIsoTimestamp(record.approvedAt);
    const expiresAt = parseStrictIsoTimestamp(record.expiresAt);
    if (approvedAt !== undefined && expiresAt !== undefined && expiresAt <= approvedAt) {
      context.addIssue({ code: "custom", message: "Approval expiry must follow approval time." });
    }
  });
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export const approvalFileSchema = z
  .object({ version: z.literal(1), approvals: z.array(approvalRecordSchema) })
  .strict()
  .superRefine((file, context) => {
    const coordinates = new Set<string>();
    for (const [index, record] of file.approvals.entries()) {
      const coordinate = `${record.ecosystem}\0${record.name}\0${record.version}`;
      if (coordinates.has(coordinate)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate approval coordinate.",
          path: ["approvals", index],
        });
      }
      coordinates.add(coordinate);
    }
  });
export type ApprovalFile = z.infer<typeof approvalFileSchema>;

export interface ApprovalApplication {
  approval?: ApprovalMatch;
  originalVerdict: Verdict;
  verdict: Verdict;
}

export function applyApprovals(input: {
  approvals: ApprovalFile;
  config: AgentHawkConfig;
  errors: readonly unknown[];
  findings: readonly Finding[];
  now: Date;
  target: PackageCoordinate;
}): ApprovalApplication {
  const now = parseStrictIsoTimestamp(validClockValue(input.now, "Approval clock"));
  const originalVerdict =
    input.errors.length > 0
      ? "error"
      : combineVerdicts(input.findings.map((finding) => finding.verdict));
  if (now === undefined || !input.target.resolvedVersion) {
    return { originalVerdict, verdict: originalVerdict };
  }

  const match = input.approvals.approvals.find((record) => {
    const approvedAt = parseStrictIsoTimestamp(record.approvedAt);
    const expiresAt = parseStrictIsoTimestamp(record.expiresAt);
    return (
      record.ecosystem === input.target.ecosystem &&
      record.name === input.target.name &&
      record.version === input.target.resolvedVersion &&
      approvedAt !== undefined &&
      approvedAt <= now &&
      expiresAt !== undefined &&
      expiresAt > now &&
      expiresAt - approvedAt <= input.config.approvals.maxValidityDays * 86_400_000
    );
  });
  if (!match || originalVerdict === "error") {
    return { originalVerdict, verdict: originalVerdict };
  }

  const resolvable = input.findings.filter(
    (finding) => finding.verdict === "review" && finding.approvable,
  );
  if (resolvable.length === 0) return { originalVerdict, verdict: originalVerdict };
  const unresolved = input.findings.filter((finding) => !resolvable.includes(finding));
  return {
    approval: { approvedBy: match.approvedBy, expiresAt: match.expiresAt, reason: match.reason },
    originalVerdict,
    verdict: combineVerdicts(unresolved.map((finding) => finding.verdict)),
  };
}
