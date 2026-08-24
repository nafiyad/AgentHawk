# ADR 0014: Codex native support scope

Status: Accepted — no native adapter is supported yet

Date: 2026-08-24

## Context

Milestone 17 now has substantial exact-version evidence for the Codex
`rust-v0.149.0` `PreToolUse` command-hook candidate on Windows. Unit, process,
packed-consumer, local CLI, local app-server, project ownership/activation, and
disposable managed-only gates pass. That evidence is intentionally split by
host surface and authority; passing one row cannot establish another.

The roadmap's supported-adapter exit criteria are stricter than the evidence
currently recorded. An actual integration harness must prove an allowed explicit
dependency addition proceeds; every `review`, `block`, and `error` outcome
denies; malformed input denies visibly; and an unrelated command makes zero
provider calls. The present real-host project harness proves unrelated neutral
execution and one denied dependency addition, but not the complete outcome
matrix. Its project-hook lifecycle is exercised through local app-server stdio,
not through the ordinary user-facing CLI launch path.

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

## Decision

AgentHawk does not yet describe any Codex native adapter as supported. Passing
managed-only suppression completes an authority gate; it does not waive the
remaining supported-adapter exit criteria.

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

Before that row may be supported, one exact-artifact CLI project-hook harness
must use the production installer and prove all of the following without a real
package manager or package code:

1. exact installed hook discovery and trust;
2. unrelated command execution with zero provider calls;
3. an allowed mature registry dependency reaches a fake package-manager marker;
4. distinct review, block, and provider-error decisions each leave their marker
   absent;
5. malformed adapter input and emergency exit `2` remain blocking;
6. the advertised shell tool is present and no enabled alternate execution
   surface bypasses the hook;
7. removal and recovery instructions match the already proven exact-owned
   lifecycle; and
8. the roadmap performance targets are measured without changing verdicts.

Evidence from app-server stdio may supplement that CLI row, but it cannot
substitute for the user-facing launch proof. Desktop, IDE/extension, Remote,
cloud, elevated sandbox, Linux, macOS, managed installation, other Codex
versions, and other vendors remain separate unsupported rows.

## Alternatives

- Supporting the app-server row immediately was rejected because it lacks the
  complete allowed/review/block/error real-host matrix and is not the ordinary
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

Public installation guidance and the support matrix continue to say that no
native adapter is supported. The next implementation slice is not another
vendor: it is the exact Windows CLI project-hook outcome matrix above. Claude
Code work remains dependency-ordered after the first Codex row either passes or
is explicitly closed as unsupported by another reviewed decision.
