import { z } from "zod";

export const verdictSchema = z.enum(["allow", "warn", "review", "block", "error"]);
export type Verdict = z.infer<typeof verdictSchema>;

export const severitySchema = z.enum(["info", "low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingBasisSchema = z.enum(["evidence", "policy", "heuristic"]);
export type FindingBasis = z.infer<typeof findingBasisSchema>;

export const packageCoordinateSchema = z
  .object({
    ecosystem: z.literal("npm"),
    name: z.string().min(1),
    requestedSpec: z.string().min(1),
    resolvedVersion: z.string().min(1).optional(),
  })
  .strict();
export type PackageCoordinate = z.infer<typeof packageCoordinateSchema>;

export const evidenceSchema = z
  .object({
    provider: z.string().min(1),
    fetchedAt: z.iso.datetime(),
    sourceUrl: z.url().optional(),
    stale: z.boolean().optional(),
    digest: z.string().optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Evidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z
  .object({
    ruleId: z.string().regex(/^PG\d{3}$/u),
    verdict: z.enum(["allow", "warn", "review", "block"]),
    severity: severitySchema,
    basis: findingBasisSchema,
    title: z.string().min(1),
    message: z.string().min(1),
    evidence: z.array(evidenceSchema),
    remediation: z.string().min(1).optional(),
    approvable: z.boolean(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const providerStatusSchema = z
  .object({
    provider: z.string().min(1),
    status: z.enum(["ok", "error", "timeout", "rate_limited", "offline", "stale"]),
    fetchedAt: z.iso.datetime().optional(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const approvalMatchSchema = z
  .object({
    approvedBy: z.string().min(1),
    expiresAt: z.iso.datetime(),
    reason: z.string().min(1),
  })
  .strict();
export type ApprovalMatch = z.infer<typeof approvalMatchSchema>;

export const evaluationReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1),
    generatedAt: z.iso.datetime(),
    target: packageCoordinateSchema,
    verdict: verdictSchema,
    originalVerdict: verdictSchema,
    findings: z.array(findingSchema),
    providerStatus: z.array(providerStatusSchema),
    policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    approval: approvalMatchSchema.optional(),
    exitCodeMeaning: z.string().min(1),
  })
  .strict();
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
