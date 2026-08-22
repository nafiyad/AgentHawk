import type { InitIntegration, InitTarget } from "@agenthawk/core";

export const INIT_POLICY = `${[
  "version: 1",
  "mode: review",
  "",
  "defaults:",
  "  onProviderError: review",
  "  onUnknownVersion: review",
  "  allowPrerelease: false",
  "",
  "registries:",
  "  npm:",
  "    enabled: true",
  "  osv:",
  "    enabled: true",
  "",
  "rules:",
  "  knownMaliciousPackage:",
  "    action: block",
  "  requireRepositoryUrl:",
  "    action: warn",
].join("\n")}\n`;

const CODEX_TEMPLATE = `${[
  "# Dependency admission with AgentHawk",
  "",
  "These instructions apply whenever you propose, add, install, or update a third-party npm dependency.",
  "",
  "1. Do not run a package manager or execute package code yet.",
  "2. Preserve the exact requested package specification. Do not replace a pinned version with a tag or range.",
  "3. Run `agenthawk check npm <exact-package-spec> --strict --format json`.",
  "4. Inspect both the process exit code and JSON report. Proceed only when the exit code is `0` and `verdict` is `allow` or `warn`.",
  "5. For `warn`, show the findings before proceeding. For `review`, stop and request human approval. For `block` or `error`, stop without installing.",
  "6. Treat malformed/missing JSON, an unavailable AgentHawk executable, or any nonzero/unknown exit code as an error and stop.",
  "7. Never retry without `--strict`, weaken policy, add an approval, use force flags, or bypass AgentHawk. Only a human maintainer may change policy or approvals.",
  "8. After manifest or lockfile changes, run `agenthawk scan --strict --format json` and the repository's normal tests. If a base ref is available, also run `agenthawk diff --base <trusted-base-ref> --strict --format json`.",
  "",
  "This instruction file is not a security boundary. AgentHawk evaluates evidence and policy; it does not prove that a package is safe. Repository CI remains authoritative.",
].join("\n")}\n`;

const CLAUDE_TEMPLATE = `${[
  "# Dependency admission with AgentHawk",
  "",
  "Before proposing, adding, installing, or updating any third-party npm dependency:",
  "",
  "- Do not execute the package manager or package code first.",
  "- Keep the user's exact package specification and run `agenthawk check npm <exact-package-spec> --strict --format json`.",
  "- Proceed only if the process exits `0` and the JSON verdict is `allow` or `warn`. Surface every warning.",
  "- Stop and ask a human for `review`. Do not install on `block` or `error`.",
  "- Fail closed if AgentHawk is unavailable, its output is missing or malformed, or its exit code/verdict is unknown.",
  "- Never omit `--strict`, change security policy, create an approval, use force flags, or retry in a weaker mode to obtain an allow result.",
  "- After dependency files change, run `agenthawk scan --strict --format json`; when a trusted base is known, also run `agenthawk diff --base <trusted-base-ref> --strict --format json`.",
  "",
  "This instruction file is not a security boundary. Preserve Claude Code permission controls and rely on protected CI for the final gate.",
].join("\n")}\n`;

const CURSOR_TEMPLATE = `${[
  "---",
  "description: Require AgentHawk admission checks before npm dependency changes",
  "globs:",
  "alwaysApply: true",
  "---",
  "",
  "# AgentHawk dependency gate",
  "",
  "Before proposing, adding, installing, or updating a third-party npm dependency:",
  "",
  "- Do not invoke a package manager or execute package code first.",
  "- Run `agenthawk check npm <exact-package-spec> --strict --format json` with the exact requested specification.",
  "- Proceed only for exit code `0` plus JSON verdict `allow` or `warn`; display warnings.",
  "- Stop for human review on `review`. Do not install on `block` or `error`.",
  "- Treat unavailable tooling, malformed/missing JSON, and unknown exit codes or verdicts as errors.",
  "- Never remove `--strict`, weaken policy, create approvals, use force flags, or otherwise bypass the decision.",
  "- After changes, run `agenthawk scan --strict --format json` and, when available, `agenthawk diff --base <trusted-base-ref> --strict --format json`.",
  "",
  "This rule guides Cursor Agent; it is not a security boundary. Protected CI must enforce AgentHawk independently.",
].join("\n")}\n`;

const GENERIC_TEMPLATE = `${[
  "# AgentHawk protocol for coding agents",
  "",
  "Apply this protocol before any third-party npm dependency is proposed, added, installed, or updated.",
  "",
  "```text",
  "PRECHECK",
  "  Do not install or execute package code.",
  "  Run: agenthawk check npm <exact-package-spec> --strict --format json",
  "",
  "DECIDE",
  "  Exit 0 + allow -> proceed",
  "  Exit 0 + warn  -> show findings, then proceed",
  "  review         -> stop and request human approval",
  "  block          -> stop; do not install",
  "  error          -> stop until evaluation succeeds",
  "  malformed/missing output, unavailable tool, unknown value, or nonzero exit -> stop",
  "",
  "VERIFY",
  "  Run: agenthawk scan --strict --format json",
  "  If a trusted base exists:",
  "  Run: agenthawk diff --base <trusted-base-ref> --strict --format json",
  "```",
  "",
  "The agent must not remove strict mode, alter policy or approvals, use force flags, or retry with weaker options. Human-controlled CI is the enforcement boundary.",
].join("\n")}\n`;

export interface InitAsset {
  content: string;
  segments: readonly string[];
  target: InitTarget;
}

const INTEGRATION_ASSETS: Record<Exclude<InitIntegration, "none">, InitAsset> = {
  codex: { content: CODEX_TEMPLATE, segments: ["AGENTS.md"], target: "codex" },
  claude: { content: CLAUDE_TEMPLATE, segments: ["CLAUDE.md"], target: "claude" },
  cursor: {
    content: CURSOR_TEMPLATE,
    segments: [".cursor", "rules", "agenthawk.mdc"],
    target: "cursor",
  },
  generic: {
    content: GENERIC_TEMPLATE,
    segments: ["AGENT-INSTRUCTIONS.md"],
    target: "generic",
  },
};

export function initAssets(integration: InitIntegration): readonly InitAsset[] {
  const policy = { content: INIT_POLICY, segments: [".agenthawk.yml"], target: "policy" } as const;
  return integration === "none" ? [policy] : [policy, INTEGRATION_ASSETS[integration]];
}
