# Claude project-hook lifecycle candidate

This development-checkout feature is **unsupported native integration**, not
proof that Claude Code has activated enforcement. It is not in the published
`0.1.0-alpha.1` packages. The fixture contract is pinned to Claude Code
`2.1.241`; a separate exact-host matrix must establish each supported surface.

## Explicit setup

Run from the canonical root of an ordinary Git checkout. Linked worktrees are
not installable. Use the built checkout CLI or a subsequently released package;
do not run these commands from an agent-controlled install script.

Before setup, the operator must configure Git to ignore every local target.
For example, review these rules for the repository's `.git/info/exclude`:

```gitignore
/.claude/settings.local.json
/.agenthawk/integrations/claude-v1.json
/.agenthawk-claude-integration.lock
/.agenthawk-claude-integration-*
```

The staging rule deliberately has no trailing slash: its exact name must match
before the directory exists. Existing tracked files are not made untracked by
ignore rules. AgentHawk never changes ignore configuration itself.

```text
pnpm agenthawk integrations claude status --format json
pnpm agenthawk integrations claude install --format json
pnpm agenthawk integrations claude status --format json
pnpm agenthawk integrations claude remove --format json
```

Install refuses an existing local settings file or receipt, even if its bytes
look identical. It does not merge or adopt settings. Shared `PreToolUse`, shared
hook disabling, unknown ignore state, linked worktrees, unsafe aliases/links,
and foreign locks prevent installation. No provider or package manager is
contacted. Parent directories remain unowned and are never removed.

The installer verifies root authority, ignored/untracked state for all four
exact candidate paths before any artifact and again under its exclusive lock.
Synced staging files exercise a real two-contender no-replace hard-link probe
and occupied-destination rejection. It publishes the receipt first, revalidates
ownership and blockers, then publishes settings. Removal validates exact bytes
and identity, removes settings first, and then the receipt. It can remove an
unchanged old pair after an adapter upgrade or shared-setting drift, but not
when the ownership files or ignore boundary have changed.

## Reports and interruption recovery

Lifecycle JSON reports contain only command, outcome, ownership, readiness,
ordered blockers, tool/schema versions, `providersContacted: false`, and
`activation: "unproven"`. Outcomes are `installed`, `removed`, or
`recovery_required`. Exit `0` means completed lifecycle, `1` requires recovery
review, `2` rejects unsafe/unavailable input, and `4` is a bounded internal
failure. Paths, identifiers, settings, digests, and exception details are absent.

The internal API accepts an AbortSignal: before publication/deletion it can
cancel with verified cleanup; after settings publication or deletion it settles
the committed state before returning. The CLI does not translate Ctrl-C into
that signal. Process termination, Ctrl-C, or power loss can leave crash state.

- `owned_inactive` without a lock: run `remove` to delete only the valid receipt.
- `owned_exact` without a lock: inspect status; `remove` accepts unchanged
  settings even if the current runtime or adapter has drifted.
- Any retained lock: stop all competing lifecycle operations first. A lock is
  never assumed stale from a PID or time. Recovery requires external exclusion
  and a maintainer's fixed-path identity/content review. A valid lock identifies
  one staging directory; do not scan for or recursively delete similarly named
  directories. If cleanup cannot prove ownership, leave the files intact.
- Modified, unowned, colliding, or unsafe state: do not delete or overwrite it
  automatically. Preserve it for maintainer review. There is no force option.

Incomplete staging cleanup retains the lock so the single staging candidate
remains discoverable. Ambiguous staging creation also retains the lock, even
when creation cannot be confirmed; an unverified directory is never deleted.
Hard links can remain after interrupted publication and
must not be misrepresented as an exact usable pair.

## Limits

The capability probe is point-in-time evidence, not a hostile-filesystem or
power-loss durability guarantee. Node lacks a portable handle-relative
transaction; a same-account writer can still race path operations. Start the
candidate host only at the exact canonical root. Home-root repositories, host
ownership failures, nested starts, SDK/IDE/desktop, remote and other versions
remain unproven. Shared/user/managed settings, selected sources, trust, startup
failure, and timeouts can prevent execution. Protected scan/diff CI remains the
final repository gate. Installation does not grant trust or prove activation.

See [ADR 0017](adr/0017-claude-project-hook-transaction.md),
[threat model](threat-model.md), and [support matrix](support-matrix.md).
