export {
  type ApprovalApplication,
  type ApprovalFile,
  type ApprovalRecord,
  type ApprovalTimeSummary,
  applyApprovals,
  approvalFileSchema,
  approvalRecordSchema,
  summarizeApprovalTimes,
} from "./approvals/index.js";
export {
  type CacheProvider,
  type CacheReadResult,
  cacheKeyDigest,
  defaultCacheRoot,
  MetadataCache,
  type MetadataCacheOptions,
} from "./cache/metadata-cache.js";
export {
  type ApprovalValidationReport,
  approvalValidationReportSchema,
  type CliErrorReport,
  cliErrorCodeSchema,
  cliErrorReportSchema,
  type DiffReport,
  diffReportSchema,
  directDependencySchema,
  type InventoryReport,
  inventoryReportSchema,
  type PolicyValidationReport,
  policyValidationReportSchema,
  type ScanReport,
  scanReportSchema,
} from "./cli-contract.js";
export {
  type AgentHawkConfig,
  agentHawkConfigSchema,
  type PolicyAction,
  policyActionSchema,
} from "./config.js";
export {
  type ApprovalMatch,
  approvalMatchSchema,
  type EvaluationReport,
  type Evidence,
  evaluationReportSchema,
  evidenceSchema,
  type Finding,
  type FindingBasis,
  findingBasisSchema,
  findingSchema,
  type PackageCoordinate,
  type ProviderStatus,
  packageCoordinateSchema,
  providerStatusSchema,
  type Severity,
  severitySchema,
  type Verdict,
  verdictSchema,
} from "./domain.js";
export {
  type HttpErrorKind,
  type JsonHttpClient,
  type JsonRequestClient,
  SafeHttpClient,
  type SafeHttpClientOptions,
  SafeHttpError,
} from "./http/safe-http-client.js";
export {
  type NpmPackageMetadata,
  type NpmProviderResult,
  NpmRegistryProvider,
  type NpmRegistryProviderOptions,
  npmResultForCache,
  parseCachedNpmResult,
} from "./npm/provider.js";
export {
  type NonRegistryKind,
  type NpmNonRegistrySpec,
  type NpmRegistrySpec,
  type NpmSelectorKind,
  NpmSpecError,
  type ParsedNpmSpec,
  parseNpmSpec,
} from "./npm/spec.js";
export {
  classifyOsvRecord,
  type OsvBatchItem,
  type OsvBatchProviderResult,
  type OsvPackageQuery,
  OsvProvider,
  type OsvProviderOptions,
  type OsvProviderResult,
  type OsvRecord,
  type OsvSeverity,
  osvSeveritySchema,
  parseCachedOsvResult,
} from "./osv/provider.js";
export {
  combineVerdicts,
  evaluatePolicy,
  type PolicyEvaluation,
  type PolicyEvaluationError,
  type PolicyEvaluationInput,
} from "./policy/engine.js";
export {
  compareDirectDependencies,
  type DependencyChange,
  type DependencySection,
  type DirectDependency,
  dependencyChangeSchema,
  dependencySectionSchema,
  directDependencies,
  type PackageManifest,
  packageManifestSchema,
} from "./scan/dependencies.js";
export { AGENTHAWK_VERSION } from "./version.js";
