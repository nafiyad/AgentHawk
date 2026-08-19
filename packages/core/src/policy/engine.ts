import type { AgentHawkConfig, PolicyAction } from "../config.js";
import type { Evidence, Finding, Verdict } from "../domain.js";
import type { NpmPackageMetadata, NpmProviderResult } from "../npm/provider.js";
import type { ParsedNpmSpec } from "../npm/spec.js";

const verdictRank: Record<Verdict, number> = {
  allow: 0,
  warn: 1,
  review: 2,
  block: 3,
  error: 4,
};

export interface PolicyEvaluationInput {
  config: AgentHawkConfig;
  existingDependencies?: readonly string[];
  now: Date;
  providerResult?: NpmProviderResult;
  spec: ParsedNpmSpec;
}

export interface PolicyEvaluation {
  findings: Finding[];
  verdict: Verdict;
}

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyEvaluation {
  assertValidNow(input.now);

  if (input.spec.type !== "registry") {
    const finding = createFinding({
      action: input.config.rules.nonRegistrySpecifier.action,
      approvable: true,
      basis: "policy",
      message: `Dependency uses a non-registry ${input.spec.kind} specifier.`,
      remediation: "Use an npm registry package or explicitly review the source and transport.",
      ruleId: "PG015",
      severity: "high",
      title: "Non-registry dependency specifier",
    });
    return finalize(finding ? [finding] : []);
  }

  if (!input.config.registries.npm.enabled) {
    return finalize([providerUnavailable(input, "The npm evidence provider is disabled.")]);
  }

  if (!input.providerResult) {
    return finalize([providerUnavailable(input, "Required npm evidence was not provided.")]);
  }

  if (!input.providerResult.ok) {
    if (input.providerResult.status === "not_found") {
      return finalize([
        requiredFinding({
          action: "block",
          approvable: false,
          basis: "evidence",
          message: "The requested npm package or version could not be resolved.",
          remediation: "Correct the package name or select a published version.",
          ruleId: "PG001",
          severity: "high",
          title: "Package or version does not exist",
        }),
      ]);
    }
    return finalize([
      providerUnavailable(input, providerFailureMessage(input.providerResult.status)),
    ]);
  }

  const metadata = input.providerResult.data;
  const evidence = npmEvidence(metadata, input.now);
  const findings: Finding[] = [];

  const packageAge = ageInMilliseconds(metadata.packagePublishedAt, input.now);
  const releaseAge = ageInMilliseconds(metadata.releasePublishedAt, input.now);
  if (packageAge === undefined || releaseAge === undefined) {
    findings.push(
      providerUnavailable(input, "Required npm publication timestamps were unavailable."),
    );
  }

  if (packageAge !== undefined && packageAge < days(input.config.rules.packageAge.minDays)) {
    add(
      findings,
      createFinding({
        action: input.config.rules.packageAge.action,
        approvable: true,
        basis: "heuristic",
        evidence: [evidence],
        message: `Package is younger than the configured ${input.config.rules.packageAge.minDays}-day threshold.`,
        remediation: "Review package ownership, source, and release history before use.",
        ruleId: "PG002",
        severity: "medium",
        title: "Newly published package",
      }),
    );
  }

  if (releaseAge !== undefined && releaseAge < hours(input.config.rules.releaseAge.minHours)) {
    add(
      findings,
      createFinding({
        action: input.config.rules.releaseAge.action,
        approvable: true,
        basis: "heuristic",
        evidence: [evidence],
        message: `Selected release is younger than the configured ${input.config.rules.releaseAge.minHours}-hour threshold.`,
        remediation: "Allow time for ecosystem review or inspect the release before use.",
        ruleId: "PG003",
        severity: "medium",
        title: "Extremely fresh release",
      }),
    );
  }

  if (metadata.deprecated) {
    add(
      findings,
      createFinding({
        action: input.config.rules.deprecatedPackage.action,
        approvable: true,
        basis: "evidence",
        evidence: [evidence],
        message: "The selected package release is marked deprecated by the npm registry.",
        remediation: "Use the replacement recommended by the package maintainer when available.",
        ruleId: "PG004",
        severity: "medium",
        title: "Deprecated package",
      }),
    );
  }

  const similarDependency = findSimilarDependency(metadata.name, input.existingDependencies ?? []);
  if (similarDependency) {
    add(
      findings,
      createFinding({
        action: input.config.rules.similarToExistingDependency.action,
        approvable: true,
        basis: "heuristic",
        evidence: [npmEvidence(metadata, input.now, { similarTo: similarDependency })],
        message: `Package name resembles existing direct dependency ${similarDependency}.`,
        remediation: "Confirm the intended package name and publisher to rule out typosquatting.",
        ruleId: "PG005",
        severity: "high",
        title: "Package name resembles an existing dependency",
      }),
    );
  }

  if (!metadata.repositoryUrl) {
    add(
      findings,
      createFinding({
        action: input.config.rules.requireRepositoryUrl.action,
        approvable: true,
        basis: "evidence",
        evidence: [evidence],
        message: "Registry metadata does not include a repository URL.",
        remediation: "Locate and verify the package source before use.",
        ruleId: "PG006",
        severity: "low",
        title: "Missing repository URL",
      }),
    );
  }

  const configuredScripts = new Set<string>(input.config.rules.lifecycleScripts.scripts);
  const lifecycleScripts = metadata.lifecycleScripts.filter((script) =>
    configuredScripts.has(script),
  );
  if (lifecycleScripts.length > 0) {
    add(
      findings,
      createFinding({
        action: input.config.rules.lifecycleScripts.action,
        approvable: true,
        basis: "evidence",
        evidence: [npmEvidence(metadata, input.now, { lifecycleScripts })],
        message: `Package declares security-relevant lifecycle scripts: ${lifecycleScripts.join(", ")}.`,
        remediation: "Inspect the lifecycle scripts without executing them before installation.",
        ruleId: "PG007",
        severity: "high",
        title: "Lifecycle scripts present",
      }),
    );
  }

  return finalize(findings);
}

export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>(
    (highest, verdict) => (verdictRank[verdict] > verdictRank[highest] ? verdict : highest),
    "allow",
  );
}

function providerUnavailable(input: PolicyEvaluationInput, message: string): Finding {
  const strict =
    input.config.mode === "strict" || input.config.defaults.onProviderError === "error";
  return requiredFinding({
    action: strict ? "error" : "review",
    approvable: !strict,
    basis: "policy",
    message,
    remediation:
      "Restore the required provider and retry; do not treat missing evidence as approval.",
    ruleId: "PG013",
    severity: strict ? "high" : "medium",
    title: "Required provider unavailable",
  });
}

function finalize(findings: Finding[]): PolicyEvaluation {
  const ordered = [...findings].sort((left, right) =>
    left.ruleId === right.ruleId
      ? left.message.localeCompare(right.message)
      : left.ruleId.localeCompare(right.ruleId),
  );
  return { findings: ordered, verdict: combineVerdicts(ordered.map((finding) => finding.verdict)) };
}

interface FindingInput {
  action: PolicyAction | "error";
  approvable: boolean;
  basis: Finding["basis"];
  evidence?: Evidence[];
  message: string;
  remediation?: string;
  ruleId: Finding["ruleId"];
  severity: Finding["severity"];
  title: string;
}

function createFinding(input: FindingInput): Finding | undefined {
  return input.action === "allow" ? undefined : requiredFinding(input);
}

function requiredFinding(input: FindingInput): Finding {
  return {
    approvable: input.approvable,
    basis: input.basis,
    evidence: input.evidence ?? [],
    message: input.message,
    remediation: input.remediation,
    ruleId: input.ruleId,
    severity: input.severity,
    title: input.title,
    verdict: input.action,
  };
}

function add(findings: Finding[], finding: Finding | undefined): void {
  if (finding) findings.push(finding);
}

function npmEvidence(
  metadata: NpmPackageMetadata,
  now: Date,
  additional: Record<string, unknown> = {},
): Evidence {
  return {
    data: {
      deprecated: Boolean(metadata.deprecated),
      name: metadata.name,
      ...(metadata.packagePublishedAt ? { packagePublishedAt: metadata.packagePublishedAt } : {}),
      ...(metadata.releasePublishedAt ? { releasePublishedAt: metadata.releasePublishedAt } : {}),
      repositoryUrlPresent: Boolean(metadata.repositoryUrl),
      resolvedVersion: metadata.resolvedVersion,
      ...additional,
    },
    fetchedAt: now.toISOString(),
    provider: "npm",
  };
}

function providerFailureMessage(
  status: Exclude<NpmProviderResult, { ok: true }>["status"],
): string {
  const messages = {
    invalid_response: "The npm provider returned an invalid response.",
    network_error: "The npm provider could not be reached.",
    not_found: "The requested npm resource was not found.",
    provider_error: "The npm provider failed.",
    rate_limited: "The npm provider rate limit was reached.",
    timeout: "The npm provider request timed out.",
  } as const;
  return messages[status];
}

function ageInMilliseconds(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return undefined;
  return now.getTime() - timestamp;
}

function days(value: number): number {
  return value * 24 * 60 * 60 * 1_000;
}

function hours(value: number): number {
  return value * 60 * 60 * 1_000;
}

function findSimilarDependency(name: string, dependencies: readonly string[]): string | undefined {
  return [...dependencies].sort().find((dependency) => isConfusable(name, dependency));
}

function isConfusable(left: string, right: string): boolean {
  if (left === right) return false;
  const leftBase = packageBaseName(left);
  const rightBase = packageBaseName(right);
  if (leftBase === rightBase) return true;
  const normalizedLeft = leftBase.replace(/[._-]/gu, "");
  const normalizedRight = rightBase.replace(/[._-]/gu, "");
  if (normalizedLeft === normalizedRight) return true;
  return (
    normalizedLeft.length >= 5 &&
    normalizedRight.length >= 5 &&
    Math.abs(normalizedLeft.length - normalizedRight.length) <= 1 &&
    (editDistanceAtMostOne(normalizedLeft, normalizedRight) ||
      isSingleAdjacentTransposition(normalizedLeft, normalizedRight))
  );
}

function packageBaseName(name: string): string {
  return name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits += 1;
  return edits <= 1;
}

function isSingleAdjacentTransposition(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  const differences: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) differences.push(index);
    if (differences.length > 2) return false;
  }
  const first = differences[0];
  const second = differences[1];
  if (first === undefined || second === undefined || second !== first + 1) return false;
  return left[first] === right[second] && left[second] === right[first];
}

function assertValidNow(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new TypeError("Policy evaluation time must be valid.");
}
