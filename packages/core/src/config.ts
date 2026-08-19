import { z } from "zod";

export const policyActionSchema = z.enum(["allow", "warn", "review", "block"]);
export type PolicyAction = z.infer<typeof policyActionSchema>;

const configurableRule = (defaultAction: PolicyAction) =>
  z
    .object({ action: policyActionSchema.default(defaultAction) })
    .strict()
    .default({ action: defaultAction });

const defaultsSchema = z
  .object({
    onProviderError: z.enum(["review", "error"]).default("review"),
    onUnknownVersion: z.enum(["review", "error"]).default("review"),
    allowPrerelease: z.boolean().default(false),
  })
  .strict();

const rulesSchema = z
  .object({
    packageAge: z
      .object({
        minDays: z.number().int().nonnegative().default(30),
        action: policyActionSchema.default("review"),
      })
      .strict()
      .default({ minDays: 30, action: "review" }),
    releaseAge: z
      .object({
        minHours: z.number().int().nonnegative().default(72),
        action: policyActionSchema.default("review"),
      })
      .strict()
      .default({ minHours: 72, action: "review" }),
    requireRepositoryUrl: configurableRule("warn"),
    deprecatedPackage: configurableRule("review"),
    lifecycleScripts: z
      .object({
        action: policyActionSchema.default("review"),
        scripts: z
          .array(z.enum(["preinstall", "install", "postinstall", "prepack", "prepare"]))
          .min(1)
          .default(["preinstall", "install", "postinstall", "prepack", "prepare"]),
      })
      .strict()
      .default({
        action: "review",
        scripts: ["preinstall", "install", "postinstall", "prepack", "prepare"],
      }),
    similarToExistingDependency: configurableRule("review"),
    knownMaliciousPackage: z
      .object({ action: z.literal("block").default("block") })
      .strict()
      .default({ action: "block" }),
    vulnerabilities: z
      .object({
        action: policyActionSchema.default("review"),
        severities: z
          .array(z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]))
          .min(1)
          .default(["CRITICAL", "HIGH"]),
      })
      .strict()
      .default({ action: "review", severities: ["CRITICAL", "HIGH"] }),
    nonRegistrySpecifier: configurableRule("review"),
  })
  .strict();

const defaultRules: z.infer<typeof rulesSchema> = {
  packageAge: { minDays: 30, action: "review" },
  releaseAge: { minHours: 72, action: "review" },
  requireRepositoryUrl: { action: "warn" },
  deprecatedPackage: { action: "review" },
  lifecycleScripts: {
    action: "review",
    scripts: ["preinstall", "install", "postinstall", "prepack", "prepare"],
  },
  similarToExistingDependency: { action: "review" },
  knownMaliciousPackage: { action: "block" },
  vulnerabilities: {
    action: "review",
    severities: ["CRITICAL", "HIGH"],
  },
  nonRegistrySpecifier: { action: "review" },
};

export const agentHawkConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["review", "strict"]).default("review"),
    defaults: defaultsSchema.default({
      onProviderError: "review",
      onUnknownVersion: "review",
      allowPrerelease: false,
    }),
    registries: z
      .object({ npm: z.object({ enabled: z.boolean().default(true) }).strict() })
      .strict()
      .default({ npm: { enabled: true } }),
    rules: rulesSchema.default(defaultRules),
    approvals: z
      .object({
        requireReason: z.literal(true).default(true),
        requireExpiry: z.literal(true).default(true),
        maxValidityDays: z.number().int().positive().max(3650).default(180),
      })
      .strict()
      .default({ requireReason: true, requireExpiry: true, maxValidityDays: 180 }),
    ci: z
      .object({ failOn: z.array(z.enum(["warn", "review", "block", "error"])).min(1) })
      .strict()
      .default({ failOn: ["review", "block", "error"] }),
  })
  .strict();

export type AgentHawkConfig = z.infer<typeof agentHawkConfigSchema>;
