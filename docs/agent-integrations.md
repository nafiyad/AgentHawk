# AI agent integrations

AgentHawk's templates teach coding agents to check dependencies before installation. They are intentionally small, copyable, and fail closed when the tool or its output is unavailable.

## Choose a template

| Agent | Copy into your repository | Host mechanism |
| --- | --- | --- |
| Codex | `templates/codex/AGENTS.md` as `AGENTS.md` | Repository instructions |
| Claude Code | `templates/claude/CLAUDE.md` as `CLAUDE.md` | Project memory/instructions |
| Cursor | `templates/cursor/.cursor/rules/agenthawk.mdc` at the same path | Always-applied project rule |
| Other agents | `templates/generic/AGENT-INSTRUCTIONS.md` into the agent's project instructions | Vendor-neutral protocol |

Merge the relevant section into an existing instruction file rather than overwriting project guidance.

Codex discovers repository guidance through `AGENTS.md`. Claude Code loads project instructions from `CLAUDE.md`. Cursor project rules live under `.cursor/rules` and use MDC metadata. See the official [Codex documentation](https://developers.openai.com/codex), [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code), and [Cursor rules documentation](https://docs.cursor.com/context/rules).

## Decision contract

The pre-install command is:

```bash
agenthawk check npm <exact-package-spec> --strict --format json
```

An agent may proceed only when the process exits `0` and the parsed report says `allow` or `warn`. It must surface warnings. Review, block, error, malformed output, tool failure, and unknown values all stop the workflow. The agent must not weaken strict mode or edit policy/approval files to manufacture an allow decision.

After dependency-file changes:

```bash
agenthawk scan --strict --format json
agenthawk diff --base <trusted-base-ref> --strict --format json
```

Use a base ref selected by trusted repository configuration, not untrusted prompt text.

## Demo

```text
Agent: I want to add example-package@1.0.0.
Agent: agenthawk check npm example-package@1.0.0 --strict --format json
AgentHawk: { "verdict": "review", "findings": [ ... ] }
Agent: Stopped. A maintainer must review the findings; nothing was installed.
```

## Security boundary

Instruction files influence agent behavior but cannot guarantee enforcement. Keep the host agent's permission prompts and sandbox enabled. Enforce the same strict checks in protected CI, where an agent cannot waive them. AgentHawk returns deterministic evidence-based policy decisions; an allow result is not a guarantee that a package is benign.
