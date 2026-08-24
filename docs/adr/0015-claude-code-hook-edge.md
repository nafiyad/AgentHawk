# ADR 0015: Claude Code hook edge

## Status

Accepted. The closed fixture adapter is implemented; no Claude Code installation
lifecycle, host compatibility row, or native support is authorized by this decision.

## Context

Milestone 17 requires each vendor edge to be researched and proven independently.
Codex payloads, tool names, trust behavior, lifecycle ownership, host evidence, and
support conclusions do not transfer to Claude Code.

Research used current official Anthropic material and the official release record,
accessed 2026-08-24:

| Source | Relevant finding | Confidence and limitation | AgentHawk implication |
| --- | --- | --- | --- |
| [Hooks reference](https://code.claude.com/docs/en/hooks) | `PreToolUse` covers canonical `Bash` and `PowerShell` tools. Both expose `command`, optional `description`, optional tool timeout, and optional background state. Silent exit `0` leaves the normal permission flow unchanged; structured `deny` or exit `2` blocks. All matching hooks run in parallel. Command-hook startup failure, non-2 exit, malformed structured output, and timeout are non-blocking | High for the current documented contract; host builds can change independently | Use one synchronous command hook, no `if` prefilter, neutral silence, structured deny, and an independent exit-2 emergency denial. Never claim universal fail-closed behavior |
| [Hooks security and workspace trust](https://code.claude.com/docs/en/hooks#security-considerations) | Command hooks run with the user's permissions and inherited Claude Code environment, except documented removals | High for documented settings-file hooks; it does not authenticate which file produced an individual payload | Treat every payload and environment as untrusted. A project hook is repository-controlled executable configuration, not a trust boundary |
| [Permissions and workspace trust](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder) | Interactive sessions hold settings-file hooks until the folder is trusted or previously accepted parent-folder trust extends to it. `-p`/SDK sessions show no trust dialog and treat the folder as trusted; `--bare` or excluding project setting sources avoids auto-discovered project hooks | High; behavior is version-sensitive and changed in prior releases | Do not infer deployment trust from `cwd`, session mode, or the fact that the hook ran. Document the risk of running `claude -p` in unreviewed repositories |
| [Settings](https://code.claude.com/docs/en/settings) | Hook sources include managed, command-line, local, project, and user settings. `disableAllHooks` can disable non-managed hooks. `allowManagedHooksOnly` blocks user/project hooks and admits only managed, SDK, and specifically managed plugin hooks | High for documented settings resolution; settings can reload during a session | A later lifecycle must verify exact current state at invocation. Project installation cannot claim managed authority or availability under managed-only policy |
| [Programmatic use](https://code.claude.com/docs/en/headless) | `-p` normally loads project hooks without a trust dialog; `--bare` skips auto-discovered hooks. Bare mode is recommended for scripts and is planned to become the `-p` default | High for current CLI documentation; the future default has no promised version | A project-hook harness must prove ordinary interactive and `-p` surfaces separately and must detect when bare mode excludes the hook |
| [Environment variables](https://code.claude.com/docs/en/env-vars) | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes documented Anthropic and cloud credentials from Bash commands, hooks, and stdio MCP servers | High for the documented credential classes; it is not a universal environment scrub | Enable the setting in later real-host matrices and prove fake credential sentinels are absent. The adapter must still ignore the complete inherited environment |
| [Interactive shell mode](https://code.claude.com/docs/en/interactive-mode#shell-mode-with-prefix) | A leading `!` runs a shell command directly without Claude interpreting or approving it | High for the direct-execution behavior; the documentation does not establish whether `PreToolUse` receives this path | Treat direct shell mode as a candidate bypass and require an exact-host test before any interactive support claim |
| [Permissions](https://code.claude.com/docs/en/permissions) | A blocking hook precedes allow rules. Claude Code has distinct Bash and PowerShell parsers and canonical tools. On Windows the PowerShell tool may replace Bash entirely | High for current permissions behavior; vendor parsing is not AgentHawk's security parser | Match `Bash|PowerShell`; never treat a Bash-only row as Windows coverage. Keep PowerShell dependency adds unsupported until its own restricted grammar passes |
| [Claude Code v2.1.241](https://github.com/anthropics/claude-code/releases/tag/v2.1.241) | The official 2026-08-23 release tag resolves to commit `45bdfa96ca415da92e62b6ca85a1d6e29adf3c44` and provides platform artifacts with SHA-256 metadata. The Windows x64 artifact digest is `e80109edee1e1c0df3a7af06fb899c024b84a137809c0d74dd9e1c1cb11e3413` | High for release identity and artifact metadata; binaries are not a public source-level schema authority | Pin the first real-host candidate to exact version, tag commit, platform, artifact digest, surface, and settings source. Documentation alone cannot establish compatibility |

The local executable discovered during research is Claude Code `2.1.141` from
the deprecated npm installation path. It is not the pinned candidate and creates
no compatibility or support evidence. This slice did not install, update,
authenticate, or execute an agent session.

### Decision semantics

For `PreToolUse`, the safe output subset is smaller than Claude Code's full
contract:

- neutral: exit `0` with zero stdout bytes, leaving ordinary permissions intact;
- deny: exit `0` with only
  `hookSpecificOutput.hookEventName = "PreToolUse"`,
  `permissionDecision = "deny"`, and one fixed bounded reason;
- emergency deny: one fixed bounded redacted stderr line and exit `2`;
- never emit `allow`, `ask`, `defer`, `updatedInput`, `additionalContext`,
  `systemMessage`, `terminalSequence`, legacy decisions, or plain-text stdout.

`allow` would bypass the normal prompt and is therefore forbidden. `ask` would
delegate an AgentHawk verdict to host interaction. `defer` creates a resumption
state outside the current decision contract. Input rewriting and context output
would increase disclosure and authority without improving dependency admission.

Exit `2` is the emergency path because current documentation says it blocks even
when stdout is malformed. The first supported candidate must remain at or above
the documented `2.1.214` behavior boundary and must prove it against the exact
artifact. Any other nonzero exit, missing executable, spawn failure, invalid JSON,
or command-hook timeout can continue through the host's normal permission flow.

### Input boundary

The first edge will accept one fatal-UTF-8, size-bounded JSON object and model
only the current common fields required for framing plus:

- `hook_event_name: "PreToolUse"`;
- `tool_name: "Bash" | "PowerShell"`;
- `tool_input.command` as the only retained tool input;
- `tool_use_id` as a bounded framing identifier that is never reported;
- `cwd` as the untrusted action-directory candidate.

Optional documented fields such as `prompt_id`, `effort`,
`agent_id`, `agent_type`, `description`, tool timeout, and background state may
be validated and discarded only when exact fixtures require them. Transcript
paths, session identifiers, prompts, descriptions, environment values, and
unrelated tool input never enter evaluation, reports, digests, or diagnostics.
Unknown top-level and tool-input fields remain closed unless an exact current
fixture demonstrates a compatibility requirement and the security review accepts
the field.

The fixture edge validates every current documented `permission_mode`, including
`auto`, and the optional closed `effort.level` enum, then discards both. They do
not influence security policy or appear in output.

`Bash` maps to the existing restricted `posix` qualifier only on an exact
surface that proves Bash is the invoked shell. `PowerShell` maps to
`powershell`; the current qualifier intentionally does not admit PowerShell
dependency additions. A later slice may add a separate conservative PowerShell
grammar, but it must not reuse POSIX tokenization or silently treat every
PowerShell command as unrelated.

### Configuration and ownership proposal

The first fixture adapter is a dedicated binary with no Commander preprocessing.
[ADR 0016](0016-claude-project-hook-ownership.md) subsequently selects only a
previously absent machine-local `.claude/settings.local.json` as the exclusive
future candidate and keeps shareable `.claude/settings.json` maintainer-owned.
Neither decision authorizes overwriting, automatic merging, implicit trust, or
installation.

The proposed handler is synchronous `type: "command"`, matches
`Bash|PowerShell`, uses exec-form fixed executable/argument arrays where the
exact host supports them, and sets a ten-second timeout around AgentHawk's existing
eight-second internal deadline. It does not use the vendor `if` matcher because
AgentHawk must see ambiguous install-like strings itself. HTTP, MCP, prompt, and
agent hooks are excluded: they add network, external-tool, or LLM authority and
have different failure modes.

### Required evidence before support

Implementation proceeds in reviewable slices:

1. closed Claude payload parser, output serializer, emergency path, golden
   `Bash`/`PowerShell` fixtures, and adversarial process tests;
2. the accepted collision ADR followed by status-only preflight before any
   configuration mutation;
3. a root-bound format/transaction amendment, then collision-safe install/remove
   and invocation-time verification if every prerequisite is accepted;
4. an isolated exact-artifact CLI harness proving loaded source, effective tool
   inventory, neutral execution, every denial outcome, malformed denial, timeout
   behavior, credential-scrub sentinels, direct `!` shell behavior, zero-provider
   unrelated execution, exact removal, and performance;
5. separate interactive, `-p`, IDE, desktop, web, SDK, managed, operating-system,
   and shell rows. Evidence from one row unlocks none of the others.

No row becomes supported unless an exact real-host matrix proves a benign explicit
add proceeds; warn has a visible neutral channel or denies; review, block, error,
unsupported dependency-like input, and malformed input deny; unrelated commands
make zero provider calls; and no alternate shell tool bypasses the hook. Process
startup failure and host timeout remain documented fail-open residuals even after
a successful matrix. Protected `scan`/`diff` CI remains the final repository gate.

## Decision

Claude Code `2.1.241` local CLI is the first exact compatibility candidate.
AgentHawk will implement a separate `PreToolUse` command-hook edge for canonical
`Bash` and `PowerShell` inputs, using only neutral silence, structured deny, and
exit-2 emergency denial. It will reuse the vendor-neutral action/evaluation
contracts but inherit no Codex parser, serializer, configuration, lifecycle,
host result, timeout claim, or support status.

Every Claude native surface remains unsupported. The closed fixture adapter is
implemented; configuration mutation still waits for root-bound format,
transaction, recovery, invocation-verification, and exact-host gates after ADR
0016's read-only preflight.

## Alternatives

- Reusing the Codex adapter was rejected because the payload, tool identity,
  shell dialect, serializer, settings hierarchy, trust behavior, and failure
  modes differ.
- A Bash-only matcher was rejected because current Windows installations can
  expose PowerShell without registering Bash.
- Returning vendor `allow` was rejected because it skips normal permissions.
- A narrow vendor `if` matcher was rejected because unsupported wrappers and
  syntax must reach AgentHawk's conservative qualifier rather than bypass it.
- HTTP, prompt, agent, and MCP hooks were rejected for the first edge because
  they add network, LLM, subagent, or connected-tool authority.
- SDK callback hooks were deferred as a separate surface. Their in-process
  timeout behavior must not be generalized to ordinary CLI settings command
  hooks, whose startup and timeout failures are non-blocking.
- Immediate project installation was rejected because Claude settings are
  commonly maintainer-owned JSON. ADR 0016 now defines a read-only collision
  preflight and defers every mutation prerequisite.

## Security implications

The edge can deny only tool calls that reach the configured synchronous hook.
Project settings can be rewritten by a repository writer, disabled by higher
configuration, skipped by bare mode, or excluded by managed-only policy. A hook
that cannot start or times out is not a fail-closed boundary. Hooks also execute
with user permissions and an inherited environment; AgentHawk must ignore that
environment and emit no captured input or error detail.

All matching hooks complete in parallel, so AgentHawk denial cannot prevent a
sibling hook's side effects. Host permission rules and sandboxing remain separate
controls. Direct `!` shell execution remains a candidate bypass until the exact
host proves whether `PreToolUse` sees it. The documented subprocess environment
scrub removes named credential classes, not every inherited value; AgentHawk
still ignores the entire environment. A successful Claude row must not be described as universal dependency
interception, malware detection, tamper resistance, or proof of package safety.

## Consequences

This decision corrects the roadmap's older trust summary, fixes the version and
artifact candidate, and bounds the implemented fixture edge without activating a
host integration. It deliberately postpones PowerShell admission,
root-bound ownership artifacts, transactional lifecycle, host activation, and
support claims until their own evidence gates pass.
