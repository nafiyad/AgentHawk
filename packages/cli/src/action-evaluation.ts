import {
  type AgentAction,
  type AgentDecision,
  agentActionSchema,
  agentDecisionSchema,
  agentHawkConfigSchema,
  type CommandQualification,
  cancellationError,
  combineVerdicts,
  commandQualificationSchema,
  DeadlineExceededError,
  type EvaluationReport,
  isOperationCancelled,
  MetadataCache,
  OperationCancelledError,
  parseNpmSpec,
  type QualifiedPackage,
  qualifyCommand,
  throwIfCancelled,
  type Verdict,
} from "@agenthawk/core";
import { type CheckDependencies, evaluatePreparedNpmPackage, stableDigest } from "./check.js";
import {
  loadRepositoryAuthority,
  type RepositoryAuthority,
  RepositoryAuthorityError,
} from "./repository-authority.js";

const actionDeadlineMilliseconds = 8_000;
const actionConcurrency = 2;

export interface OwnedActionDeadline {
  readonly signal: AbortSignal;
  readonly startedAtNanoseconds: bigint;
  readonly deadlineAtNanoseconds: bigint;
  dispose(): void;
}

export interface MultiPackageEvaluation {
  readonly approvalApplied: boolean;
  readonly originalVerdict: Verdict;
  readonly reportDigest: string;
  readonly reports: readonly EvaluationReport[];
  readonly verdict: Verdict;
}

export interface ActionEvaluationDependencies extends CheckDependencies {
  evaluatePackage?: typeof evaluatePreparedNpmPackage;
  loadAuthority?: typeof loadRepositoryAuthority;
}

export function createActionDeadline(parentSignal?: AbortSignal): OwnedActionDeadline {
  const controller = new AbortController();
  const startedAtNanoseconds = process.hrtime.bigint();
  const deadlineAtNanoseconds =
    startedAtNanoseconds + BigInt(actionDeadlineMilliseconds) * 1_000_000n;
  const abortFromParent = () => {
    if (!controller.signal.aborted && parentSignal) {
      controller.abort(cancellationError(parentSignal));
    }
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new DeadlineExceededError());
  }, actionDeadlineMilliseconds);
  timer.unref();
  let disposed = false;
  return {
    deadlineAtNanoseconds,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
    signal: controller.signal,
    startedAtNanoseconds,
  };
}

export async function evaluateAgentAction(
  rawAction: AgentAction,
  deadline: OwnedActionDeadline,
  dependencies: ActionEvaluationDependencies = {},
): Promise<AgentDecision> {
  let action: AgentAction;
  try {
    action = agentActionSchema.parse(rawAction);
  } catch {
    throw new ActionEvaluationError("Agent action must be validated at the vendor boundary.");
  }
  if (deadline.signal.aborted) return cancellationDecision(action, deadline.signal);
  const qualification = commandQualificationSchema.parse(
    qualifyCommand(action.tool.command, action.tool.dialect),
  );
  if (qualification.category !== "dependency_add") {
    return fixedQualificationDecision(action, qualification);
  }

  let authority: RepositoryAuthority;
  try {
    authority = await (dependencies.loadAuthority ?? loadRepositoryAuthority)(
      action.workingDirectory,
      { signal: deadline.signal },
    );
  } catch (error) {
    if (deadline.signal.aborted) return cancellationDecision(action, deadline.signal);
    if (error instanceof RepositoryAuthorityError) {
      return fixedDecision(
        action,
        error.code === "configuration" ? "configuration_error" : "repository_identity_error",
      );
    }
    if (isOperationCancelled(error)) throw error;
    return fixedDecision(action, "internal_error");
  }

  try {
    const evaluation = await evaluateDependencyAdd(
      qualification.packages,
      authority,
      deadline.signal,
      dependencies,
    );
    return evaluatedDecision(action, evaluation);
  } catch (error) {
    if (deadline.signal.aborted) return cancellationDecision(action, deadline.signal);
    if (isOperationCancelled(error)) throw error;
    return fixedDecision(action, "internal_error");
  }
}

export async function evaluateDependencyAdd(
  rawPackages: readonly QualifiedPackage[],
  authority: RepositoryAuthority,
  parentSignal: AbortSignal,
  dependencies: ActionEvaluationDependencies = {},
): Promise<MultiPackageEvaluation> {
  throwIfCancelled({ signal: parentSignal });
  const qualification = commandQualificationSchema.parse({
    category: "dependency_add",
    manager: "npm",
    operation: "add",
    packages: rawPackages,
    reasonCode: "direct_dependency_add",
  });
  /* v8 ignore next -- strict schema construction fixes this discriminant */
  if (qualification.category !== "dependency_add") throw new ActionEvaluationError();
  const unique = uniquePackages(qualification.packages);
  const controller = new AbortController();
  let failure: { kind: "cancelled" | "deadline" | "internal"; error: unknown } | undefined;
  const abortFromParent = () => {
    if (failure) return;
    const error = cancellationError(parentSignal);
    failure = {
      error,
      kind: error instanceof DeadlineExceededError ? "deadline" : "cancelled",
    };
    controller.abort(error);
  };
  const reports = new Array<EvaluationReport>(unique.length);
  const cache =
    dependencies.cache ??
    new MetadataCache({ ...(dependencies.now ? { now: dependencies.now } : {}) });
  const now = (dependencies.now ?? (() => new Date()))();
  const config = agentHawkConfigSchema.parse(authority.config);
  let cursor = 0;
  const evaluatePackage = dependencies.evaluatePackage ?? evaluatePreparedNpmPackage;
  const worker = async () => {
    while (true) {
      throwIfCancelled({ signal: controller.signal });
      if (failure || cursor >= unique.length) return;
      const index = cursor;
      cursor += 1;
      const coordinate = unique[index];
      /* v8 ignore next -- the cursor bound and validated non-empty array make this defensive */
      if (!coordinate) throw new ActionEvaluationError();
      try {
        const spec = parseNpmSpec(`${coordinate.name}@${coordinate.requestedSpec}`);
        /* v8 ignore next -- qualified coordinates have already passed parseNpmSpec */
        if (spec.type !== "registry" || spec.name !== coordinate.name) {
          throw new ActionEvaluationError();
        }
        const proposedSiblings = unique
          .map(({ name }) => name)
          .filter((name) => name !== coordinate.name);
        const existingDependencies = [
          ...new Set([...authority.directDependencyNames, ...proposedSiblings]),
        ];
        reports[index] = await evaluatePackage(
          spec,
          {
            approvals: authority.approvals,
            cache,
            config,
            existingDependencies,
            ...(!dependencies.cache &&
              (dependencies.getPackage || dependencies.queryOsv) && { noCache: true }),
            now,
            signal: controller.signal,
          },
          dependencies,
        );
        throwIfCancelled({ signal: controller.signal });
      } catch (error) {
        if (!failure) {
          if (isOperationCancelled(error)) {
            failure = {
              error,
              kind: error instanceof DeadlineExceededError ? "deadline" : "cancelled",
            };
          } else {
            failure = { error, kind: "internal" };
          }
          controller.abort(isOperationCancelled(error) ? error : new OperationCancelledError());
        }
        throw error;
      }
    }
  };

  try {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal.aborted) abortFromParent();
    const workers = Array.from(
      { length: Math.min(actionConcurrency, unique.length) },
      async () => await worker(),
    );
    await Promise.allSettled(workers);
    /* v8 ignore next -- AbortSignal dispatch is synchronous; retained as a defensive recheck */
    if (parentSignal.aborted && !failure) abortFromParent();
    if (failure) {
      if (failure.kind === "internal") throw new ActionEvaluationError();
      throw failure.error;
    }
    /* v8 ignore next -- successful settled workers fill every claimed report slot */
    if (reports.some((report) => report === undefined)) throw new ActionEvaluationError();
    const expanded = qualification.packages.map((coordinate) => {
      const index = unique.findIndex(
        (item) => item.name === coordinate.name && item.requestedSpec === coordinate.requestedSpec,
      );
      const report = reports[index];
      /* v8 ignore next -- every expanded coordinate originated in the unique array */
      if (!report) throw new ActionEvaluationError();
      return report;
    });
    const verdict = combineVerdicts(expanded.map((report) => report.verdict));
    const originalVerdict = combineVerdicts(expanded.map((report) => report.originalVerdict));
    const anyApproval = expanded.some((report) => report.approval !== undefined);
    const approvalApplied =
      anyApproval &&
      originalVerdict !== "error" &&
      (originalVerdict === "review" || (originalVerdict === "block" && verdict === "block"));
    return {
      approvalApplied,
      originalVerdict,
      reportDigest: stableDigest({
        reports: expanded,
        schemaVersion: "1.0",
      }),
      reports: expanded,
      verdict,
    };
  } finally {
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function uniquePackages(packages: readonly QualifiedPackage[]): QualifiedPackage[] {
  const seen = new Set<string>();
  return packages.filter((coordinate) => {
    const key = `${coordinate.name}\0${coordinate.requestedSpec}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fixedQualificationDecision(
  action: AgentAction,
  qualification: Exclude<CommandQualification, { category: "dependency_add" }>,
): AgentDecision {
  switch (qualification.category) {
    case "unrelated":
      return fixedDecision(action, "unrelated");
    case "invalid":
      return fixedDecision(action, "invalid_action");
    case "install_like_unsupported":
      return fixedDecision(action, "unsupported_dependency_action");
    case "ephemeral_execution":
      return fixedDecision(action, "ephemeral_execution_denied");
  }
}

function fixedDecision(
  action: AgentAction,
  reasonCode:
    | "configuration_error"
    | "deadline_exceeded"
    | "ephemeral_execution_denied"
    | "internal_error"
    | "invalid_action"
    | "repository_identity_error"
    | "unrelated"
    | "unsupported_dependency_action",
): AgentDecision {
  const messages = {
    configuration_error: "Required security configuration is invalid.",
    deadline_exceeded: "The security evaluation deadline expired.",
    ephemeral_execution_denied: "Ephemeral package execution is not supported by this contract.",
    internal_error: "The security evaluation failed internally.",
    invalid_action: "The action input is invalid.",
    repository_identity_error: "A consistent repository identity could not be established.",
    unrelated: "The action is outside dependency admission scope.",
    unsupported_dependency_action: "The dependency-like action is not supported by this contract.",
  } as const;
  return agentDecisionSchema.parse({
    adapter: action.adapter,
    deploymentTrust: action.deploymentTrust,
    message: messages[reasonCode],
    outcome: reasonCode === "unrelated" ? "neutral" : "deny",
    reasonCode,
    schemaVersion: "1.0",
  });
}

function cancellationDecision(action: AgentAction, signal: AbortSignal): AgentDecision {
  const error = cancellationError(signal);
  if (error instanceof DeadlineExceededError) return fixedDecision(action, "deadline_exceeded");
  throw error;
}

function evaluatedDecision(action: AgentAction, evaluation: MultiPackageEvaluation): AgentDecision {
  const mapping = {
    allow: {
      message: "Dependency policy evaluation allowed the request.",
      outcome: "neutral",
      reasonCode: "dependency_allowed",
    },
    warn: {
      message: "A dependency warning requires review on this adapter.",
      outcome: "deny",
      reasonCode: "warning_requires_review",
    },
    review: {
      message: "Dependency policy evaluation requires review.",
      outcome: "deny",
      reasonCode: "dependency_review",
    },
    block: {
      message: "Dependency policy evaluation blocked the request.",
      outcome: "deny",
      reasonCode: "dependency_blocked",
    },
    error: {
      message: "Dependency policy evaluation could not complete safely.",
      outcome: "deny",
      reasonCode: "evaluation_error",
    },
  } as const;
  const selected = mapping[evaluation.verdict];
  return agentDecisionSchema.parse({
    adapter: action.adapter,
    approvalApplied: evaluation.approvalApplied,
    deploymentTrust: action.deploymentTrust,
    message: selected.message,
    originalVerdict: evaluation.originalVerdict,
    outcome: selected.outcome,
    reasonCode: selected.reasonCode,
    reportDigest: evaluation.reportDigest,
    schemaVersion: "1.0",
    verdict: evaluation.verdict,
  });
}

export class ActionEvaluationError extends Error {
  constructor(message = "Dependency action evaluation failed.") {
    super(message);
    this.name = "ActionEvaluationError";
  }
}
