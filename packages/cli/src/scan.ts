import type { EvaluationReport } from "@agenthawk/core";
import {
  type CheckDependencies,
  type CheckOptions,
  checkNpmPackage,
  type OutputFormat,
} from "./check.js";
import { inventoryDependencies } from "./diff.js";
import { escapeTerminal } from "./terminal.js";

interface ScanOptions extends Omit<CheckOptions, "format"> {
  cwd?: string;
  format: OutputFormat;
}

export async function scanDependencies(
  options: ScanOptions,
  dependencies: CheckDependencies = {},
): Promise<{ exitCode: number; output: string }> {
  const inventory = await inventoryDependencies({
    ...(options.cwd ? { cwd: options.cwd } : {}),
    format: "json",
  });
  if (inventory.exitCode !== 0) return inventory;
  const direct = JSON.parse(inventory.output).dependencies as Array<{
    name: string;
    requestedSpec: string;
    section: string;
  }>;
  const results: Array<{ report: EvaluationReport; section: string }> = [];
  for (const item of direct) {
    const checked = await checkNpmPackage(
      `${item.name}@${item.requestedSpec}`,
      { ...options, format: "json" },
      dependencies,
    );
    const parsed = JSON.parse(checked.output) as EvaluationReport | { error: unknown };
    if (!("schemaVersion" in parsed)) return checked;
    results.push({ report: parsed, section: item.section });
  }
  const verdict = aggregateVerdict(results.map(({ report }) => report.verdict));
  const exitCode =
    verdict === "error" ? 3 : options.strict && ["review", "block"].includes(verdict) ? 1 : 0;
  const report = { schemaVersion: "1.0", manifest: "package.json", verdict, results };
  if (options.format === "json")
    return { exitCode, output: `${JSON.stringify(report, null, 2)}\n` };
  const lines = [`AgentHawk dependency scan: ${verdict.toUpperCase()}`];
  for (const result of results) {
    lines.push(
      `${result.report.verdict.toUpperCase()} ${result.report.target.name} (${result.section})`,
    );
    for (const finding of result.report.findings)
      lines.push(`  ${finding.ruleId}: ${finding.message}`);
  }
  return { exitCode, output: `${lines.map(escapeTerminal).join("\n")}\n` };
}

function aggregateVerdict(verdicts: EvaluationReport["verdict"][]): EvaluationReport["verdict"] {
  const rank = { allow: 0, warn: 1, review: 2, block: 3, error: 4 } as const;
  return verdicts.reduce<EvaluationReport["verdict"]>(
    (current, verdict) => (rank[verdict] > rank[current] ? verdict : current),
    "allow",
  );
}
