# ADR 0014: Codex native support scope

Status: Accepted — no native adapter is supported yet

Date: 2026-08-24

## Context

Milestone 17 now has substantial exact-version evidence for the Codex
`rust-v0.149.0` `PreToolUse` command-hook candidate on Windows. Unit, process,
packed-consumer, local CLI, local app-server, project ownership/activation, and
disposable managed-only gates pass. That evidence is intentionally split by
host surface and authority; passing one row cannot establish another.

The roadmap's supported-adapter exit criteria are stricter than one local run.
The completed local ordinary-CLI harness proves an allowed explicit dependency
addition proceeds; every `warn`, `review`, `block`, and `error` outcome denies;
malformed input denies visibly; an unrelated command makes zero provider calls;
the enabled tool inventory has no alternate execution surface; and controlled
latency targets pass. The project-hook ownership lifecycle is also exercised
through local app-server stdio. Neither local result is independently
reproducible on the current hosted Windows environment.

Exact tagged-source review also bounds the hook's coverage. Tool dispatch runs
`PreToolUse` only when a handler exposes a pre-tool payload. The pinned
`CodeModeExecuteHandler` uses the default implementation and exposes none,
while `Feature::CodeMode` and `Feature::CodeModeOnly` default to disabled in this
tag. A support claim therefore has to bind the effective tool surface and must
not imply interception when those experimental modes or another uncovered tool
path are enabled.

Primary sources, accessed 2026-08-24:

- [Codex `rust-v0.149.0` tool registry](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/core/src/tools/registry.rs)
- [Codex `rust-v0.149.0` code-mode execute handler](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/core/src/tools/code_mode/execute_handler.rs)
- [Codex `rust-v0.149.0` feature defaults](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/features/src/lib.rs)
- [Codex command-hook output schema](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json)
- [Codex `rust-v0.149.0` restricted-token filesystem projection](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/sandboxing/src/windows.rs#L131-L151)

## Decision

AgentHawk does not support a Codex native adapter in this source revision. The
row below remains the first eligibility target; passing a different host or
authority gate does not establish it.

The first eligible support target is deliberately narrow:

- Codex CLI exactly `0.149.0`;
- Windows x64 local CLI;
- project-owned synchronous `PreToolUse` command hook installed by the
  collision-safe AgentHawk lifecycle;
- the exact `shell_command`/`Bash` payload contract and `portable` qualifier;
- hooks enabled, exact project trusted, `code_mode` and `code_mode_only`
  disabled, `workspace-write`, `approval_policy = "never"`, and the documented
  unelevated Windows sandbox;
- cooperative `project` deployment trust only; and
- protected scan/diff CI as the final repository boundary.

The exact-artifact CLI project-hook harness uses the production installer. A
local standard-user run proves the following without a real package manager or
package code, but that result is not independently reproducible in the current
hosted gate:

1. exact installed hook discovery and trust;
2. unrelated command execution with zero provider calls;
3. an allowed mature registry dependency reaches a fake package-manager marker;
4. a `warn` result denies as `warning_requires_review` with a visible bounded
   explanation and leaves its marker absent, unless that exact host first proves
   a neutral visible-warning channel;
5. distinct `review` and `block` verdicts each leave their marker absent;
6. a required-provider failure under strict provider-error policy produces an
   actual `error` verdict and leaves its marker absent;
7. malformed adapter input and emergency exit `2` remain blocking;
8. the advertised shell tool is present and no enabled alternate execution
   surface bypasses the hook;
9. removal and recovery instructions match the already proven exact-owned
   lifecycle; and
10. the roadmap performance targets are measured without changing verdicts.

Evidence from app-server stdio may supplement that CLI row, but it cannot
substitute for the user-facing launch proof. Desktop, IDE/extension, Remote,
cloud, elevated sandbox, Linux, macOS, managed installation, other Codex
versions, and other vendors remain separate unsupported rows.

The checksum-pinned official artifact on GitHub-hosted Windows runs under an
administrator account. In that environment Codex `0.149.0` rejects the ordinary
neutral command because its unelevated restricted-token backend cannot enforce
the effective split writable-root set without running unsandboxed. The hosted
workflow pins the normalized output digest and the exact tagged-source reason,
requires the neutral marker to be truly absent, requires zero provider traffic,
and verifies exact-owned removal. It does not generalize the failure into a
claim that Codex rejects every administrator account. AgentHawk does not disable
the sandbox, use danger-full-access, or convert the exclusion into support. A
fresh standard-user Windows runner with the same exact-artifact matrix is still
required before this row can become supported.

## Alternatives

- Supporting the app-server row immediately was rejected because it lacks the
  complete allow/warn/review/block/error real-host matrix and is not the ordinary
  CLI launch experience described to users.
- Treating managed-only success as overall adapter approval was rejected because
  deployment authority and action coverage are independent properties.
- Waiting for every Codex product and operating system before supporting any row
  was rejected because exact per-surface support is more accurate and reviewable.
- Calling uncovered Code Mode an acceptable generic bypass was rejected for the
  first support row. The eligible row requires those experimental execution
  modes disabled and independently verifies the exposed tool set.

## Security implications

This decision prevents a partial compatibility result from becoming a broad
security claim. Even the future narrow row will remain defense in depth: a
project actor can alter project configuration, a host timeout or missing process
can fail outside AgentHawk, wrappers or unsupported syntax can evade
qualification, and post-change CI remains authoritative. AgentHawk will claim
only that recognized dependency-add shell calls reaching the exact enabled hook
receive deterministic policy enforcement.

## Consequences

Public guidance keeps all native adapters unsupported. The local harness
inventories the enabled tool set, uses ordinary `codex exec`, records each host
scenario's live-evidence time, and measures controlled nearest-rank p95
unrelated qualification, fresh cache-hit, and loopback live-evidence targets
without changing verdicts. The hosted restricted-token exclusion is separately
checksum-pinned and green only for the exact normalized rejection, true marker
absence, zero provider traffic, and removal. Claude Code is
the next dependency-ordered research target under the roadmap's explicit
unsupported-closure rule; it inherits no Codex evidence.
