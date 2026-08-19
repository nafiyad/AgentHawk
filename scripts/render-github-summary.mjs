import { open, readFile } from "node:fs/promises";

const [reportPath, summaryPath] = process.argv.slice(2);
if (!reportPath || !summaryPath) throw new Error("Report and summary paths are required.");
const source = await readFile(reportPath);
if (source.byteLength > 2_097_152) throw new Error("AgentHawk report exceeds 2 MiB.");
const report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source));
if (
  report.schemaVersion !== "1.0" ||
  !Array.isArray(report.changes) ||
  !Array.isArray(report.findings)
) {
  throw new Error("AgentHawk report schema is invalid.");
}
const escapeMarkdown = (value) =>
  [...String(value)]
    .map((character) => {
      const code = character.codePointAt(0);
      return (code < 32 && code !== 9) ||
        (code >= 127 && code <= 159) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
    })
    .join("")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll(/([`*_{}[\]()#+.!|~>-])/gu, "\\$1")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
const lines = [
  "## AgentHawk dependency diff",
  "",
  `**Verdict:** ${escapeMarkdown(report.verdict)}`,
  "",
  "| Change | Dependency | Section |",
  "|---|---|---|",
];
for (const change of report.changes.slice(0, 64))
  lines.push(
    `| ${escapeMarkdown(change.kind)} | <code>${escapeMarkdown(change.name)}@${escapeMarkdown(change.requestedSpec)}</code> | ${escapeMarkdown(change.section)} |`,
  );
for (const finding of report.findings.slice(0, 32))
  lines.push("", `- **${escapeMarkdown(finding.ruleId)}:** ${escapeMarkdown(finding.message)}`);
const summary = `${lines.join("\n").slice(0, 65_536)}\n`;
const handle = await open(summaryPath, "a", 0o600);
try {
  await handle.writeFile(summary, "utf8");
} finally {
  await handle.close();
}
