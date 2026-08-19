import { z } from "zod";

const policyActionSchema = z.enum(["allow", "warn", "review", "block"]);

export const agentHawkConfigSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["review", "strict"]).default("review"),
    defaults: z
      .object({
        onProviderError: z.enum(["review", "error"]).default("review"),
        onUnknownVersion: z.enum(["review", "error"]).default("review"),
        allowPrerelease: z.boolean().default(false),
      })
      .strict(),
    registries: z
      .object({
        npm: z
          .object({
            enabled: z.boolean().default(true),
          })
          .strict(),
      })
      .strict(),
    rules: z
      .object({
        knownMaliciousPackage: z
          .object({
            action: z.literal("block").default("block"),
          })
          .strict(),
        requireRepositoryUrl: z
          .object({
            action: policyActionSchema.default("warn"),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type AgentHawkConfig = z.infer<typeof agentHawkConfigSchema>;
