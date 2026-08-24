# ADR 0013: Codex project-hook ownership

## Status

Accepted.

## Context

The release-pinned Codex `0.149.0` compatibility candidate can return a neutral
`PreToolUse` result or deny a recognized dependency-add command. It is not yet
safe to install that hook. A setup command must not overwrite another tool's
configuration, silently combine security decisions, claim that an untrusted
project hook is active, or leave an unrecorded hook enabled after interruption.

This decision uses public primary sources, accessed 2026-08-24:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) documents user, project,
  session, plugin, and managed hook sources; project-hook trust; additive hook
  loading; command-hook timeouts; and exact-definition review for non-managed
  hooks.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
  documents user configuration at `~/.codex/config.toml`, project configuration
  under `.codex/`, trusted-project gating, the hooks feature switch, and managed
  requirements such as `allow_managed_hooks_only`.
- The pinned [`rust-v0.149.0` hook discovery implementation](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/hooks/src/engine/discovery.rs)
  and [configuration rules](https://github.com/openai/codex/tree/rust-v0.149.0/codex-rs/hooks/src)
  were reviewed at commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`
  to bound the compatibility candidate. Source review informs exact-version
  tests; it does not replace the public contract or prove another host version.

Codex combines matching hooks from multiple sources. A higher-precedence source
does not replace a lower-precedence hook, and project `hooks.json` can coexist
with inline project hooks. A syntactically correct AgentHawk entry therefore
does not prove that it is the only decision maker. Non-managed command hooks
also require the user to review and trust their exact current definition.
AgentHawk must not write Codex's trust store or convert project-controlled
configuration into a claimed administrator boundary.

## Decision

### Scope and command surface

The first installation surface is an explicitly requested, machine-local Codex
project hook at one canonical Git worktree root. It will be exposed through
separate commands:

```text
agenthawk integrations codex status
agenthawk integrations codex install
agenthawk integrations codex remove
```

It is not part of `agenthawk init`. Every command must establish the same exact
canonical root through the existing repository-authority loader. Nested action
directories, path overrides, user-home installation, `CODEX_HOME` mutation,
plugins, session hooks, managed requirements, trust-store writes, and Git
ignore changes are outside this decision.

The installer owns only these fixed targets:

```text
<root>/.codex/hooks.json
<root>/.agenthawk/integrations/codex-v1.json
<root>/.agenthawk-codex-integration.lock
<root>/.agenthawk-codex-integration-<random-id>/
```

The lock and staging directory are temporary. Implementations must reject
symbolic links, junctions/reparse-point aliases, non-regular files, unexpected
parents, identity changes, and paths outside the established root. Cleanup and
rollback are fixed-target and non-recursive.

The generated `hooks.json` contains exactly one synchronous `PreToolUse` command
hook matching `Bash`, with a ten-second host timeout and a visible status
message. Its command uses the canonical absolute current Node executable and
the canonical absolute packaged `codex-pretooluse-entry.js` sibling, with
platform-correct quoting and a trusted fixed launch argument declaring
`deploymentTrust=project`. It must not use `PATH`, `npx`, a package-manager
launcher, shell substitution, or repository-provided executable code. The hook
remains machine-local and is not a portable configuration to commit.

An absolute command reduces executable-name hijacking but does not make the
Node runtime, installed package, or same-account filesystem immutable. Status
must revalidate the command and packaged adapter identities instead of assuming
that an old receipt still describes current bytes.

### Exclusive ownership and collision policy

AgentHawk owns a project hook only when both its strict receipt and exact hook
file validate as one installation. Similar bytes without the receipt are
unowned. A receipt without the hook is inactive recovery state, not an
installation. The receipt is a closed, versioned JSON object containing a
random installation identifier, the adapter/package version, and digests for
the expected hook definition, launch arguments, and packaged adapter. It stores
no raw repository path, user name, environment value, command text observed
from an agent, credential, or trust-state assertion.

Installation refuses rather than merges, adopts, repairs, or overwrites when:

- `.codex/hooks.json` already exists;
- `.codex/config.toml` exists, because this first slice does not parse and prove
  the absence of additive inline hooks;
- the receipt path already contains unrecognized, malformed, or mismatched
  state;
- either parent is not an expected contained directory;
- any fixed target is linked, aliased, changes identity during the operation,
  or has an unsupported type; or
- another operation owns the exclusive lock.

This intentionally rejects some repositories with unrelated Codex settings.
A later ADR may introduce a bounded duplicate-rejecting TOML/JSON merge model,
but no `--force`, adoption-by-byte-equality, or best-effort merge is permitted
by this decision.

### State model

`status` classifies observed state without mutating it:

| State | Meaning | Safe next operation |
| --- | --- | --- |
| `absent` | Neither owned receipt nor hook exists | `install` |
| `recorded_inactive` | A valid receipt exists and the hook is absent | `remove`, then a fresh `install` |
| `installed` | Receipt and hook exactly match current expected identities | `remove` |
| `unowned_hook` | A hook exists without the matching receipt | Human review; AgentHawk does not modify it |
| `record_collision` | The receipt path exists but is not a valid owned record | Human review; AgentHawk does not modify it |
| `drifted` | A formerly paired record and hook no longer match | Human review; no automatic repair or removal |
| `mixed_configuration` | Project TOML and/or another representation prevents exclusive reasoning | Human review; AgentHawk does not install |
| `operation_locked` | Another operation or an abandoned fixed lock prevents exclusive mutation | Wait for the owner or manually inspect the fixed lock; no automatic break |

The first implementation does not guess that a lock is stale or break it by
process identifier or elapsed time; both checks are vulnerable to reuse and
clock/race ambiguity. An abandoned lock is a visible, fixed-file recovery task.
Output uses these bounded categories and remediation text. It does not reveal
absolute paths, installation identifiers, raw file contents, hook hashes, or
adapter hashes. `installed` means only that AgentHawk's declaration is intact at
the instant checked. It does not mean Codex loaded, trusted, enabled, or could
execute the hook.

### Transaction and recovery ordering

The implementation must acquire a fixed exclusive lock, re-establish root and
target identities, construct bounded files in its exclusive staging directory,
and validate the staged bytes before publication. Publication uses same-volume
no-replace operations whose behavior is proven on supported local filesystems;
an existence check followed by an overwriting rename is insufficient.

Installation publishes the receipt first and the hook second. Interruption can
therefore leave `recorded_inactive`, but must never leave an enabled-looking
AgentHawk hook without its ownership record. If hook publication fails, the
command may remove only the still-identical receipt it just created; otherwise
it reports recovery state and leaves the evidence intact.

Removal deletes the still-identical hook first and the still-identical receipt
second. Interruption can again leave only `recorded_inactive`. It must not
remove a changed hook, an unowned hook, an unknown receipt, `.codex` itself, or
unrelated files. Errors and cancellation release the lock and remove only the
operation's verified staging files. Recovery never scans or recursively deletes
the repository.

### Activation and support claims

After installation, the user must trust the project and review the exact hook
definition through Codex's own hook UI. AgentHawk does not click approval,
write hook trust, or infer trust from a successful file write. Codex may still
skip or reject the hook when the hooks feature is disabled, managed requirements
allow only managed hooks, the runtime moved, the package changed, the project
is untrusted, a specialized execution path bypasses hooks, or a host timeout or
startup failure occurs.

The implementation is not complete until an isolated exact-version project-hook
harness proves these states: installed but untrusted, manually trusted exact
definition, neutral command, denied dependency add with no fake-package-manager
marker, definition mutation becoming untrusted/drifted, disabled hooks, and
managed-only rejection. The harness must use temporary roots and configuration;
it must never modify the maintainer's real Codex home or trust state.

No Codex native adapter becomes supported merely because this ADR is accepted
or the files can be installed. Support remains gated on collision, cancellation,
recovery, packed-consumer, exact-host activation, and removal tests plus the
surface/version limits in [ADR 0012](0012-native-hook-enforcement-boundary.md).

## Alternatives

- Editing existing `hooks.json` or `config.toml` was rejected because additive
  configuration, ordering, duplicate keys, foreign ownership, and rollback
  cannot be represented safely by a simple text patch.
- User, managed, plugin, and session installation were deferred because they
  have different authority, lifecycle, and recovery boundaries.
- Automatically trusting the generated hook was rejected because review of the
  exact non-managed command belongs to Codex and the user.
- A `PATH` command, `npx`, or package-manager launcher was rejected because a
  different executable could be selected before AgentHawk evaluates an action.
- A portable committed hook was deferred because this decision binds one local
  runtime and installed adapter artifact and intentionally stores no portable
  repository command.
- Extending `agenthawk init` was rejected because advisory template setup and a
  native executable security hook have different failure and recovery impact.

## Security implications

The receipt and ordering make accidental collision, partial installation, and
safe removal auditable. They do not protect against an actor with permission to
rewrite the repository, receipt, installed package, Node runtime, Codex
configuration, or process environment. Project deployment is cooperative
defense in depth. Protected `scan`/`diff` CI remains the final repository gate.

The no-merge rule can create false-negative usability: a repository with any
project TOML cannot use this first installer even when its settings are benign.
That is an explicit fail-safe compatibility limit, not evidence that the
existing configuration is dangerous.

## Consequences

The next implementation slice can add only project-scoped `status`, `install`,
and `remove`, the strict receipt, transactional filesystem helpers, and the
exact project-hook host harness. It must add adversarial tests for collisions,
links and reparse points, identity races, cancellation at every publication
boundary, stale locks, changed artifacts, interrupted install/removal, hostile
file contents, and bounded redacted output on Windows, Linux, and macOS where
the local-filesystem primitives are claimed.

User/managed/plugin installation, portable committed configuration, trust
automation, merge/adopt/force/repair/upgrade operations, arbitrary paths,
workspace-root inference, other Codex versions/surfaces, and other vendors stay
deferred.
