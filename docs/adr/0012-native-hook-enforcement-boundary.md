# ADR 0012: Native hook enforcement boundary

## Status

Accepted.

## Context

AgentHawk's repository instructions are advisory. Current coding-agent platforms expose synchronous pre-tool hooks that can deny some shell tool calls before execution, but their payloads, configuration ownership, tool coverage, failure behavior, and cloud support differ. Treating those hooks as one uniform enforcement API would create false security claims.

The first native integration must protect the existing npm dependency-admission boundary without turning AgentHawk into an arbitrary shell parser, granting tool permission on the user's behalf, leaking command text, or weakening the independent `scan`, `diff`, and protected-CI controls.

Research for this decision used current primary vendor documentation, accessed 2026-08-21 and rechecked for the Codex implementation slice on 2026-08-23:

- [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenAI Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [OpenAI Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing)
- [OpenAI Codex Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [OpenAI Codex v0.149.0 generated hook schemas](https://github.com/openai/codex/tree/rust-v0.149.0/codex-rs/hooks/schema/generated)
- [OpenAI Codex v0.149.0 `PreToolUse` runtime](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/hooks/src/events/pre_tool_use.rs)
- [Anthropic Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [GitHub Copilot hooks overview](https://docs.github.com/en/copilot/concepts/agents/hooks)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)

The documented contracts are materially different:

| Platform | Pre-action and decision contract | Configuration authority and disabling | Execution, precedence, timeout, and cloud limits | Harness status |
| --- | --- | --- | --- | --- |
| Codex | `PreToolUse` receives `Bash` and other supported local tool calls; structured `permissionDecision: "deny"` or exit `2` denies | user, project, session, plugin, and managed sources; non-managed command hooks require trust review; managed configuration can require managed hooks only | matching command hooks launch concurrently; invalid/unsupported output can continue; specialized paths may bypass hooks; default command timeout is 600 seconds and no fail-closed timeout guarantee is documented; no cloud support claim is made here | `0.149.0` candidate and isolated harness implemented; Windows CLI neutral and denial paths passed under the explicit unelevated sandbox, but other named surfaces remain unproven; unsupported |
| Claude Code | `PreToolUse` receives `Bash` and `PowerShell`; structured deny or exit `2` denies | user, project, local, plugin, and managed sources; managed settings can restrict hooks; interactive project trust does not generalize to `-p`/SDK sessions | matching hooks can run in parallel and deny takes precedence; ordinary command-hook errors and timeouts are non-blocking; default command timeout is 600 seconds; commands run with user permissions and inherit the parent environment except documented removals | documentation fixture only; no supported AgentHawk adapter/version yet |
| Cursor | prefer narrow `beforeShellExecution`, with broader `preToolUse` evaluated separately; structured deny or exit `2` denies; the current contract documents permission decisions but no neutral/defer result | project, user, system/MDM, team, and enterprise cloud sources; enterprise has higher source priority and hooks are merged | failures are fail-open unless `failClosed: true`; under fail-closed configuration an empty/invalid response cannot be assumed neutral; cloud loads project/team/enterprise command hooks but not user hooks, and early read-only cloud turns do not run hooks; inputs/environment can expose workspace, transcript, session, and user data | unsupported under the no-auto-approve invariant unless a version-pinned real harness proves a true neutral result that preserves host permission flow |
| GitHub Copilot | `preToolUse` has distinct camelCase CLI/cloud and PascalCase compatibility payload forms; structured deny controls the call | CLI can combine machine policy, repository, user, inline, and plugin hooks; policy hooks require administrator installation and cannot be disabled normally; cloud has repository hooks only | matching hooks run in order and any deny wins; command-hook nonzero failures deny for this event, but timeouts are always fail-open, including policy hooks; default timeout is 30 seconds; cloud is non-interactive with pre-granted tool permissions and no user-visible notifications; outbound access is restricted to GitHub/Copilot hosts by default and other hosts require administrator firewall allowance; hook processes can receive Copilot API/Git credentials and prompt data that AgentHawk must ignore | documentation fixture only; no supported AgentHawk adapter/version yet |

Hook execution can also expose session identifiers, working directories, transcript paths, prompts, tool arguments, environment variables, user identity, or cloud credentials. AgentHawk needs only the event, tool name, bounded command, and working directory. It must not inspect, persist, hash, or render unrelated fields.

The 2026-08-23 Codex recheck pins the reviewed fixture contract to release `rust-v0.149.0`, commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`. Its generated `pre-tool-use.command.input` schema is a closed object requiring `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`, and `turn_id`, with optional `agent_id` and `agent_type`. The tagged `shell_command` and unified `exec_command` implementations pass `Bash` input as exactly `{ "command": string }`; AgentHawk validates that closed shape and retains only `cwd` and `command` in the transient action envelope. The generated output schema is broader than AgentHawk's safe subset: the adapter will emit only an empty successful response for neutral or `hookSpecificOutput.permissionDecision: "deny"` with a fixed non-empty reason. It will never emit `allow`, `ask`, `updatedInput`, legacy approve, continuation controls, or system context.

The tagged schema and runtime establish fixture provenance, not proof that the installed desktop host implements the same revision. The desktop-bundled executable could not be launched directly from the development shell on 2026-08-23, so a real-host compatibility claim remains gated even if the adapter, packed consumer, and documentation fixtures pass. The payload also omits the target shell dialect: Codex uses canonical tool name `Bash` on Windows, permits unified exec to select a shell or remote native environment, and strips that identity from hook input. The adapter therefore records `portable`, not POSIX, PowerShell, or the AgentHawk process platform. This means only the deliberately restricted cross-shell lexical grammar was applied; it is not proof of the target shell. Percent, caret, exclamation, and the existing composition, substitution, quoting, escaping, control, whitespace, and glob forms are rejected under this grammar.

## Decision

### Delivery boundary

Milestone 17 is split into independently reviewed slices:

1. this threat model and architecture decision;
2. strict vendor-neutral action/decision contracts and a pure command qualifier;
3. co-root repository authority plus an adapter-neutral, deadline-owned, bounded multi-package evaluation harness;
4. one Codex `PreToolUse` adapter for `Bash` fixtures and a real package-consumer harness;
5. separate Claude Code, Cursor, and GitHub Copilot adapters only after their exact contracts have independent fixtures and failure tests.

No native hook is installed or enabled by this research slice. Collision-safe `init` remains an advisory-template initializer. [ADR 0013](0013-codex-project-hook-ownership.md) now accepts a project-scoped, exclusive-ownership installation design; its implementation and exact-host activation evidence remain pending.

Cursor is a compatibility research target, not a promised adapter: its current documented pre-action output has no neutral/defer result. AgentHawk will not emit `permission: "allow"`. Cursor support remains unavailable unless a version-pinned real harness proves a true neutral result that preserves the ordinary host permission flow while `failClosed: true` still denies failures.

### Internal contracts and edge translation

Each vendor payload is untrusted and is parsed by a dedicated edge adapter. Raw vendor objects never enter the policy engine. The next implementation slice will define:

- a versioned, strict, bounded transient action envelope containing the adapter identity/version, declared deployment trust, validated repository root, contained action working directory, and only the bounded tool data needed for qualification;
- a versioned, strict, bounded decision envelope containing an outcome, verdict where applicable, stable reason code, bounded redacted message, and optional report digest;
- separate vendor serializers with golden fixtures. A serializer may emit a denial or a neutral result, but never a vendor auto-allow or tool-input rewrite.

Unknown schema versions, duplicate JSON keys, unknown security-sensitive fields, invalid UTF-8, trailing JSON values, malformed types, and over-limit input must fail closed while the adapter process is still able to respond. Vendor-specific optional fields are accepted only when explicitly modeled from a fixture-pinned documented contract. “Pinned” means reviewed documentation, fixtures, and real-harness compatibility; most host payloads do not provide an authenticated runtime version.

The initial proposed bounds to calibrate against captured vendor fixtures and boundary tests are:

- 64 KiB maximum stdin payload;
- 16 KiB maximum command string;
- 4,096 characters maximum working-directory string;
- 256 characters maximum adapter, event, tool, and invocation identifiers;
- 8 maximum package operands in one recognized add action;
- 8 KiB maximum serialized adapter output;
- an explicit 10-second host-hook timeout and an 8-second aggregate internal deadline, leaving time to serialize a denial.

The payload caps are starting compatibility/resource limits rather than ecosystem guarantees and may change before an adapter contract is published when real fixture evidence requires it. The shared operation context now propagates typed, redacted caller cancellation through Git, check orchestration, HTTP attempts and retry delay, npm/OSV pagination and hydration, and cache reads/writes. Parent cancellation is never retried or downgraded to a provider timeout, and concurrent scan/diff work settles before those commands return. Adapter support remains gated on the adapter-owned aggregate deadline, bounded multi-operand concurrency, the co-root authority prerequisite, and end-to-end proof that no tracked AgentHawk-owned operation remains after the decision. Remote provider processing after client cancellation and instantaneous operating-system I/O preemption are outside this boundary. These limits are not claims that every host will honor a denial if it terminates AgentHawk.

The co-root prerequisite is implemented as an internal, non-serialized authority loader. It accepts no configuration path overrides, requires an observed canonical action directory to equal the Git worktree root, and resolves only `.agenthawk.yml`, `.agenthawk/approvals.yml`, and `package.json` from that root. Present files retain bounded, strict, identity-fenced parsing; absent optional files are rechecked before defaults are consumed. Linked worktrees are independent roots. Nested action directories and observed symbolic aliases are conservatively rejected until workspace-aware admission. These portable observations reduce confused-root risk but do not authenticate PATH-selected Git or eliminate same-account filesystem races.

The adapter-neutral evaluation harness is implemented. The Codex compatibility-candidate edge owns the deadline: it creates the fixed eight-second deadline before reading or parsing input, passes that owned deadline to the harness, and disposes it only after output processing. The harness consumes the deadline and loads authority once, validates one to eight coordinates, deduplicates identical coordinates for provider and cache work, evaluates unique coordinates with two workers, restores original operand order, and combines verdicts through the existing deterministic precedence. Typosquatting context contains the root's direct dependencies and the other proposed operand names. First-cause cancellation is retained, unexpected failure aborts pending siblings, and all started workers settle before a denial returns. Warning has no silent proceed mapping: it denies as `warning_requires_review` until a vendor-specific visible neutral warning channel is proven.

### Repository identity and configuration authority

Vendor `cwd` is untrusted location input, not a repository-root assertion. For the first adapter, AgentHawk will:

1. require an existing absolute directory, canonicalize it, and for the initial slice require it to equal the discovered Git worktree root;
2. discover the containing Git worktree root with the PATH-selected local Git executable, fixed argument arrays, bounded fatal-UTF-8 output, and a sanitized case-insensitive `GIT_*` environment;
3. canonicalize the reported root and reject nested action directories until Milestone 18 defines workspace-aware manifest ownership;
4. resolve default `.agenthawk.yml`, `.agenthawk/approvals.yml`, and manifest context from that single root;
5. prohibit policy, approval, cache, manifest, and repository-root paths in vendor payloads; the first adapter accepts no host-configured path override.

The PATH-selected local Git executable is an explicit host trust dependency; sanitizing `GIT_*` variables does not authenticate it. Failure to establish one consistent root is a denial for a dependency-like action. Worktrees, nested manifests, `--prefix`, workspace targeting, Windows drive and case aliases, symbolic paths, junctions, and non-repository directories require adversarial tests. Co-rooted default policy/approval resolution is a named implementation prerequisite because current standalone CLI behavior is not yet uniform. Existing explicit CLI flags remain unchanged outside the hook adapter. The public metadata cache retains its existing provider-aware operating-system cache boundary; repository contents are not cached there.

### Conservative action qualification

Action qualification is separate from dependency evaluation. The initial recognized grammar is deliberately narrow:

- one direct `npm install`, `npm i`, or `npm add` command with one or more explicit package operands;
- one direct `pnpm add` command with one or more explicit package operands;
- a reviewed allowlist of flags whose operand semantics are covered by fixtures; workspace, prefix, and alternate-directory flags are denied in the initial slice.

Every extracted package operand is passed to the production npm-spec parser before provider access. The qualifier never uses substring matching as evidence that a command was analyzed.

The following classifications are distinct:

- `unrelated`: a lexically simple command with no manager-like token, recognized wrapper, interpreter, assignment, reserved shell form, composition, substitution, quoting, escaping, or glob syntax; it produces a neutral result and zero policy, cache, or provider calls;
- `dependency_add`: evaluate every bounded package coordinate and combine verdicts deterministically;
- `ephemeral_execution`: deny in the first slice pending separate `npx`, `npm exec`, and `pnpm dlx` policy semantics;
- `install_like_unsupported`: deny with a stable reason when wrappers, shell composition, unknown flags, workspace ambiguity, or unsupported package-manager grammar prevent exact qualification;
- `invalid`: deny malformed or over-limit action input.

No-operand install/restore commands are not dependency-add admissions. The qualifier does not parse arbitrary shell programs: a manager-like token anywhere outside the exact direct grammar, recognized wrappers/interpreters, and any shell composition, substitution, quoting, escaping, assignment, reserved form, or glob syntax are conservatively unsupported even when the text might merely mention a manager. This intentional false-positive boundary prevents unknown direct launchers or syntax it does not understand from becoming neutral. Unknown aliases, functions, scripts, child processes, build tools, or manually opened terminals that expose no manager-like token can still conceal package-manager execution and remain residual bypasses. Manifest edits remain covered by post-edit `scan`/`diff` and protected CI; a post-edit check is not described as pre-action prevention.

### Decision mapping and host authority

AgentHawk never grants tool permission:

- AgentHawk `allow` produces a neutral vendor result, preserving the host's ordinary permission and sandbox flow.
- AgentHawk `warn` may produce a neutral result only when the specific vendor harness proves a bounded warning channel that does not grant permission or rewrite input. If no such channel exists, warn is denied as `warning_requires_review`; it never proceeds silently.
- `review`, `block`, evaluation `error`, malformed input, unsupported dependency-like actions, internal deadline expiry, missing required evidence, and untrusted cache-only evidence produce a vendor denial.
- vendor input-rewrite features are not used.

If multiple package operands are present, the existing deterministic verdict precedence is applied across all reports. An approval retains its current exact-coordinate semantics and cannot override blocks, errors, or non-approvable review findings.

### Failure and timeout model

The shared cancellation substrate and adapter-neutral aggregate harness are implemented: caller cancellation has a fixed AgentHawk-owned error identity, arbitrary host abort reasons are not exposed, provider-local timeouts remain distinct, retry timers are cancelled, response bodies are cancelled on rejection, cache temporary files are cleaned before cancellation escapes, Git receives the same signal, and started scan/diff/action-evaluation siblings settle before return. The adapter edge owns one fixed eight-second deadline; the harness consumes it for bounded multi-operand evaluation without `Promise.race`. Before adapter support ships, each adapter edge must create the deadline before input evaluation, dispose it after emitting exactly one bounded decision, and prove that no AgentHawk-owned request task, Git child, retry timer, cache write, or result consumer remains active after returning. Missing binaries, root-discovery failure, malformed provider output, provider timeout, cache authentication limits, serializer failure, or unexpected exceptions must never become an AgentHawk proceed result.

Every adapter also requires an outermost emergency denial path independent of its normal schema serializer. If parsing, evaluation, or serialization throws, it writes only one fixed bounded redacted message directly to stderr and exits `2`; Codex, Claude Code, and Cursor document exit `2` as blocking for the selected pre-action events, and Copilot's command `preToolUse` treats non-timeout nonzero exit as denial. Injected serializer-failure fixtures must prove this path. A process that cannot start and a host that kills it at timeout remain external fail-open risks where documented.

That behavior does not make every platform fail closed. Codex does not document a fail-closed timeout guarantee; Claude Code command-hook timeouts proceed through normal permissions; Cursor requires `failClosed: true`; GitHub Copilot timeouts are explicitly fail-open. Protected CI therefore remains the final repository boundary, and documentation must state the tested host/version/surface for every adapter.

Copilot cloud provider reachability is not assumed. Its default firewall permits GitHub/Copilot hosts rather than arbitrary npm registry or OSV endpoints; a missing independently administered and tested outbound allowance makes required evidence unavailable and therefore denies. The cloud agent is non-interactive, its tool permissions are pre-granted, and hook notifications are not surfaced to a user, so `warn` must deny there unless a future tested neutral channel visibly reaches an authorized reviewer.

### Deployment trust

The decision records one bounded declaration: `project`, `user`, `managed`, or `unknown`. It describes where configuration was intended to be deployed; it is not proof of immutability. Host pre-tool payloads generally do not authenticate the configuration source, so this value must come from trusted adapter launch configuration and defaults to `unknown`; it is never inferred from payload paths, environment values, or a cloud/local guess.

- `project`: cooperative defense in depth; anyone able to change repository configuration may weaken or remove it.
- `user`: local guardrail controlled and disableable by that user.
- `managed`: stronger administrative deployment, still limited by host coverage, local binary integrity, and timeout behavior.
- `unknown`: no stronger claim is made.

Repository and cloud-repository sources map to `project`; administrator policy/enterprise sources map to `managed` only when the trusted launch configuration declares that deployment; user-owned sources may map to `user`. Session, plugin, local, inline, mixed, or unavailable source authority maps to `unknown` unless a separately reviewed installer establishes a stronger origin. Cloud repository hooks are never reclassified as administrator-managed merely because they run on hosted infrastructure. AgentHawk does not read transcripts, prompts, user email, cloud tokens, registry credentials, or arbitrary environment values to infer trust.

### Output and privacy

Default hook output contains no raw command, prompt, environment value, transcript path, absolute repository path, provider body, registry credential, stack trace, or existing file content. Raw commands are transient qualification input only and are excluded from reports, evidence digests, logs, and reasons. Human-facing reason text uses fixed redacted messages with control-character escaping.

The adapter executes no package manager and does not construct a shell command. In-process evaluation reuses the existing npm parser, providers, policy engine, approvals, cache, verdict precedence, schemas, and redaction. Any child process required for Git root discovery uses a fixed executable, argument array, timeout, output cap, and sanitized environment.

## Alternatives

- Relying only on instruction templates was rejected because a manipulated agent can ignore prose.
- Treating all vendor hooks as one schema was rejected because their payloads and failure semantics differ.
- Returning vendor `allow` for AgentHawk `allow` was rejected because dependency admission must not bypass host permissions.
- Parsing arbitrary shell languages or executing a shell parser was rejected because complete cross-platform shell semantics are outside the dependency-admission scope.
- Allowing ambiguous install-like commands was rejected because uncertainty at the protected boundary must remain visible.
- Installing hooks through the existing `init` command was rejected until configuration ownership, collision, uninstall, and recovery semantics receive a separate review.
- Hosted evaluation and LLM hook modes were rejected as security authorities to preserve local-first deterministic decisions.

## Security implications

The design can deny recognized dependency-add tool calls that reach an enabled supported hook. It does not intercept every dependency addition, protect against an actor who can change the hook or binary, cover manual terminal commands, see package-manager calls hidden behind wrappers or child processes, or turn a fail-open host timeout into a fail-closed boundary.

The bypass corpus must include shell chaining, newlines, pipes, redirection, substitutions, nested shells, environment assignments, `env`, `sudo`, `command`, Corepack, path-qualified executables, Windows suffixes, mixed case, Unicode controls and whitespace, package-manager aliases, `--`, scripts, no-operand installs, workspace flags, non-registry specs, and multiple packages. Unsupported shapes deny without provider access; unrelated commands remain neutral without provider access.

## Rollback and recovery

A broken fail-closed hook can prevent normal host tool use. Recovery is therefore a human-controlled deployment operation, not an AgentHawk self-repair path:

1. disable or remove the exact host hook entry at the authority where it was installed;
2. confirm the host no longer invokes that entry;
3. pin or reinstall the previously reviewed AgentHawk package version;
4. re-enable a hook only after its packed-consumer and real-host deny/neutral harness passes.

AgentHawk must not automatically overwrite, merge, disable, remove, or reinstall foreign host hook configuration. Every supported adapter needs host-specific configuration and recovery locations, ownership expectations, and a test proving package-consumer failure leaves no hook enabled. [ADR 0013](0013-codex-project-hook-ownership.md) defines that boundary for an exclusively owned Codex project hook; installation remains outside `agenthawk init`, and implementation is still pending.

## Consequences

The Codex compatibility candidate has pinned payload fixtures, golden neutral/deny output, process failure and timeout tests, a no-provider unrelated test, and packed-package consumer verification. A development-only real-host harness now verifies an explicitly supplied `0.149.0` executable against a temporary `CODEX_HOME`, temporary user hook, temporary Git root, fake package manager, and loopback-only Responses fixture. It pins Windows to the documented default `shell_command` surface and other platforms to explicitly enabled unified exec; it never switches silently when the expected tool is absent. It does not use account authentication, a remote model, user configuration, persisted hook trust, package installation, or an approvals/sandbox bypass.

The first named run used the official `@openai/codex@0.149.0` Windows x64 npm artifact on 2026-08-23. The denial hook path passed and the fake package-manager marker remained absent, but the neutral command was rejected by policy. Exact tagged-source review showed that the temporary configuration had omitted `windows.sandbox`; v0.149.0 therefore disabled the Windows sandbox backend, downgraded `workspace-write`, and conservatively required approval for unmatched commands. Because the harness deliberately sets `approval_policy = "never"`, Codex rejected the command before process creation. The cached PowerShell wrapper path in the message was incidental and did not establish a runtime launch failure.

The corrected named run explicitly selected the documented `windows.sandbox = "unelevated"` fallback while retaining `workspace-write`, `approval_policy = "never"`, and the normal host permission flow. The harness also disables sandbox network access and excludes environment and slash temporary directories from implicit writable roots, so the sibling temporary `CODEX_HOME` is not writable by the tool process. It passed: the neutral PowerShell command created the exact expected marker inside the temporary repository, the denial reached Codex, and the fake package manager did not execute. Unelevated mode uses a restricted current-user token and ACL boundaries and is weaker than the preferred provisioned elevated sandbox. This result establishes only the local Windows CLI surface for exact version `0.149.0` under that configuration. The adapter remains unsupported because desktop, IDE, remote, cloud, elevated-sandbox, managed-requirements, and other-version behavior is not established.

Maintainers can repeat the development check after building both workspaces. The argument must name an absolute JavaScript entry or native executable that reports exactly `codex-cli 0.149.0`; the harness never downloads Codex itself:

```text
pnpm verify:codex-host --codex-entry <absolute-path-to-reviewed-codex-entry>
```

Success emits one bounded JSON object containing only the version, named surface, two pass states, and isolation mode. Failure emits one fixed category line and no captured host output, request body, command, path, environment, prompt, transcript, or identifier. The command is intentionally excluded from CI because acquiring and executing a vendor host artifact is a separate reviewed compatibility operation, not an offline unit test.

Support is granted per exact named surface, version, operating system, sandbox configuration, and deployment authority; evidence from one row never unlocks another. A local CLI support claim therefore does not wait on undocumented cloud behavior, but it also cannot be generalized to app-server, SDK, IDE, desktop, Remote, cloud, managed requirements, another operating system, or another version. The project-hook ownership design is accepted in [ADR 0013](0013-codex-project-hook-ownership.md), but the candidate remains unsupported until its installer, recovery paths, manual activation boundary, and exact project-hook harness pass. Its `portable` qualifier makes no target-shell claim and intentionally rejects shell-specific syntax; unknown shell constructs can still conceal dependency operations and remain a residual bypass. Each later adapter and surface requires equivalent independent evidence. A vendor without a proven neutral no-auto-approve result remains unsupported; a cloud surface without required provider reachability or a visible warning channel must deny rather than silently degrade.

The next named attempt used the official `@openai/codex@0.149.0-linux-x64` artifact (registry integrity `sha512-uZXaN9JPxu0/jjnqqJeTd4kRYPnjVZK3MiVndfG1mHhEaoDKL7ScWHfPqvAEOjwsSDEmQSlMfUkmvYp/CHciYw==`) inside `node:22-bookworm` image digest `sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a` on Docker Desktop's Linux engine. The harness reached the loopback fixture, but Codex's bundled `bwrap` could not create its namespace under the container boundary, so the neutral repository marker was absent and the harness failed closed. AgentHawk did not retry with a privileged container, `CAP_SYS_ADMIN`, disabled seccomp, danger-full-access, or an external-sandbox bypass. This is an environment limitation, not Linux compatibility evidence. A Linux claim still requires the same exact run on a host that supports Codex's intended sandbox without weakening it.

The hardened harness now names Windows, Linux, and macOS CLI surfaces separately, rejects other platform values, and requires an exact regular repository-local neutral marker on every platform. The next independently reproducible surface is exact-version local app-server over stdio using the same isolated loopback provider. Passing app-server will establish only that protocol host; it will not establish the VS Code extension, desktop app, Remote product, or Codex cloud.

The exact-version local app-server stdio slice passed on Windows with the official `@openai/codex@0.149.0` artifact. Its bounded JSONL client omits JSON-RPC decoration as required by the pinned protocol, rejects malformed UTF-8, duplicate/trailing JSON through the production strict parser, oversized output, unknown or duplicate response identifiers, server requests, approval requests, and unfinished process cleanup. Each neutral and denial scenario uses a fresh temporary `CODEX_HOME`, Git root, process, and loopback provider. The harness inventories exactly one temporary user `PreToolUse` command hook, writes trust only for that hook's listed key and current hash through `config/batchWrite`, verifies the resulting trusted hash, starts an ephemeral `workspace-write`/`approvalPolicy: never` thread, and binds the matching `hook/started`, `hook/completed`, and `turn/completed` notifications. It does not use the broadly trusting session flag or the unsandboxed `thread/shellCommand`, `command/exec`, or `process/*` methods. The named `local-app-server-windows-stdio-shell-command` surface passed independent neutral regular-file evidence and blocked-hook plus absent-denial-marker evidence. This protocol result is not evidence for VS Code, desktop, Remote, cloud, managed requirements, Linux, macOS, or another version. [ADR 0013](0013-codex-project-hook-ownership.md) accepts the ownership design; no adapter is supported until its installation, removal, recovery, and project-hook activation paths are implemented and tested.

Adapter claims are version- and surface-specific. Documentation must prefer: “AgentHawk can deny recognized dependency-add shell tool calls that reach a supported, enabled, synchronous vendor hook; deployment trust and documented bypasses determine the strength of that guardrail.”
