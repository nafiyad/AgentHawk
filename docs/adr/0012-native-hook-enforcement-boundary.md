# ADR 0012: Native hook enforcement boundary

## Status

Accepted.

## Context

AgentHawk's repository instructions are advisory. Current coding-agent platforms expose synchronous pre-tool hooks that can deny some shell tool calls before execution, but their payloads, configuration ownership, tool coverage, failure behavior, and cloud support differ. Treating those hooks as one uniform enforcement API would create false security claims.

The first native integration must protect the existing npm dependency-admission boundary without turning AgentHawk into an arbitrary shell parser, granting tool permission on the user's behalf, leaking command text, or weakening the independent `scan`, `diff`, and protected-CI controls.

Research for this decision used current primary vendor documentation, accessed 2026-08-21:

- [OpenAI Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Anthropic Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [GitHub Copilot hooks overview](https://docs.github.com/en/copilot/concepts/agents/hooks)
- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)

The documented contracts are materially different:

| Platform | Pre-action and decision contract | Configuration authority and disabling | Execution, precedence, timeout, and cloud limits | Harness status |
| --- | --- | --- | --- | --- |
| Codex | `PreToolUse` receives `Bash` and other supported local tool calls; structured `permissionDecision: "deny"` or exit `2` denies | user, project, session, plugin, and managed sources; non-managed command hooks require trust review; managed configuration can require managed hooks only | matching command hooks launch concurrently; invalid/unsupported output can continue; specialized paths may bypass hooks; default command timeout is 600 seconds and no fail-closed timeout guarantee is documented; no cloud support claim is made here | documentation fixture only; no supported AgentHawk adapter/version yet |
| Claude Code | `PreToolUse` receives `Bash` and `PowerShell`; structured deny or exit `2` denies | user, project, local, plugin, and managed sources; managed settings can restrict hooks; interactive project trust does not generalize to `-p`/SDK sessions | matching hooks can run in parallel and deny takes precedence; ordinary command-hook errors and timeouts are non-blocking; default command timeout is 600 seconds; commands run with user permissions and inherit the parent environment except documented removals | documentation fixture only; no supported AgentHawk adapter/version yet |
| Cursor | prefer narrow `beforeShellExecution`, with broader `preToolUse` evaluated separately; structured deny or exit `2` denies; the current contract documents permission decisions but no neutral/defer result | project, user, system/MDM, team, and enterprise cloud sources; enterprise has higher source priority and hooks are merged | failures are fail-open unless `failClosed: true`; under fail-closed configuration an empty/invalid response cannot be assumed neutral; cloud loads project/team/enterprise command hooks but not user hooks, and early read-only cloud turns do not run hooks; inputs/environment can expose workspace, transcript, session, and user data | unsupported under the no-auto-approve invariant unless a version-pinned real harness proves a true neutral result that preserves host permission flow |
| GitHub Copilot | `preToolUse` has distinct camelCase CLI/cloud and PascalCase compatibility payload forms; structured deny controls the call | CLI can combine machine policy, repository, user, inline, and plugin hooks; policy hooks require administrator installation and cannot be disabled normally; cloud has repository hooks only | matching hooks run in order and any deny wins; command-hook nonzero failures deny for this event, but timeouts are always fail-open, including policy hooks; default timeout is 30 seconds; cloud is non-interactive with pre-granted tool permissions and no user-visible notifications; outbound access is restricted to GitHub/Copilot hosts by default and other hosts require administrator firewall allowance; hook processes can receive Copilot API/Git credentials and prompt data that AgentHawk must ignore | documentation fixture only; no supported AgentHawk adapter/version yet |

Hook execution can also expose session identifiers, working directories, transcript paths, prompts, tool arguments, environment variables, user identity, or cloud credentials. AgentHawk needs only the event, tool name, bounded command, and working directory. It must not inspect, persist, hash, or render unrelated fields.

## Decision

### Delivery boundary

Milestone 17 is split into independently reviewed slices:

1. this threat model and architecture decision;
2. strict vendor-neutral action/decision contracts and a pure command qualifier;
3. one Codex `PreToolUse` adapter for `Bash` fixtures and a real package-consumer harness;
4. separate Claude Code, Cursor, and GitHub Copilot adapters only after their exact contracts have independent fixtures and failure tests.

No native hook is installed or enabled by this research slice. Collision-safe `init` remains an advisory-template initializer. Automatic hook installation, modification, removal, or merging requires a separate filesystem and ownership decision.

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

The payload caps are starting compatibility/resource limits rather than ecosystem guarantees and may change before an adapter contract is published when real fixture evidence requires it. The time and operand combination is not implementable with the current uncancelable orchestration: adapter support is gated on one propagated abort/deadline across Git discovery, check orchestration, HTTP attempts, retry delay, OSV pagination/hydration, bounded aggregate concurrency, and cache writes. Tests must prove no AgentHawk-owned request task, retry timer, Git child, cache write, or result consumption remains after a decision. Remote provider processing after client cancellation is outside this boundary. These limits are not claims that every host will honor a denial if it terminates AgentHawk.

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

- `unrelated`: a lexically simple non-manager command with no recognized wrapper, interpreter, assignment, reserved shell form, composition, substitution, quoting, escaping, or glob syntax; it produces a neutral result and zero policy, cache, or provider calls;
- `dependency_add`: evaluate every bounded package coordinate and combine verdicts deterministically;
- `ephemeral_execution`: deny in the first slice pending separate `npx`, `npm exec`, and `pnpm dlx` policy semantics;
- `install_like_unsupported`: deny with a stable reason when wrappers, shell composition, unknown flags, workspace ambiguity, or unsupported package-manager grammar prevent exact qualification;
- `invalid`: deny malformed or over-limit action input.

No-operand install/restore commands are not dependency-add admissions. The qualifier does not parse arbitrary shell programs: recognized wrappers/interpreters and any shell composition, substitution, quoting, escaping, assignment, reserved form, or glob syntax are conservatively unsupported even when the text might be benign. This intentional false-positive boundary prevents syntax it does not understand from becoming neutral. Unknown aliases, functions, scripts, child processes, build tools, or manually opened terminals can still conceal package-manager execution and remain residual bypasses. Manifest edits remain covered by post-edit `scan`/`diff` and protected CI; a post-edit check is not described as pre-action prevention.

### Decision mapping and host authority

AgentHawk never grants tool permission:

- AgentHawk `allow` produces a neutral vendor result, preserving the host's ordinary permission and sandbox flow.
- AgentHawk `warn` may produce a neutral result only when the specific vendor harness proves a bounded warning channel that does not grant permission or rewrite input. If no such channel exists, warn is denied as `warning_requires_review`; it never proceeds silently.
- `review`, `block`, evaluation `error`, malformed input, unsupported dependency-like actions, internal deadline expiry, missing required evidence, and untrusted cache-only evidence produce a vendor denial.
- vendor input-rewrite features are not used.

If multiple package operands are present, the existing deterministic verdict precedence is applied across all reports. An approval retains its current exact-coordinate semantics and cannot override blocks, errors, or non-approvable review findings.

### Failure and timeout model

Before adapter support ships, AgentHawk must propagate one abort/deadline through every asynchronous operation, reserve time to emit exactly one bounded decision object, and prove that no AgentHawk-owned request task, Git child, retry timer, cache write, or result consumer remains active after returning. A `Promise.race` without cancellation is prohibited. Missing binaries, root-discovery failure, malformed provider output, provider timeout, cache authentication limits, serializer failure, or unexpected exceptions must never become an AgentHawk proceed result.

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

AgentHawk must not automatically overwrite, merge, disable, remove, or reinstall host hook configuration. Every supported adapter needs host-specific configuration and recovery locations, ownership expectations, and a test proving package-consumer failure leaves no hook enabled. Hook installation remains outside `agenthawk init` until a separate destructive filesystem and configuration-ownership decision is accepted.

## Consequences

Milestone 17 needs contract and qualifier code before a vendor adapter. Each adapter requires pinned payload fixtures, golden neutral/deny output, process failure and timeout observations, no-provider unrelated tests, packed-package consumer tests, and Windows/macOS/Linux coverage where the host exists. A vendor without a proven neutral no-auto-approve result remains unsupported; a cloud surface without required provider reachability or a visible warning channel must deny rather than silently degrade.

Adapter claims are version- and surface-specific. Documentation must prefer: “AgentHawk can deny recognized dependency-add shell tool calls that reach a supported, enabled, synchronous vendor hook; deployment trust and documented bypasses determine the strength of that guardrail.”
