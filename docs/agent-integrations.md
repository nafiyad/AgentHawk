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

For a fresh target, `agenthawk init --integration <codex|claude|cursor|generic>` creates the canonical policy and selected template with collision-safe fixed paths. It refuses different existing content; use the copy table above for a manual reviewed merge instead. See [initialization and recovery](initialization.md).

## Codex native compatibility candidate

No native row is supported. Codex CLI `0.149.0` on Windows x64, launched
locally through ordinary `codex exec`, with the
project-owned synchronous `PreToolUse` `shell_command` hook installed by
AgentHawk. The exact hook hash must be trusted in Codex; hooks must be enabled;
experimental Code Mode paths must remain disabled; and the run must use
`workspace-write`, `approval_policy = "never"`, and the documented unelevated
Windows sandbox has a complete local compatibility matrix. The pinned hosted
Windows environment runs as administrator, where Codex rejects ordinary
sandboxed execution, so that local result is not a supported product boundary.

From the canonical Git repository root, inspect before mutation, install only
into empty AgentHawk-owned fixed targets, and inspect again:

```bash
agenthawk integrations codex status --format json
agenthawk integrations codex install --format json
agenthawk integrations codex status --format json
```

These lifecycle commands are compatibility-candidate operations, not supported
enforcement. Codex intentionally requires a human to trust the exact discovered project-hook
definition. AgentHawk does not automate or bypass that host decision. If the
status is not exact and ready, or Codex exposes an alternate execution tool,
stop and use protected `scan`/`diff` CI instead. To recover, close Codex, confirm
no integration operation is active, run `agenthawk integrations codex remove`,
verify `status`, and retry only after reviewing any documented fixed-target
recovery state. The currently published `0.1.0-alpha.1` package predates these
commands; verify an installed version with `agenthawk --help`.

## Claude Code native research candidate

No Claude Code native adapter is supported or installable. [ADR 0015](adr/0015-claude-code-hook-edge.md)
pins local CLI `2.1.241` as the first research candidate and keeps `Bash` and
`PowerShell` as distinct shell rows. Interactive hooks wait for current-folder
or inherited parent trust, while `-p`/SDK has no trust dialog. Hooks run with full
user permissions; startup failure, malformed output, and timeout are non-blocking.
The next implementation slice is fixtures and an adapter process only. Continue
to use the advisory `CLAUDE.md` template and protected `scan`/`diff` CI.

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
