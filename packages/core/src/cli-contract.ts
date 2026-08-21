import { z } from "zod";
import { evaluationReportSchema, findingSchema, verdictSchema } from "./domain.js";
import { dependencyChangeSchema, dependencySectionSchema } from "./scan/dependencies.js";
import { parseStrictIsoTimestamp } from "./time.js";

export const cliErrorCodeSchema = z.enum(["invalid_input", "output_limit", "internal_error"]);

const inputErrorSchema = z
  .object({
    code: z.enum(["invalid_input", "output_limit"]),
    message: z.string().min(1).max(4_096),
  })
  .strict();
const internalErrorSchema = z
  .object({ code: z.literal("internal_error"), message: z.string().min(1).max(4_096) })
  .strict();
export const cliErrorReportSchema = z.discriminatedUnion("exitCode", [
  z
    .object({ schemaVersion: z.literal("1.0"), error: inputErrorSchema, exitCode: z.literal(2) })
    .strict(),
  z
    .object({ schemaVersion: z.literal("1.0"), error: internalErrorSchema, exitCode: z.literal(4) })
    .strict(),
]);
export type CliErrorReport = z.infer<typeof cliErrorReportSchema>;

export const policyValidationReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("policy_validate"),
    valid: z.literal(true),
    policyVersion: z.literal(1),
    mode: z.enum(["review", "strict"]),
    policyDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
export type PolicyValidationReport = z.infer<typeof policyValidationReportSchema>;

const approvalCountSchema = z.number().int().min(0).max(1_024);
export const approvalValidationReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("approvals_verify"),
    valid: z.literal(true),
    approvalVersion: z.literal(1),
    approvalCount: approvalCountSchema,
    timeEligibleCount: approvalCountSchema,
    expiredCount: approvalCountSchema,
    notYetEffectiveCount: approvalCountSchema,
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    approvalDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.timeEligibleCount + report.expiredCount + report.notYetEffectiveCount !==
      report.approvalCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Approval state counts must match total count.",
      });
    }
  });
export type ApprovalValidationReport = z.infer<typeof approvalValidationReportSchema>;

const diagnosticStateSchema = z.enum(["absent", "valid", "invalid"]);
const integrationStateSchema = z.enum(["absent", "present_unverified", "invalid"]);
const canonicalNodeVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseDoctorNodeMajor(version: string): number | undefined {
  const match = canonicalNodeVersionPattern.exec(version);
  if (!match) return undefined;
  const components = match.slice(1).map(Number);
  if (!components.every(Number.isSafeInteger)) return undefined;
  return components[0];
}

export const doctorReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("doctor"),
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    supportDataAsOf: z.literal("2026-08-21"),
    ready: z.boolean(),
    runtime: z
      .object({
        nodeVersion: z.union([
          z
            .string()
            .regex(canonicalNodeVersionPattern)
            .max(64)
            .refine((version) => parseDoctorNodeMajor(version) !== undefined),
          z.literal("invalid"),
        ]),
        nodeRange: z.literal("^22.0.0 || ^24.0.0"),
        declaredCompatible: z.boolean(),
        upstreamSupported: z.boolean(),
        ciTestedPlatform: z.boolean(),
        platform: z.enum(["win32", "darwin", "linux", "other"]),
        architecture: z.enum(["x64", "arm64", "other"]),
      })
      .strict(),
    packages: z
      .object({
        cliVersion: z.string().min(1).max(128),
        coreVersion: z.string().min(1).max(128),
        aligned: z.boolean(),
      })
      .strict(),
    cache: z.object({ state: z.enum(["writable", "unwritable", "unsafe"]) }).strict(),
    configuration: z
      .object({ policy: diagnosticStateSchema, approvals: diagnosticStateSchema })
      .strict(),
    git: z.object({ state: z.enum(["available", "unavailable"]) }).strict(),
    integrations: z
      .object({
        codex: integrationStateSchema,
        claudeCode: integrationStateSchema,
        cursor: integrationStateSchema,
        githubActions: integrationStateSchema,
      })
      .strict(),
    providersContacted: z.literal(false),
  })
  .strict()
  .superRefine((report, context) => {
    if (parseStrictIsoTimestamp(report.checkedAt) === undefined) {
      context.addIssue({
        code: "custom",
        message: "Doctor checkedAt must be a valid UTC timestamp.",
      });
    }
    const nodeMajor = parseDoctorNodeMajor(report.runtime.nodeVersion);
    const expectedRuntimeSupport = nodeMajor === 22 || nodeMajor === 24;
    if (
      report.runtime.declaredCompatible !== expectedRuntimeSupport ||
      report.runtime.upstreamSupported !== expectedRuntimeSupport
    ) {
      context.addIssue({ code: "custom", message: "Doctor runtime states are inconsistent." });
    }
    if (report.runtime.ciTestedPlatform !== (report.runtime.platform !== "other")) {
      context.addIssue({ code: "custom", message: "Doctor platform state is inconsistent." });
    }
    if (report.packages.aligned !== (report.packages.cliVersion === report.packages.coreVersion)) {
      context.addIssue({ code: "custom", message: "Doctor package state is inconsistent." });
    }
    const expectedReady =
      report.runtime.declaredCompatible &&
      report.runtime.upstreamSupported &&
      report.runtime.ciTestedPlatform &&
      report.packages.aligned &&
      report.cache.state === "writable" &&
      report.configuration.policy !== "invalid" &&
      report.configuration.approvals !== "invalid" &&
      report.git.state === "available" &&
      Object.values(report.integrations).every((state) => state !== "invalid");
    if (report.ready !== expectedReady) {
      context.addIssue({ code: "custom", message: "Doctor readiness must match check states." });
    }
  });
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export const directDependencySchema = z
  .object({
    name: z.string().min(1).max(214),
    requestedSpec: z.string().min(1).max(2_048),
    section: dependencySectionSchema,
  })
  .strict();

export const inventoryReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    manifest: z.literal("package.json"),
    dependencies: z.array(directDependencySchema).max(64),
  })
  .strict();
export type InventoryReport = z.infer<typeof inventoryReportSchema>;

export const scanReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    manifest: z.literal("package.json"),
    verdict: verdictSchema,
    results: z
      .array(
        z
          .object({
            report: evaluationReportSchema,
            section: dependencySectionSchema,
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export type ScanReport = z.infer<typeof scanReportSchema>;

export const diffReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    base: z.string().min(1).max(512),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    manifest: z.literal("package.json"),
    changes: z.array(dependencyChangeSchema).max(64),
    lockfiles: z
      .object({
        present: z
          .array(
            z.enum([
              "package-lock.json",
              "npm-shrinkwrap.json",
              "pnpm-lock.yaml",
              "yarn.lock",
              "bun.lock",
              "bun.lockb",
            ]),
          )
          .max(6),
        updated: z
          .array(
            z.enum([
              "package-lock.json",
              "npm-shrinkwrap.json",
              "pnpm-lock.yaml",
              "yarn.lock",
              "bun.lock",
              "bun.lockb",
            ]),
          )
          .max(6),
      })
      .strict(),
    findings: z.array(findingSchema).max(64),
    verdict: z.enum(["allow", "review"]),
  })
  .strict();
export type DiffReport = z.infer<typeof diffReportSchema>;
