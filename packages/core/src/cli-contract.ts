import { z } from "zod";
import { evaluationReportSchema, findingSchema, verdictSchema } from "./domain.js";
import { dependencyChangeSchema, dependencySectionSchema } from "./scan/dependencies.js";

export const cliErrorCodeSchema = z.enum(["invalid_input", "output_limit", "internal_error"]);

export const cliErrorReportSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    error: z
      .object({
        code: cliErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
    exitCode: z.union([z.literal(2), z.literal(4)]),
  })
  .strict();
export type CliErrorReport = z.infer<typeof cliErrorReportSchema>;

export const directDependencySchema = z
  .object({
    name: z.string().min(1),
    requestedSpec: z.string().min(1),
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
    base: z.string().min(1),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    manifest: z.literal("package.json"),
    changes: z.array(dependencyChangeSchema).max(64),
    lockfiles: z
      .object({
        present: z.array(z.string().min(1)),
        updated: z.array(z.string().min(1)),
      })
      .strict(),
    findings: z.array(findingSchema),
    verdict: z.enum(["allow", "review"]),
  })
  .strict();
export type DiffReport = z.infer<typeof diffReportSchema>;
