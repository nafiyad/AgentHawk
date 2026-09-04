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

export const initIntegrationSchema = z.enum(["none", "codex", "claude", "cursor", "generic"]);
export type InitIntegration = z.infer<typeof initIntegrationSchema>;
export const initTargetSchema = z.enum(["policy", "codex", "claude", "cursor", "generic"]);
export type InitTarget = z.infer<typeof initTargetSchema>;

export const initReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("init"),
    initialized: z.literal(true),
    integration: initIntegrationSchema,
    policyVersion: z.literal(1),
    templateVersion: z.literal(1),
    created: z.array(initTargetSchema).max(2),
    unchanged: z.array(initTargetSchema).max(2),
    providersContacted: z.literal(false),
  })
  .strict()
  .superRefine((report, context) => {
    const expected: InitTarget[] =
      report.integration === "none" ? ["policy"] : ["policy", report.integration];
    const combined = [...report.created, ...report.unchanged];
    if (new Set(combined).size !== combined.length) {
      context.addIssue({ code: "custom", message: "Initialization targets must be unique." });
    }
    if (
      combined.length !== expected.length ||
      expected.some((target) => !combined.includes(target)) ||
      report.created.some(
        (target, index, targets) =>
          expected.indexOf(target) < expected.indexOf(targets[index - 1] ?? target),
      ) ||
      report.unchanged.some(
        (target, index, targets) =>
          expected.indexOf(target) < expected.indexOf(targets[index - 1] ?? target),
      )
    ) {
      context.addIssue({ code: "custom", message: "Initialization targets are inconsistent." });
    }
  });
export type InitReport = z.infer<typeof initReportSchema>;

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

export const codexProjectHookOwnershipSchema = z.enum([
  "absent",
  "owned_inactive",
  "owned_exact",
  "unowned_hook",
  "record_collision",
  "owned_modified",
  "unsafe",
]);
export type CodexProjectHookOwnership = z.infer<typeof codexProjectHookOwnershipSchema>;

export const codexProjectHookReadinessSchema = z.enum([
  "not_applicable",
  "current",
  "artifact_unavailable",
  "artifact_drift",
]);
export type CodexProjectHookReadiness = z.infer<typeof codexProjectHookReadinessSchema>;

export const codexProjectHookBlockerSchema = z.enum([
  "config_collision",
  "operation_locked",
  "linked_worktree",
]);
export type CodexProjectHookBlocker = z.infer<typeof codexProjectHookBlockerSchema>;

export const codexProjectHookStatusReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("integrations_codex_status"),
    ownership: codexProjectHookOwnershipSchema,
    readiness: codexProjectHookReadinessSchema,
    blockers: z.array(codexProjectHookBlockerSchema).max(3),
    providersContacted: z.literal(false),
  })
  .strict()
  .superRefine((report, context) => {
    const blockerOrder = ["config_collision", "operation_locked", "linked_worktree"] as const;
    if (
      new Set(report.blockers).size !== report.blockers.length ||
      report.blockers.some(
        (blocker, index) =>
          blockerOrder.indexOf(blocker) <
          blockerOrder.indexOf(report.blockers[index - 1] ?? blocker),
      )
    ) {
      context.addIssue({ code: "custom", message: "Codex status blockers are inconsistent." });
    }
    const hasValidReceipt = ["owned_inactive", "owned_exact", "owned_modified"].includes(
      report.ownership,
    );
    if ((report.readiness === "not_applicable") === hasValidReceipt) {
      context.addIssue({ code: "custom", message: "Codex status readiness is inconsistent." });
    }
  });
export type CodexProjectHookStatusReport = z.infer<typeof codexProjectHookStatusReportSchema>;

export const claudeSettingsStateSchema = z.enum(["absent", "present", "unsafe"]);
export type ClaudeSettingsState = z.infer<typeof claudeSettingsStateSchema>;

export const claudeSharedPreToolUseSchema = z.enum(["absent", "present", "unknown"]);
export type ClaudeSharedPreToolUse = z.infer<typeof claudeSharedPreToolUseSchema>;

export const claudeSharedDisableAllHooksSchema = z.union([z.boolean(), z.literal("unknown")]);
export type ClaudeSharedDisableAllHooks = z.infer<typeof claudeSharedDisableAllHooksSchema>;

export const claudeLocalSettingsIgnoredSchema = z.enum(["ignored", "not_ignored", "unknown"]);
export type ClaudeLocalSettingsIgnored = z.infer<typeof claudeLocalSettingsIgnoredSchema>;

export const claudeProjectHookOwnershipSchema = z.enum([
  "absent",
  "owned_inactive",
  "owned_exact",
  "unowned_settings",
  "record_collision",
  "owned_modified",
  "unsafe",
]);
export type ClaudeProjectHookOwnership = z.infer<typeof claudeProjectHookOwnershipSchema>;

export const claudeProjectHookReadinessSchema = z.enum([
  "not_applicable",
  "current",
  "artifact_unavailable",
  "artifact_drift",
]);
export type ClaudeProjectHookReadiness = z.infer<typeof claudeProjectHookReadinessSchema>;

export const claudeProjectHookBlockerSchema = z.enum([
  "local_settings_unsafe",
  "shared_settings_unsafe",
  "local_settings_present",
  "local_settings_not_ignored",
  "ignore_status_unavailable",
  "integration_artifacts_not_ignored",
  "integration_ignore_status_unavailable",
  "project_hooks_present",
  "project_hooks_declared_disabled",
  "operation_locked",
  "linked_worktree",
]);
export type ClaudeProjectHookBlocker = z.infer<typeof claudeProjectHookBlockerSchema>;

export const claudeProjectHookStatusReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.literal("integrations_claude_status"),
    localSettings: claudeSettingsStateSchema,
    sharedSettings: claudeSettingsStateSchema,
    sharedPreToolUse: claudeSharedPreToolUseSchema,
    sharedDisableAllHooks: claudeSharedDisableAllHooksSchema,
    localSettingsIgnored: claudeLocalSettingsIgnoredSchema,
    integrationArtifactsIgnored: claudeLocalSettingsIgnoredSchema,
    ownership: claudeProjectHookOwnershipSchema,
    readiness: claudeProjectHookReadinessSchema,
    blockers: z.array(claudeProjectHookBlockerSchema).max(11),
    activation: z.literal("unproven"),
    providersContacted: z.literal(false),
    exitCodeMeaning: z.enum([
      "future_installation_precondition_met",
      "integration_current",
      "attention_required",
    ]),
  })
  .strict()
  .superRefine((report, context) => {
    const blockerOrder = claudeProjectHookBlockerSchema.options;
    if (
      new Set(report.blockers).size !== report.blockers.length ||
      report.blockers.some(
        (blocker, index) =>
          blockerOrder.indexOf(blocker) <
          blockerOrder.indexOf(report.blockers[index - 1] ?? blocker),
      )
    ) {
      context.addIssue({ code: "custom", message: "Claude status blockers are inconsistent." });
    }

    const expectedBlockers: ClaudeProjectHookBlocker[] = [];
    if (report.localSettings === "unsafe") expectedBlockers.push("local_settings_unsafe");
    if (report.sharedSettings === "unsafe") expectedBlockers.push("shared_settings_unsafe");
    if (report.ownership === "unowned_settings") expectedBlockers.push("local_settings_present");
    if (report.localSettingsIgnored === "not_ignored")
      expectedBlockers.push("local_settings_not_ignored");
    if (report.localSettingsIgnored === "unknown")
      expectedBlockers.push("ignore_status_unavailable");
    if (report.integrationArtifactsIgnored === "not_ignored")
      expectedBlockers.push("integration_artifacts_not_ignored");
    if (report.integrationArtifactsIgnored === "unknown")
      expectedBlockers.push("integration_ignore_status_unavailable");
    if (report.sharedPreToolUse === "present") expectedBlockers.push("project_hooks_present");
    if (report.sharedDisableAllHooks === true)
      expectedBlockers.push("project_hooks_declared_disabled");
    if (report.blockers.includes("operation_locked")) expectedBlockers.push("operation_locked");
    if (report.blockers.includes("linked_worktree")) expectedBlockers.push("linked_worktree");
    if (JSON.stringify(report.blockers) !== JSON.stringify(expectedBlockers)) {
      context.addIssue({ code: "custom", message: "Claude status blockers do not match state." });
    }

    if (
      report.sharedSettings === "unsafe" &&
      (report.sharedPreToolUse !== "unknown" || report.sharedDisableAllHooks !== "unknown")
    ) {
      context.addIssue({ code: "custom", message: "Unsafe Claude shared state must be unknown." });
    }
    if (
      report.sharedSettings === "absent" &&
      (report.sharedPreToolUse !== "absent" || report.sharedDisableAllHooks !== false)
    ) {
      context.addIssue({ code: "custom", message: "Absent Claude shared state is inconsistent." });
    }
    if (
      report.sharedSettings === "present" &&
      (report.sharedPreToolUse === "unknown" || report.sharedDisableAllHooks === "unknown")
    ) {
      context.addIssue({
        code: "custom",
        message: "Present Claude shared state must have known observations.",
      });
    }

    const installable =
      report.ownership === "absent" &&
      report.sharedSettings !== "unsafe" &&
      report.sharedPreToolUse === "absent" &&
      report.sharedDisableAllHooks === false &&
      report.localSettingsIgnored === "ignored" &&
      report.blockers.length === 0;
    const current =
      report.ownership === "owned_exact" &&
      report.readiness === "current" &&
      report.blockers.length === 0;
    const expectedExitMeaning = installable
      ? "future_installation_precondition_met"
      : current
        ? "integration_current"
        : "attention_required";
    if (report.exitCodeMeaning !== expectedExitMeaning) {
      context.addIssue({ code: "custom", message: "Claude status exit meaning is inconsistent." });
    }

    const validReceipt = ["owned_inactive", "owned_exact", "owned_modified"].includes(
      report.ownership,
    );
    const readinessSuppressed =
      report.sharedSettings === "unsafe" ||
      report.sharedPreToolUse === "present" ||
      report.sharedDisableAllHooks === true ||
      report.blockers.includes("linked_worktree");
    if ((report.readiness !== "not_applicable") !== (validReceipt && !readinessSuppressed)) {
      context.addIssue({ code: "custom", message: "Claude status readiness is inconsistent." });
    }
    if (
      (report.ownership === "absent" || report.ownership === "owned_inactive") &&
      report.localSettings !== "absent"
    ) {
      context.addIssue({ code: "custom", message: "Claude local settings state is inconsistent." });
    }
    if (
      ["unowned_settings", "owned_exact", "owned_modified"].includes(report.ownership) &&
      report.localSettings !== "present"
    ) {
      context.addIssue({ code: "custom", message: "Claude ownership state is inconsistent." });
    }
  });
export type ClaudeProjectHookStatusReport = z.infer<typeof claudeProjectHookStatusReportSchema>;

export const codexProjectHookLifecycleReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.enum(["integrations_codex_install", "integrations_codex_remove"]),
    outcome: z.enum(["installed", "removed", "recovery_required"]),
    ownership: codexProjectHookOwnershipSchema,
    readiness: codexProjectHookReadinessSchema,
    blockers: z.array(codexProjectHookBlockerSchema).max(3),
    providersContacted: z.literal(false),
  })
  .strict()
  .superRefine((report, context) => {
    const blockerOrder = ["config_collision", "operation_locked", "linked_worktree"] as const;
    if (
      new Set(report.blockers).size !== report.blockers.length ||
      report.blockers.some(
        (blocker, index) =>
          blockerOrder.indexOf(blocker) <
          blockerOrder.indexOf(report.blockers[index - 1] ?? blocker),
      )
    ) {
      context.addIssue({ code: "custom", message: "Codex lifecycle blockers are inconsistent." });
    }
    if (
      report.outcome === "installed" &&
      (report.command !== "integrations_codex_install" ||
        report.ownership !== "owned_exact" ||
        report.readiness !== "current" ||
        report.blockers.length !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Installed Codex lifecycle state is invalid." });
    }
    if (
      report.outcome === "removed" &&
      (report.command !== "integrations_codex_remove" ||
        report.ownership !== "absent" ||
        report.readiness !== "not_applicable" ||
        report.blockers.includes("operation_locked"))
    ) {
      context.addIssue({ code: "custom", message: "Removed Codex lifecycle state is invalid." });
    }
  });
export type CodexProjectHookLifecycleReport = z.infer<typeof codexProjectHookLifecycleReportSchema>;

export const claudeProjectHookLifecycleReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    toolVersion: z.string().min(1).max(128),
    command: z.enum(["integrations_claude_install", "integrations_claude_remove"]),
    outcome: z.enum(["installed", "removed", "recovery_required"]),
    ownership: claudeProjectHookOwnershipSchema,
    readiness: claudeProjectHookReadinessSchema,
    blockers: z.array(claudeProjectHookBlockerSchema).max(11),
    providersContacted: z.literal(false),
    activation: z.literal("unproven"),
  })
  .strict()
  .superRefine((report, context) => {
    const blockerOrder = claudeProjectHookBlockerSchema.options;
    if (
      new Set(report.blockers).size !== report.blockers.length ||
      report.blockers.some(
        (blocker, index) =>
          blockerOrder.indexOf(blocker) <
          blockerOrder.indexOf(report.blockers[index - 1] ?? blocker),
      )
    ) {
      context.addIssue({ code: "custom", message: "Claude lifecycle blockers are inconsistent." });
    }
    if (
      report.outcome === "installed" &&
      (report.command !== "integrations_claude_install" ||
        report.ownership !== "owned_exact" ||
        report.readiness !== "current" ||
        report.blockers.length !== 0)
    ) {
      context.addIssue({ code: "custom", message: "Installed Claude lifecycle state is invalid." });
    }
    if (
      report.outcome === "removed" &&
      (report.command !== "integrations_claude_remove" ||
        report.ownership !== "absent" ||
        report.readiness !== "not_applicable" ||
        report.blockers.includes("operation_locked"))
    ) {
      context.addIssue({ code: "custom", message: "Removed Claude lifecycle state is invalid." });
    }
  });
export type ClaudeProjectHookLifecycleReport = z.infer<
  typeof claudeProjectHookLifecycleReportSchema
>;

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
