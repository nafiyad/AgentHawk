import { valid } from "semver";
import { z } from "zod";
import type { AgentHawkConfig } from "../config.js";
import type { ApprovalMatch, Finding, PackageCoordinate, Verdict } from "../domain.js";
import { parseNpmSpec } from "../npm/spec.js";
import { combineVerdicts } from "../policy/engine.js";
import { parseStrictIsoTimestamp, validClockValue } from "../time.js";

const maximumApprovalRecords = 1_024;

function safeTextSchema(maximumLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximumLength)
    .refine((value) => !hasControlCharacter(value), "Control characters are not allowed.");
}

function hasControlCharacter(value: string): boolean {
  return /\p{C}/u.test(value);
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

const timestampSchema = z
  .string()
  .max(24)
  .refine((value) => parseStrictIsoTimestamp(value) !== undefined, {
    message: "Approval timestamp must be a strict ISO 8601 instant.",
  });

export const approvalRecordSchema = z
  .object({
    ecosystem: z.literal("npm"),
    name: z
      .string()
      .min(1)
      .max(214)
      .refine(isExactNpmName, "Name must be an exact normalized npm package name."),
    version: z
      .string()
      .max(256)
      .refine((value) => valid(value) === value, "Version must be exact SemVer."),
    approvedBy: safeTextSchema(256),
    approvedAt: timestampSchema,
    expiresAt: timestampSchema,
    reason: safeTextSchema(4_096),
    issue: z.string().max(2_048).url().refine(isHttpsUrl, "Issue URL must use HTTPS.").optional(),
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
  .object({
    version: z.literal(1),
    approvals: z.array(approvalRecordSchema).max(maximumApprovalRecords),
  })
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

export interface ApprovalTimeSummary {
  checkedAt: string;
  expiredCount: number;
  notYetEffectiveCount: number;
  timeEligibleCount: number;
}

export function summarizeApprovalTimes(file: ApprovalFile, now: Date): ApprovalTimeSummary {
  const checkedAt = validClockValue(now, "Approval verification clock");
  const checkedAtTimestamp = parseStrictIsoTimestamp(checkedAt);
  if (checkedAtTimestamp === undefined)
    throw new TypeError("Approval verification clock is invalid.");

  let expiredCount = 0;
  let notYetEffectiveCount = 0;
  let timeEligibleCount = 0;
  for (const record of file.approvals) {
    const approvedAt = parseStrictIsoTimestamp(record.approvedAt);
    const expiresAt = parseStrictIsoTimestamp(record.expiresAt);
    if (approvedAt === undefined || expiresAt === undefined) {
      throw new TypeError("Approval timestamps were not normalized.");
    }
    if (approvedAt > checkedAtTimestamp) notYetEffectiveCount += 1;
    else if (expiresAt <= checkedAtTimestamp) expiredCount += 1;
    else timeEligibleCount += 1;
  }

  return { checkedAt, expiredCount, notYetEffectiveCount, timeEligibleCount };
}

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
