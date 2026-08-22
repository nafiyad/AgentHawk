import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import {
  AGENTHAWK_VERSION,
  type ApprovalFile,
  agentHawkConfigSchema,
  applyApprovals,
  approvalFileSchema,
  cancellationError,
  cliErrorReportSchema,
  type EvaluationReport,
  evaluatePolicy,
  evaluationReportSchema,
  isOperationCancelled,
  MetadataCache,
  type NpmProviderResult,
  NpmRegistryProvider,
  npmResultForCache,
  type OperationContext,
  OsvProvider,
  type OsvProviderResult,
  type ProviderStatus,
  parseCachedNpmResult,
  parseCachedOsvResult,
  parseNpmSpec,
  throwIfCancelled,
  type Verdict,
} from "@agenthawk/core";
import { parseDocument } from "yaml";
import { escapeTerminal } from "./terminal.js";

const maximumPolicyBytes = 256 * 1_024;
const npmCacheTtl = 60 * 60 * 1_000;
const osvCacheTtl = 15 * 60 * 1_000;

export type OutputFormat = "json" | "terminal";

export interface CheckOptions {
  approvalsPath?: string;
  cwd?: string;
  existingDependencies?: readonly string[];
  format: OutputFormat;
  noCache?: boolean;
  offline?: boolean;
  policyPath?: string;
  registryUrl?: string;
  strict: boolean;
  signal?: AbortSignal;
}

export interface CheckResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  output: string;
}

export interface CheckDependencies {
  cache?: MetadataCache;
  getPackage?: (
    name: string,
    requestedSpec: string,
    options?: OperationContext,
  ) => Promise<NpmProviderResult>;
  now?: () => Date;
  queryOsv?: (
    name: string,
    version: string,
    options?: OperationContext,
  ) => Promise<OsvProviderResult>;
  readPolicy?: (path: string, options?: OperationContext) => Promise<unknown | undefined>;
  readApprovals?: (
    path: string,
    required: boolean,
    options?: OperationContext,
  ) => Promise<unknown | undefined>;
}

export async function checkNpmPackage(
  rawSpec: string,
  options: CheckOptions,
  dependencies: CheckDependencies = {},
): Promise<CheckResult> {
  try {
    throwIfCancelled({ signal: options.signal });
    if (options.offline && options.noCache) {
      throw new PolicyInputError("--offline and --no-cache cannot be used together.");
    }
    const spec = parseNpmSpec(rawSpec);
    const now = (dependencies.now ?? (() => new Date()))();
    const policyDocument = options.policyPath
      ? await (dependencies.readPolicy ?? readPolicyFile)(options.policyPath, {
          signal: options.signal,
        })
      : await (dependencies.readPolicy ?? readOptionalPolicyFile)(
          join(
            dependencies.readPolicy
              ? (options.cwd ?? process.cwd())
              : await canonicalPolicyRoot(options.cwd ?? process.cwd(), options.signal),
            ".agenthawk.yml",
          ),
          { signal: options.signal },
        );
    throwIfCancelled({ signal: options.signal });
    const baseConfig = agentHawkConfigSchema.parse(policyDocument ?? { version: 1 });
    const config = options.strict
      ? agentHawkConfigSchema.parse({ ...baseConfig, mode: "strict" })
      : baseConfig;
    const approvalPath = options.approvalsPath ?? ".agenthawk/approvals.yml";
    const approvalDocument = await (dependencies.readApprovals ?? readApprovalFile)(
      approvalPath,
      options.approvalsPath !== undefined,
      { signal: options.signal },
    );
    throwIfCancelled({ signal: options.signal });
    const approvals: ApprovalFile = approvalDocument
      ? approvalFileSchema.parse(approvalDocument)
      : approvalFileSchema.parse({ version: 1, approvals: [] });

    const cache =
      dependencies.cache ??
      new MetadataCache({ ...(dependencies.now ? { now: dependencies.now } : {}) });
    const providerOptions: CheckOptions =
      !dependencies.cache && (dependencies.getPackage || dependencies.queryOsv)
        ? { ...options, noCache: true }
        : options;
    const npmResolution =
      spec.type === "registry"
        ? await resolveNpmResult(
            spec.name,
            spec.requestedSpec,
            providerOptions,
            dependencies,
            cache,
            now,
          )
        : {};
    const providerResult = npmResolution.result;
    const osvResolution = await resolveOsvResult(
      config.registries.osv.enabled,
      providerResult,
      providerOptions,
      dependencies,
      cache,
      now,
    );
    const osvResult = osvResolution.result;
    throwIfCancelled({ signal: options.signal });
    const evaluation = requireLiveVerification(
      evaluatePolicy({
        config,
        ...(options.existingDependencies
          ? { existingDependencies: options.existingDependencies }
          : {}),
        now,
        ...(isOsvProviderResult(osvResult) ? { osvResult } : {}),
        ...(providerResult ? { providerResult } : {}),
        spec,
      }),
      config,
      npmResolution.cached === true || osvResolution.cached === true,
    );
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
      toolVersion: AGENTHAWK_VERSION,
      generatedAt: now.toISOString(),
      target,
      verdict: approvalApplication.verdict,
      originalVerdict: approvalApplication.originalVerdict,
      findings: evaluation.findings,
      providerStatus: providerStatuses(
        providerResult,
        osvResult,
        npmResolution.stale,
        osvResolution.stale,
        npmResolution.cached,
        osvResolution.cached,
      ),
      policyDigest: stableDigest(config),
      evidenceDigest: stableDigest(
        normalizedEvidenceForDigest(providerResult, osvResult, spec.type),
      ),
      ...(approvalApplication.approval ? { approval: approvalApplication.approval } : {}),
      exitCodeMeaning: exitMeaning(exitCode),
    });
    return {
      exitCode,
      output: options.format === "json" ? renderJson(report) : renderTerminal(report),
    };
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (isOperationCancelled(error)) throw error;
    const invalid = isExpectedInputError(error);
    const exitCode = invalid ? 2 : 4;
    const message = invalid ? safeMessage(error) : "Unexpected internal error.";
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

function defaultGetPackage(registryUrl?: string) {
  let provider: NpmRegistryProvider;
  try {
    provider = new NpmRegistryProvider({ ...(registryUrl ? { registryUrl } : {}) });
  } catch {
    throw new PolicyInputError("Registry URL is invalid or unsafe.");
  }
  return async (name: string, requestedSpec: string, options?: OperationContext) =>
    provider.getPackage({ ecosystem: "npm", name, requestedSpec }, options);
}

function defaultQueryOsv() {
  const provider = new OsvProvider();
  return async (name: string, version: string, options?: OperationContext) =>
    provider.query({ name, version }, options);
}

type ResolvedOsvResult = OsvProviderResult | { status: "disabled" } | undefined;

interface CacheResolution<T> {
  cached?: boolean;
  result?: T;
  stale?: string;
}

async function resolveNpmResult(
  name: string,
  requestedSpec: string,
  options: CheckOptions,
  dependencies: CheckDependencies,
  cache: MetadataCache,
  now: Date,
): Promise<CacheResolution<NpmProviderResult>> {
  const live = dependencies.getPackage ?? defaultGetPackage(options.registryUrl);
  if (options.noCache) {
    const result = await live(name, requestedSpec, { signal: options.signal });
    throwIfCancelled({ signal: options.signal });
    return { result };
  }
  const key = JSON.stringify({ name, registry: options.registryUrl ?? "public", requestedSpec });
  if (options.offline) {
    const cached = await cache.read("npm", key, parseCachedNpmResult, { signal: options.signal });
    if (cached.status === "fresh") return { cached: true, result: cached.value };
    return {
      result: offlineFailure(
        now,
        cached.status === "stale" ? "Stale npm cache evidence." : "npm cache evidence unavailable.",
      ),
      ...(cached.status === "stale" ? { stale: cached.storedAt } : {}),
    };
  }
  const result = await live(name, requestedSpec, { signal: options.signal });
  throwIfCancelled({ signal: options.signal });
  if (result.ok)
    await cache.write("npm", key, npmResultForCache(result), npmCacheTtl, {
      signal: options.signal,
    });
  return { result };
}

async function resolveOsvResult(
  enabled: boolean,
  providerResult: NpmProviderResult | undefined,
  options: CheckOptions,
  dependencies: CheckDependencies,
  cache: MetadataCache,
  now: Date,
): Promise<CacheResolution<ResolvedOsvResult>> {
  if (!enabled) return { result: { status: "disabled" } };
  if (!providerResult?.ok) return {};
  const live = dependencies.queryOsv ?? defaultQueryOsv();
  if (options.noCache) {
    const result = await live(providerResult.data.name, providerResult.data.resolvedVersion, {
      signal: options.signal,
    });
    throwIfCancelled({ signal: options.signal });
    return { result };
  }
  const key = JSON.stringify({
    name: providerResult.data.name,
    version: providerResult.data.resolvedVersion,
  });
  if (options.offline) {
    const cached = await cache.read("osv", key, parseCachedOsvResult, { signal: options.signal });
    if (cached.status === "fresh") return { cached: true, result: cached.value };
    return {
      result: offlineFailure(
        now,
        cached.status === "stale" ? "Stale OSV cache evidence." : "OSV cache evidence unavailable.",
      ),
      ...(cached.status === "stale" ? { stale: cached.storedAt } : {}),
    };
  }
  const result = await live(providerResult.data.name, providerResult.data.resolvedVersion, {
    signal: options.signal,
  });
  throwIfCancelled({ signal: options.signal });
  if (result.ok) await cache.write("osv", key, result, osvCacheTtl, { signal: options.signal });
  return { result };
}

function requireLiveVerification(
  evaluation: ReturnType<typeof evaluatePolicy>,
  config: ReturnType<typeof agentHawkConfigSchema.parse>,
  usedCache: boolean,
): ReturnType<typeof evaluatePolicy> {
  if (!usedCache || evaluation.findings.some((finding) => finding.ruleId === "PG013")) {
    return evaluation;
  }
  const message = "Cached provider evidence is not authenticated and requires live verification.";
  const strict = config.mode === "strict" || config.defaults.onProviderError === "error";
  const finding = {
    approvable: false,
    basis: "policy" as const,
    evidence: [],
    message,
    remediation: "Reconnect and rerun AgentHawk before admitting the dependency.",
    ruleId: "PG013",
    severity: strict ? ("high" as const) : ("medium" as const),
    title: "Live provider verification required",
    verdict: "review" as const,
  };
  return {
    errors: strict
      ? [...evaluation.errors, { code: "required_provider_unavailable", message }]
      : evaluation.errors,
    findings: [...evaluation.findings, finding].sort((left, right) =>
      left.ruleId.localeCompare(right.ruleId),
    ),
    verdict: strict ? "error" : evaluation.verdict === "allow" ? "review" : evaluation.verdict,
  };
}

function offlineFailure(now: Date, message: string): Extract<NpmProviderResult, { ok: false }> {
  return { fetchedAt: now.toISOString(), message, ok: false, status: "network_error" };
}

function isOsvProviderResult(value: ResolvedOsvResult): value is OsvProviderResult {
  return Boolean(value && value.status !== "disabled");
}

export async function readPolicyFile(
  path: string,
  optionsOrOpen: FileReadOptions | typeof open = {},
  inspectPath: typeof lstat = lstat,
): Promise<unknown> {
  const options = fileReadOptions(optionsOrOpen, inspectPath);
  const document = await readYamlFile(path, true, options, "Policy");
  if (document === undefined) throw new PolicyInputError("Policy file could not be read.");
  return document;
}

async function canonicalPolicyRoot(path: string, signal?: AbortSignal): Promise<string> {
  try {
    if (signal?.aborted) throw cancellationError(signal);
    const root = await realpath(path);
    if (signal?.aborted) throw cancellationError(signal);
    return root;
  } catch {
    if (signal?.aborted) throw cancellationError(signal);
    throw new PolicyInputError("Policy root could not be resolved.");
  }
}

export async function readOptionalPolicyFile(
  path: string,
  optionsOrOpen: FileReadOptions | typeof open = {},
  inspectPath: typeof lstat = lstat,
): Promise<unknown | undefined> {
  const options = fileReadOptions(optionsOrOpen, inspectPath);
  return await readYamlFile(path, false, options, "Policy");
}

export async function inspectOptionalRegularFile(
  path: string,
  inspectPath: typeof lstat = lstat,
): Promise<"absent" | "present" | "invalid"> {
  try {
    await inspectRegularPath(path, inspectPath, "Policy");
    return "present";
  } catch (error) {
    return isMissingFile(error) ? "absent" : "invalid";
  }
}

export async function readApprovalFile(
  path: string,
  required: boolean,
  optionsOrOpen: FileReadOptions | typeof open = {},
  inspectPath: typeof lstat = lstat,
): Promise<unknown | undefined> {
  const options = fileReadOptions(optionsOrOpen, inspectPath);
  return await readYamlFile(path, required, options, "Approval");
}

interface FileReadOptions {
  inspectPath?: typeof lstat;
  openFile?: typeof open;
  signal?: AbortSignal | undefined;
}

function fileReadOptions(
  optionsOrOpen: FileReadOptions | typeof open,
  inspectPath: typeof lstat,
): FileReadOptions {
  return typeof optionsOrOpen === "function"
    ? { inspectPath, openFile: optionsOrOpen }
    : optionsOrOpen;
}

async function readYamlFile(
  path: string,
  required: boolean,
  options: FileReadOptions,
  kind: "Approval" | "Policy",
): Promise<unknown | undefined> {
  const openFile = options.openFile ?? open;
  const inspectPath = options.inspectPath ?? lstat;
  if (options.signal?.aborted) throw cancellationError(options.signal);
  let initialStats: Stats;
  try {
    initialStats = await inspectRegularPath(path, inspectPath, kind);
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (!required && isMissingFile(error)) return undefined;
    if (error instanceof PolicyInputError) throw error;
    throw new PolicyInputError(`${kind} file could not be read.`);
  }
  let handle: FileHandle;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    if (!required && isMissingFile(error)) return undefined;
    throw new PolicyInputError(`${kind} file could not be read.`);
  }
  try {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      !sameFileIdentity(initialStats, stats) ||
      stats.size > maximumPolicyBytes
    ) {
      throw new PolicyInputError(`${kind} file must be a regular file no larger than 256 KiB.`);
    }
    const buffer = Buffer.alloc(maximumPolicyBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maximumPolicyBytes) {
      throw new PolicyInputError(`${kind} file exceeded the 256 KiB limit.`);
    }
    if (options.signal?.aborted) throw cancellationError(options.signal);
    const finalStats = await inspectRegularPath(path, inspectPath, kind);
    if (
      !sameFileIdentity(initialStats, finalStats) ||
      finalStats.size !== initialStats.size ||
      bytesRead !== initialStats.size
    ) {
      throw new PolicyInputError(`${kind} file changed while it was being read.`);
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

async function inspectRegularPath(
  path: string,
  inspectPath: typeof lstat,
  kind: "Approval" | "Policy",
): Promise<Stats> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  let stats: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    stats = await inspectPath(current);
    const final = index === segments.length - 1;
    if (stats.isSymbolicLink() || (final ? !stats.isFile() : !stats.isDirectory())) {
      throw new PolicyInputError(`${kind} file must be a regular file and must not use symlinks.`);
    }
  }
  if (!stats || stats.size > maximumPolicyBytes) {
    throw new PolicyInputError(`${kind} file must be a regular file no larger than 256 KiB.`);
  }
  return stats;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function providerStatuses(
  result: NpmProviderResult | undefined,
  osvResult: ResolvedOsvResult,
  npmStale?: string,
  osvStale?: string,
  npmCached?: boolean,
  osvCached?: boolean,
): ProviderStatus[] {
  const statuses: ProviderStatus[] = [];
  if (result) {
    if (npmStale)
      statuses.push({
        fetchedAt: npmStale,
        message: "npm cache evidence is stale",
        provider: "npm",
        status: "stale",
      });
    else if (npmCached)
      statuses.push({
        fetchedAt: result.fetchedAt,
        message: "using unauthenticated cached evidence; live verification required",
        provider: "npm",
        status: "offline",
      });
    else if (result.ok)
      statuses.push({ fetchedAt: result.fetchedAt, provider: "npm", status: "ok" });
    else {
      const status =
        result.status === "timeout" || result.status === "rate_limited"
          ? result.status
          : result.status === "network_error"
            ? "offline"
            : "error";
      statuses.push({
        fetchedAt: result.fetchedAt,
        message: "npm provider unavailable",
        provider: "npm",
        status,
      });
    }
  }
  if (osvResult?.status === "disabled") {
    statuses.push({
      message: "OSV evidence provider is disabled by policy",
      provider: "osv",
      status: "disabled",
    });
  } else if (osvResult && isOsvProviderResult(osvResult)) {
    if (osvStale) {
      statuses.push({
        fetchedAt: osvStale,
        message: "osv cache evidence is stale",
        provider: "osv",
        status: "stale",
      });
    } else if (osvCached) {
      statuses.push({
        fetchedAt: osvResult.fetchedAt,
        message: "using unauthenticated cached evidence; live verification required",
        provider: "osv",
        status: "offline",
      });
    } else if (osvResult.ok) {
      statuses.push({ fetchedAt: osvResult.fetchedAt, provider: "osv", status: "ok" });
    } else {
      const status =
        osvResult.status === "timeout" || osvResult.status === "rate_limited"
          ? osvResult.status
          : osvResult.status === "network_error"
            ? "offline"
            : "error";
      statuses.push({
        fetchedAt: osvResult.fetchedAt,
        message: "osv provider unavailable",
        provider: "osv",
        status,
      });
    }
  }
  return statuses;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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
    `AgentHawk v${AGENTHAWK_VERSION}`,
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

export function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function normalizedEvidenceForDigest(
  result: NpmProviderResult | undefined,
  osvResult: ResolvedOsvResult,
  specType: "non_registry" | "registry",
): unknown {
  return {
    npm: result
      ? result.ok
        ? { data: result.data, fetchedAt: result.fetchedAt, status: result.status }
        : { fetchedAt: result.fetchedAt, status: result.status }
      : { specType },
    osv: osvEvidenceForDigest(osvResult),
  };
}

function osvEvidenceForDigest(osvResult: ResolvedOsvResult): unknown {
  if (!osvResult) return { status: "skipped" };
  if (osvResult.status === "disabled") return { status: "disabled" };
  if (osvResult.ok) {
    return {
      fetchedAt: osvResult.fetchedAt,
      records: osvResult.records,
      status: osvResult.status,
    };
  }
  return { fetchedAt: osvResult.fetchedAt, status: osvResult.status };
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

export class PolicyInputError extends Error {}
