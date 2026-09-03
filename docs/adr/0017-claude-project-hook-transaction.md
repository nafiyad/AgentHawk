# ADR 0017: Claude Code project-hook receipt and transaction

## Status

Accepted. The install/remove transaction candidate is implemented under this
boundary; exact-host activation and a support decision remain separate gates.

## Context

The release-pinned Claude Code `2.1.241` fixture edge, repository-only collision
preflight, canonical ownership format, invocation-time verifier, and
receipt-aware status are complete. They do not mutate settings or prove
that Claude Code loaded a hook. A mutating lifecycle needs a closed ownership
record and an interruption model before it can safely create
`.claude/settings.local.json`.

This decision uses public primary sources, accessed 2026-08-27 and rechecked
2026-08-31 for the status boundary, with Node/Git/hooks references rechecked
2026-09-03 for the transaction:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks) documents that
  project-local hooks live under the `hooks` key in settings, `PreToolUse` can
  deny before permission evaluation, matching handlers may run in parallel,
  exec form is selected by an `args` array, and command-hook startup failures,
  non-blocking exit codes, and timeouts can allow normal processing to continue.
- [Claude Code hook guide](https://code.claude.com/docs/en/hooks-guide)
  documents `.claude/settings.local.json` as a machine-local project settings
  source, `.claude/settings.json` as shareable project configuration, and
  `/hooks` as the host-side inspection surface.
- [Claude Code configuration debugging](https://code.claude.com/docs/en/debug-your-config)
  documents that `settings.local.json` overrides project settings, standalone
  `.claude/hooks.json` is not loaded, hook matchers are case-sensitive, and
  local executable paths should be absolute.
- [Claude Code settings](https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository)
  documents an important location exception. Since `2.1.211`, local settings
  normally move to the Git root; a linked worktree instead uses the main
  checkout's root. Local settings remain with shared settings on Windows, when
  the repository root is the user's home, or when ownership checks fail. Shared
  project settings remain relative to the session's primary working directory;
  older local files may remain additive; and the Agent SDK helper always reads
  local settings from the starting directory.
- [Claude Code permissions](https://code.claude.com/docs/en/permissions)
  documents that `PreToolUse` runs before the permission prompt and that a
  blocking hook takes precedence over allow rules. This does not make a missing
  or failed hook fail closed.
- Node.js [filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html)
  warns that promise-based filesystem operations are not synchronized,
  exclusive creation may be unreliable on some network filesystems, and
  multiple operations must be explicitly ordered. Its APIs do not provide a
  portable handle-relative, no-follow transaction across supported platforms.
- Git's [ignore documentation](https://git-scm.com/docs/gitignore) states that
  ignore rules are for intentionally untracked files and do not affect files
  already tracked. [`git check-ignore`](https://git-scm.com/docs/git-check-ignore)
  gives distinct ignored, not-ignored, and fatal exit states without requiring
  pattern disclosure.

The host documentation defines configuration behavior. The ownership format,
digests, transaction ordering, and recovery states below are AgentHawk design
choices, not Claude Code guarantees.

## Decision

### Scope and fixed targets

The first lifecycle candidate is explicitly requested and machine-local to one
canonical ordinary Git worktree. It is not part of `agenthawk init`. The future
surface is:

```text
agenthawk integrations claude status
agenthawk integrations claude install
agenthawk integrations claude remove
```

The lifecycle may own only these fixed targets:

```text
<root>/.claude/settings.local.json
<root>/.agenthawk/integrations/claude-v1.json
<root>/.agenthawk-claude-integration.lock
<root>/.agenthawk-claude-integration-<operation-id>/
```

The lock and staging directory are temporary. Existing `.claude`,
`.agenthawk`, and `.agenthawk/integrations` directories remain unowned
containers. AgentHawk never removes them, scans them recursively, or modifies
unrelated children. Missing fixed parents may be created with exclusive
no-replace semantics, then must be canonicalized and identity-fenced. A link,
reparse point, case or Unicode compatibility alias, unexpected type, hard-linked
file, containment escape, or identity change fails closed.

Path overrides, user or managed settings, plugins, session hooks, SDK settings,
trust-state writes, `--settings`, `--bare`, environment mutation, and Git ignore
changes remain outside scope. Linked worktrees remain non-installable until a
pinned-host lifecycle coordinates ownership with the main checkout rather than
writing an apparently owned file at the linked worktree root.
The first candidate also requires Claude Code to start at the exact canonical
root. This is mandatory on Windows and prevents a root-fixed status result from
being generalized to a nested-start or starting-directory settings source.
Repository roots equal to the user's home and failed host ownership checks are
unsupported. The lifecycle does not read the home directory to detect those
conditions; exact-host evidence must establish them without publishing private
paths or settings.

### Canonical generated settings

The generated UTF-8 bytes are deterministic compact JSON with one final LF and
exactly this semantic shape:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "<absolute current Node executable>",
            "args": [
              "<absolute packaged claude-pretooluse-entry.js>",
              "--deployment-trust",
              "project",
              "--installation-id",
              "<64 lowercase hexadecimal characters>",
              "--root-binding",
              "<64 lowercase hexadecimal characters>"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Object-key order, array order, spelling, casing, timeout, and final newline are
part of the published-byte format. No other field is allowed. `args` is
mandatory so Claude Code uses exec form; `command` and the adapter path are
canonical absolute paths. The candidate never uses shell form, `PATH`, `npx`, a
package-manager shim, repository executable code, interpolation, `if`, `async`,
HTTP, MCP, prompt, or agent hooks.

The matcher covers both canonical shell tools. The current PowerShell qualifier
denies every PowerShell command, so a Windows inventory cannot bypass a
Bash-only matcher. The host timeout exceeds AgentHawk's internal eight-second
deadline, but host startup and timeout behavior remains a documented fail-open
residual.

### Installation identity and root binding

Each installation uses a 256-bit operating-system CSPRNG identifier encoded as
exactly 64 lowercase hexadecimal characters. It is not a credential.

The root binding is lowercase hexadecimal SHA-256 over this canonical binary
sequence:

```text
ASCII "AgentHawk Claude root binding v1" || 0x00
|| field(installation-id raw 32 bytes)
|| field(canonical-root UTF-8 bytes)
|| field(dev canonical ASCII decimal)
|| field(ino canonical ASCII decimal)
```

Each `field` is an unsigned 64-bit big-endian byte length followed by its bytes.
Zero is encoded as `0`; other decimal fields have no sign or leading zero.
Invalid UTF-8, an out-of-bound field, `dev < 0`, `ino <= 0`, or either identity
component above `2^64 - 1` fails closed. The implementation must add fixed
serialization and digest vectors.

The receipt and settings carry the same installation identifier and binding.
The receipt never stores the raw root path. A copied pair fails verification in
a different canonical root, but the binding is not authentication against a
same-account writer and does not conceal a low-entropy path from an attacker who
already knows the other inputs.

### Closed receipt

`claude-v1.json` is canonical compact JSON with one final LF and exactly these
fields:

```text
schemaVersion: "1.0"
adapter: "claude-code"
adapterVersion: <AgentHawk package version>
contractRelease: "2.1.241"
installationId: <64 lowercase hex>
rootBinding: <64 lowercase hex>
nodeVersion: <exact process.version>
settingsSha256: <sha256 of published settings bytes>
launchArgumentsSha256: <sha256 of the exact argument vector>
adapterSha256: <sha256 of packaged claude-pretooluse-entry.js bytes>
```

`launchArgumentsSha256` is SHA-256 over this canonical byte sequence:

```text
ASCII "AgentHawk Claude launch arguments v1" || 0x00
|| u64be(argument count)
|| field(argument 0 UTF-8 bytes)
|| ...
|| field(argument n UTF-8 bytes)
```

`field` has the same unsigned 64-bit big-endian length framing as the root
binding. The array contains the adapter entry path followed by the six exact
project launch arguments in generated-settings order. Every argument must be
valid bounded UTF-8 without NUL or control characters. The serialization has no
terminating LF. The implementation must add a fixed launch-vector test; joining
arguments with a delimiter is forbidden.

Unknown, missing, duplicated, mistyped, non-canonical, oversized, or unstable
receipt data is a collision. `contractRelease` records the fixture contract and
is not a claim that the installed host has that version. The receipt stores no
raw path, command observed
from an agent, environment value, user name, credential, host trust state, or
activation assertion. The Node executable is compared by canonical absolute
path in the exact settings bytes; the receipt intentionally does not claim to
hash or authenticate Node executable bytes.

### Exclusive ownership and state model

AgentHawk owns state only when a strict root-bound receipt and the exact recorded
settings bytes form a pair. Similar settings without the receipt are foreign.
AgentHawk never merges, adopts, normalizes, repairs, or overwrites an existing
local settings file or receipt.

Receipt-aware status extends the current observations with one ownership state
and one independent readiness state:

| Ownership | Meaning |
| --- | --- |
| `absent` | Receipt and local settings are absent |
| `owned_inactive` | Valid root-bound receipt exists and local settings are absent |
| `owned_exact` | Receipt and exact recorded local settings are present |
| `unowned_settings` | Local settings exist without a receipt |
| `record_collision` | Receipt exists but is not the exact valid root-bound record |
| `owned_modified` | Valid receipt exists but local settings differ from recorded bytes |
| `unsafe` | A fixed target or parent is unsafe or unstable |

Readiness is `not_applicable`, `current`, `artifact_unavailable`, or
`artifact_drift`. It compares current canonical Node and adapter paths, current
Node/package version, adapter bytes, launch arguments, and generated definition
against a valid receipt. It never changes ownership: an old exact pair remains
removable after an upgrade or runtime move.

Existing shared settings observations, quiet-ignore state, and linked-worktree
state remain independent blockers. Safe unrelated shared settings do not block.
Shared `PreToolUse`, shared `disableAllHooks: true`, or a linked worktree
prevents install and any readiness claim, but shared-setting drift cannot hide
or prevent removal of `owned_exact` or `owned_inactive`. A not-ignored, unknown,
or tracked candidate path blocks every mutation, including removal, until the
operator restores ignored-and-untracked state. Any foreign or unrecognized
operation lock likewise blocks every mutation, including remove. Status remains
minimum-disclosure and keeps effective activation `unproven` in every state.

The implemented JSON report keeps the existing shared/local observations and
adds only `ownership`, `readiness`, and the aggregate
`integrationArtifactsIgnored` state. It never emits an installation or
operation identifier, root binding, digest, path, settings bytes, ignore
source, or parser diagnostics. An exact current pair with no blocker, or a
completely absent installable state, returns exit `0`; every other observation
requires diagnostic attention. The canonical lock record contains only
`schemaVersion: "1.0"` and one 256-bit operation identifier. A malformed,
noncanonical, oversized, or otherwise unrecognized lock still blocks mutation
and makes the lock-derived staging ignore observation unavailable; it is never
guessed or treated as stale.

Receipt-aware status adds `integration_artifacts_not_ignored` and
`integration_ignore_status_unavailable` blockers. They summarize the exact
receipt, lock, and lock-derived staging targets without returning which path or
ignore source caused the result. An operation that owns the exact open lock may
ignore its own `operation_locked` blocker internally only after revalidating the
lock identity and bytes; another command never may.

### Invocation-time verification

The future entrypoint accepts either zero launch arguments for the existing
fixture boundary or the exact six project arguments above. Any other argument
shape produces the existing constant exit-2 emergency denial.

For project arguments, the adapter parses and bounds hook input first, uses only
its validated absolute `cwd` to re-establish canonical root identity, validates
the receipt and exact local settings pair, recomputes root binding and current
artifact readiness, and requires no operation lock. Only then may it label
deployment trust `project` and call the deterministic evaluator. Failed,
cancelled, unavailable, or mismatched verification emits only the constant
emergency denial and performs no provider request. The invocation does not read
shared, user, managed, plugin, session, SDK, command-line, or environment
configuration and therefore never claims effective activation.

### Transaction and cancellation ordering

Every mutation must:

1. establish root-only authority and the complete status snapshot;
2. generate the operation identifier in memory and preflight ignored/untracked
   state for all four exact candidate paths before creating any artifact;
3. acquire the fixed lock by exclusive create;
4. re-establish root, topology, parents, shared blockers, ignore state for every
   persistent or crash-retained target, and absence or exact ownership under the
   lock;
5. create an exclusive 256-bit-ID staging directory;
6. write, sync, close, reopen, and validate exact bounded receipt/settings bytes;
7. capability-test same-volume no-replace publication on the actual filesystem;
8. publish through verified no-replace primitives while identity-fencing every
   parent and fixed target; and
9. re-read the final state before releasing the lock and cleaning only verified
   staging files.

An existence check followed by overwriting rename is forbidden. The capability
probe races two different synced staged regular files to one absent fixed name,
requires exactly one winner and one `EEXIST`, verifies the winning identity and
bytes, and proves that an occupied destination rejects another publication
without mutation. A failed or unprovable probe fails closed. This is an observed
filesystem capability, not a claim that the filesystem is local, race-free, or
power-loss durable.

Before creating any local artifact, quiet shell-free Git checks must prove that
all four exact candidate paths are ignored and untracked: local settings,
receipt, lock, and the operation-ID staging directory. The operation identifier
is generated before these checks. After exclusive lock creation, the same four
checks repeat while the lock is verified as this operation's exact untracked
file and before any other artifact is created. A retained lock lets status
derive the one staging name without scanning. Exit `1`, fatal Git status,
changing ignore results, or a tracked candidate fails closed. AgentHawk never
edits `.gitignore`, the repository exclude file, or a global exclude file. This
intentionally means the first installer is unavailable until the maintainer or
user configures an applicable ignore rule for every machine-local target family.

Install publishes the receipt first and settings second. Before receipt
publication, cancellation may clean verified staging state and return
cancelled. After receipt publication but before settings publication, rollback
may delete only the still-identical receipt it created; verified rollback
returns cancelled, while failed or unprovable rollback reports
`owned_inactive`. Once settings publication succeeds, the install is committed:
cancellation is deferred until final classification reports `owned_exact` or a
bounded recovery state.

Remove first refuses any pre-existing foreign or unrecognized operation lock,
then acquires and continuously verifies its own lock. It deletes still-identical settings first and the still-identical receipt
second. Before settings deletion it may return cancelled. After settings
deletion, removal is committed and cancellation is deferred until receipt
deletion is attempted and the resulting `absent` or `owned_inactive` state is
reported. It never deletes changed settings, a foreign file, an invalid receipt,
parent directories, or unrelated content.

Errors release only the operation's still-identical lock and staging files.
Cleanup is fixed-target and non-recursive. A lock is never guessed stale from a
PID or clock. Manual recovery requires external exclusion, fixed-path identity
verification, and removal of only that lock; AgentHawk does not automate it.
Crash-retained lock and staging state remains covered by the pre-proven ignore
boundary and therefore is not silently exposed to ordinary Git addition.

### Activation and support boundary

An exact pair with current artifacts proves only that AgentHawk's project-local
declaration is intact at observation time. It does not prove Claude Code loaded,
trusted, enabled, or executed the hook. Higher-authority settings, selected
setting sources, `--settings`, `--bare`, inherited trust, startup failure,
timeout, direct shell access, another tool surface, or a same-account writer can
bypass or disable it. Protected `scan`/`diff` CI remains the final repository
gate.

No Claude native row becomes supported until an exact-version real-host matrix
independently proves installed-but-untrusted behavior, explicit host trust,
neutral execution, visible denial with non-execution markers, every verdict,
malformed input, startup and timeout behavior, mutation invalidation, removal,
and fake-credential non-disclosure on each claimed OS/client surface. The matrix
must distinguish canonical-root and nested starts on Windows and POSIX, linked
worktrees, interactive and `-p` sessions, SDK resolution, IDE/desktop clients,
and excluded or bare settings sources. Until then only canonical-root startup is
the candidate and every other surface is unsupported.

### Dependency-ordered implementation slices

The design is accepted and implementation remains single-flight and ordered:

1. pure canonical settings/receipt/root-binding format plus known vectors —
   complete;
2. invocation-time project verification and fail-closed process tests —
   complete;
3. receipt-aware read-only status states and minimum-disclosure schema —
   complete;
4. install/remove transaction with filesystem capability tests — implemented
   and locally validated; delivery requires exact-head review and green CI; and
5. exact-host activation matrices and a separate support decision.

No slice may create install/remove commands before its prerequisites are merged.

## Alternatives

- Reusing `.claude/settings.json` was rejected because it is maintainer-owned,
  shareable configuration requiring a structural merge and per-entry rollback.
- Adopting a byte-identical local settings file was rejected because bytes do
  not prove who created it or authorize future deletion.
- A standalone hooks file was rejected because Claude Code does not load
  `.claude/hooks.json`.
- User or managed installation was rejected because it expands authority beyond
  the repository and has different privacy, administration, and recovery rules.
- Shell form, `npx`, and repository launchers were rejected because they add
  tokenization, path lookup, package execution, and mutable repository code.
- Overwriting rename and check-then-write publication were rejected because
  they can replace foreign state after a race.
- Automatic stale-lock removal was rejected because PID reuse and clocks do not
  prove exclusive ownership.
- Treating `/hooks`, status, or exact bytes as activation proof was rejected
  because repository observation cannot see every effective host source.

## Security implications

Receipt-first publication prevents an enabled-looking AgentHawk settings file
from being created without an ownership record. Settings-first removal prevents
an interrupted remove from leaving an active declaration after its receipt is
gone. Exact ownership permits safe removal of old but unchanged state without
silently repairing drift.

Portable Node APIs cannot prove immunity to every same-account filesystem race,
reparse type, bind mount, network-filesystem behavior, or power loss. Capability
tests and repeated identity fences narrow supported behavior and fail closed;
they do not create an atomic hostile-filesystem guarantee.

## Consequences

The explicit lifecycle implements this ordering and never changes trust or
ignore rules. Graceful cancellation applies to API callers supplying a signal;
the CLI treats Ctrl-C as abrupt interruption, with retained-state recovery.
Cleanup rechecks exact bytes and identities; incomplete staging cleanup retains
the lock for single-candidate discovery. See [setup and recovery](../claude-project-hook-lifecycle.md).

The pure-format implementation and invocation verifier add no lifecycle command
or mutation. Project invocation performs bounded, identity-fenced reads of only
the fixed receipt, local settings, lock, current adapter, and repository
authority. It reaches providers only after the exact pair and current artifacts
verify. The later lifecycle will reject repositories with foreign
local settings, relevant shared hooks, an effective shared disable declaration,
uncertain ignore state, linked worktrees, unsafe paths, collisions, or locks.
That conservative cost is
accepted to keep ownership explainable and removal bounded. No current format
result changes status, deployment trust, effective activation, or support.
