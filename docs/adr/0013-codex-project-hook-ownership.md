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
- The same pinned loader [redirects linked-worktree hook declarations to the
  root checkout](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/config/src/loader/mod.rs#L1083-L1093)
  and [replaces worktree-local hooks with that root-checkout source](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/config/src/loader/mod.rs#L1590-L1613).

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

The first installer also rejects linked Git worktrees. AgentHawk correctly
treats each linked worktree as an independent repository authority, but Codex
`0.149.0` deliberately loads its project hooks from the root checkout instead.
Writing the linked worktree's `.codex/hooks.json` would therefore create an
apparently owned but inactive control. A later design may coordinate root
checkout ownership; this version must detect and fail before any mutation.

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

Existing `.codex`, `.agenthawk`, and `.agenthawk/integrations` directories may
contain unrelated entries and are never owned as a whole. When one is absent,
the installer creates only that fixed directory with exclusive no-replace
semantics, immediately records and rechecks its canonical containment and file
identity, and retains it even if the operation later fails. Existing parents
must be real contained directories with stable identities; a file, link,
reparse point, case/Unicode alias, or identity swap fails closed. AgentHawk
never removes these parent directories or any unrelated child.

The exclusive staging directory contains exactly two bounded regular files,
`codex-v1.json` and `hooks.json`, plus no user-controlled names. Its 256-bit
operation identifier comes from the operating system CSPRNG and is encoded as
exactly 64 lowercase hexadecimal characters. The lock is an exclusively
created bounded regular file containing that operation identifier and a closed
schema version. Neither identifier is a credential or authority proof.

The generated `hooks.json` contains exactly one synchronous `PreToolUse` command
hook matching `Bash`, with a ten-second host timeout and a visible status
message. Its command uses the canonical absolute current Node executable and
the canonical absolute packaged `codex-pretooluse-entry.js` sibling, with
platform-correct quoting and trusted fixed launch arguments declaring
`deploymentTrust=project`, the installation identifier, and the root binding.
The installation identifier is 256 CSPRNG bits encoded as exactly 64 lowercase
hexadecimal characters. Both identifiers must reject mixed case, prefixes,
padding, separators, and all other lengths or alphabets.

The root binding is lowercase hexadecimal SHA-256 over one canonical binary
sequence. It starts with ASCII `AgentHawk Codex root binding v1` followed by one
zero byte. Each remaining field is encoded as an unsigned 64-bit big-endian byte
length followed by its bytes, in this exact order: the raw 32 installation-ID
bytes; the canonical-root UTF-8 bytes; canonical ASCII decimal `dev`; and
canonical ASCII decimal `ino`. Decimal zero is `0`; other values have no sign or
leading zero. Invalid UTF-8, lengths outside the implementation bounds,
`dev < 0`, or `ino <= 0` fail closed. The implementation must include a fixed
known-vector test for this serialization and digest.

The installation identifier and root binding appear in both the generated hook
and receipt. At invocation, the adapter re-establishes repository authority and
must match the recomputed binding and paired receipt before evaluation; a copied
pair therefore fails in a different root. The binding exposes no raw path and
is not authentication against a same-account writer.

The command must not use `PATH`, `npx`, a package-manager launcher, shell
substitution, or repository-provided executable code. The hook remains
machine-local and is not a portable configuration to commit.

An absolute command reduces executable-name hijacking but does not make the
Node runtime, installed package, or same-account filesystem immutable. The
receipt records the generated launch-argument digest, packaged-adapter byte
digest, and generating Node version, but not a Node-executable byte digest.
Readiness compares the literal absolute executable path with the current
canonical `process.execPath`, the recorded/current Node version, and the adapter
bytes. It does not detect replacement of Node bytes at the same path and version
and must not claim that it does.

### Exclusive ownership and collision policy

AgentHawk owns a project hook only when both its strict receipt and exact hook
file validate as one root-bound installation. Similar bytes without the receipt
are unowned. A receipt without the hook is inactive recovery state, not an
installation. The receipt is a closed, versioned JSON object containing the
installation identifier, root binding, adapter/package and Node versions, and
digests for the published hook bytes, normalized hook definition, launch
arguments, and packaged adapter. It stores no raw repository path, user name,
environment value, command text observed from an agent, credential, or
trust-state assertion.

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

`status` classifies observed state without mutating it. Classification first
rejects an unsafe or unstable target, then computes exactly one ownership state
from receipt and hook bytes, and finally reports independent readiness and
mutation blockers. `config.toml` and an operation lock are blockers, not
ownership states, so they cannot hide a removable owned pair.

The ownership precedence is exact: unsafe observation produces `unsafe`; an
absent receipt produces `absent` or `unowned_hook` according to hook absence; a
present receipt that fails its closed schema, root binding, or fixed-target
checks produces `record_collision`; a valid receipt with no hook produces
`owned_inactive`; a valid receipt with its exact recorded hook bytes produces
`owned_exact`; and any other present hook paired with a valid receipt produces
`owned_modified`.

Because canonical root bytes participate in the binding, moving or renaming a
repository invalidates the old receipt even when its filesystem identity is
unchanged. The old pair becomes `record_collision`, is not invoked by
AgentHawk, and requires human review/removal; automatic rebinding or deletion
would be implicit adoption and is outside this decision.

| State | Meaning | Safe next operation |
| --- | --- | --- |
| `absent` | Neither owned receipt nor hook exists | `install` |
| `owned_inactive` | A valid root-bound receipt exists and the hook is absent | `remove`, then a fresh `install` |
| `owned_exact` | Receipt and hook are the exact root-bound pair originally published, independent of current runtime/package readiness | `remove` |
| `unowned_hook` | A hook exists without the matching receipt | Human review; AgentHawk does not modify it |
| `record_collision` | The receipt path exists but is not a valid owned record | Human review; AgentHawk does not modify it |
| `owned_modified` | A valid root-bound receipt exists, but a present hook no longer matches its recorded published bytes | Human review; AgentHawk does not delete the changed hook |
| `unsafe` | A target or parent is linked, aliased, unstable, unsupported, or has an unexpected type | No mutation |

Readiness is separately `current`, `artifact_unavailable`, or `artifact_drift`.
It never changes `owned_exact` into an unowned state, so a still-identical old
pair remains safely removable after Node moves, the package is upgraded, or the
adapter artifact is unavailable. Mutation blockers are `config_collision` and
`operation_locked`. `config_collision` prevents a fresh install or activation
claim but never prevents removal of `owned_exact` or `owned_inactive`.

The first implementation does not guess that a lock is stale or break it by
process identifier or elapsed time; both checks are vulnerable to reuse and
clock/race ambiguity. An abandoned lock is a visible, fixed-file recovery task.
Recovery requires the human to stop and coordinate all AgentHawk operations for
that repository, verify the fixed lock is a contained non-linked regular file,
and remove only that fixed file while exclusive access is maintained. If no
such exclusion can be established, the lock is preserved. AgentHawk never
automates this recovery or treats PID/time as proof that deletion is race-free.

Output uses these bounded categories and remediation text. It does not reveal
absolute paths, installation identifiers, raw file contents, hook hashes, or
adapter hashes. `owned_exact` plus `current` means only that AgentHawk's
declaration is intact and its current artifacts match at the instant checked.
It does not mean Codex loaded, trusted, enabled, or could execute the hook.

### Transaction and recovery ordering

The implementation must acquire a fixed exclusive lock, re-establish root and
target identities, construct bounded files in its exclusive staging directory,
and validate the staged bytes before publication. Publication uses same-volume
no-replace operations whose behavior is proven on supported local filesystems;
an existence check followed by an overwriting rename is insufficient.

The supported primitive must be demonstrated by adversarial tests on each
claimed local filesystem and operating system. Network, virtual, or other
filesystems without a proven exclusive same-volume publication primitive fail
closed before receipt publication.

Installation publishes the receipt first and the hook second. Interruption can
therefore leave `owned_inactive`, but must never leave an enabled-looking
AgentHawk hook without its ownership record. If hook publication fails, the
command may remove only the still-identical receipt it just created; otherwise
it reports recovery state and leaves the evidence intact.

Removal deletes the still-identical hook first and the still-identical receipt
second. Interruption can again leave only `owned_inactive`. It must not
remove a changed hook, an unowned hook, an unknown receipt, `.codex` itself, or
unrelated files. Errors and cancellation release the lock and remove only the
operation's verified staging files. Recovery never scans or recursively deletes
the repository.

Cancellation has explicit linearization semantics. Before receipt publication,
installation may return cancelled after cleanup. After receipt publication but
before hook publication, it first attempts to remove only the still-identical
receipt: successful rollback is re-read as `absent` and returns cancelled;
failed or unprovable rollback is re-read and reports `owned_inactive` recovery,
not plain cancellation. Once the hook no-replace publication succeeds,
installation is committed: cancellation is deferred until the complete state
is re-read and the command reports `owned_exact` (or a bounded recovery state),
rather than reporting failure while a complete hook is live.

Removal is symmetric. Before hook deletion it may return cancelled. Once the
still-identical hook is deleted, removal is committed and cancellation is
deferred until receipt deletion is attempted and the resulting `absent` or
`owned_inactive` state is re-read and reported. Lock release and staging cleanup
occur only after the committed state has been classified. Cancellation cannot
turn a post-commit success into an ambiguous failure response.

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
marker, definition mutation becoming untrusted/`owned_modified`, disabled hooks, and
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

The root-bound artifact-format prerequisite is implemented. It exposes the
authority loader's already verified exact bigint root identity, generates
canonical 256-bit identifiers, uses the fixed length-framed root-binding vector,
creates one deterministic synchronous hook plus strict path-redacted receipt,
quotes every launch argument for the named POSIX and Windows PowerShell forms,
and strictly parses only the three fixed ordered launch declarations. This does
not write configuration or activate the adapter.

The next implementation slice can add only project-scoped `status`, `install`,
and `remove`, transactional filesystem helpers, invocation-time pair
verification, and the exact project-hook host harness. It must add adversarial tests for collisions,
links and reparse points, identity races, cancellation at every publication
boundary, abandoned locks, changed artifacts, interrupted install/removal, hostile
file contents, and bounded redacted output on Windows, Linux, and macOS where
the local-filesystem primitives are claimed.

User/managed/plugin installation, portable committed configuration, trust
automation, merge/adopt/force/repair/upgrade operations, arbitrary paths,
workspace-root inference, other Codex versions/surfaces, and other vendors stay
deferred.
