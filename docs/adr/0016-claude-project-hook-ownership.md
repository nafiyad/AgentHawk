# ADR 0016: Claude Code project-hook ownership

## Status

Accepted as the design boundary for read-only status. No Claude Code settings
mutation, installation, removal, activation, or native support is authorized by
this decision.

## Context

The release-pinned Claude Code `2.1.241` fixture edge can translate bounded
`PreToolUse` input and return neutral silence, structured denial, or an exit-2
emergency denial. A settings-file command hook is still an external fail-open
host boundary: missing executables, startup failures, malformed output, and host
timeouts proceed through normal Claude Code permissions. Before even a
compatibility-candidate lifecycle can be considered, AgentHawk needs a
collision model that does not overwrite maintainer settings or imply effective
activation.

This decision uses current official Anthropic sources, accessed 2026-08-24:

- [Hooks reference](https://code.claude.com/docs/en/hooks) defines the nested
  `hooks.PreToolUse[]` matcher-group shape, exact `Bash|PowerShell` matcher,
  command-handler exec form, source locations, handler deduplication, parallel
  execution, read-only `/hooks` browser, hot reload, and removal by editing the
  originating settings JSON.
- [Settings and configuration](https://code.claude.com/docs/en/configuration)
  defines managed, command-line, project-local, project-shared, and user
  precedence. `allowManagedHooksOnly` can exclude project hooks, and effective
  sources can differ across invocations.
- [Debug your configuration](https://code.claude.com/docs/en/debug-your-config)
  confirms that no standalone `.claude/hooks.json` exists and that
  `.claude/settings.local.json` overrides `.claude/settings.json` for ordinary
  settings.
- [ADR 0015](0015-claude-code-hook-edge.md) records workspace-trust,
  programmatic-mode, bare-mode, environment, timeout, sibling-hook, and direct
  shell residuals for the exact compatibility candidate.

Claude hooks merge across user, project, local, plugin, managed, session, and
SDK sources. Identical command handlers are deduplicated by command plus
arguments, but deduplication is not ownership: a byte-similar foreign entry can
change independently, and sibling handlers still run in parallel. A repository
snapshot also cannot observe command-line, user, managed, plugin, session, or
SDK state completely. Therefore no read-only repository command can prove that
the candidate hook is loaded, unique, trusted, enabled, executable, or
enforcing.

## Decision

### Scope and fixed targets

The first lifecycle candidate is explicit, project-local, and machine-specific
only when Git proves its fixed path is currently ignored.
It is not part of `agenthawk init` and will not edit the shareable
`.claude/settings.json`. A later, separately reviewed transaction may exclusively
own a previously absent `.claude/settings.local.json` containing only one
AgentHawk matcher group. Using the local file avoids rewriting public maintainer
configuration. A later installer must refuse unless `git check-ignore -q --
.claude/settings.local.json` succeeds immediately before publication; this
reduces accidental publication of runtime-specific absolute paths but cannot
prevent a user from force-adding an ignored file.

The first read-only preflight may observe only these fixed contained targets after loading
the canonical co-root repository authority:

```text
<root>/.claude/settings.json
<root>/.claude/settings.local.json
```

It accepts no path override and directly opens no user-home file, Claude
configuration directory, managed policy, plugin, session, SDK, environment,
transcript, or trust store. It contacts no provider or network service and does
not create a missing directory or file. The trusted Git subprocess can consult
its normal repository, parent, per-repository, and user-global configuration or
exclude sources; AgentHawk does not request, capture, parse, retain, or render
those source paths, patterns, or bytes. Linked worktrees remain observable as
independent AgentHawk roots; host discovery behavior must be proven before a
later installer admits them.

The preflight directly opens only the two fixed settings targets and runs only
bounded, shell-free Git argument arrays. In addition to
the existing topology query, `git check-ignore -q --
.claude/settings.local.json` observes effective repository, parent, global, and
per-repository excludes without returning pattern content or a path. Exit `0`
means `ignored`, exit `1` means `not_ignored`, and every other result is
`unknown` with a blocker. A tracked path is not accepted as ignored. Any later
transaction must repeat this check under its operation lock and fail if the
result changed. AgentHawk does not add an ignore rule or alter Git configuration.

The observer uses bounded directory enumeration, fatal UTF-8, duplicate-key
rejection, regular-file and containment checks, exact bigint file identities,
and two matching snapshots. Symbolic links, reparse/canonical aliases, hard
links, unexpected types, oversize files, parent or target identity changes, and
unstable bytes classify the observation as `unsafe`. Portable Node filesystem
APIs do not make this an atomic or hostile-filesystem proof.

### Generated local settings candidate

The future owned local settings file is a closed canonical JSON object with only
this shape:

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
              "<fixed root-bound launch arguments>"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The exact field set and timeout must be rechecked against the pinned artifact
before mutation. Exec form is mandatory: `args` is present, `command` is one
absolute executable path, and no shell, `PATH` lookup, `npx`, package manager,
repository script, environment interpolation, `if` prefilter, asynchronous
handler, HTTP hook, MCP hook, prompt hook, or agent hook is allowed. The host
timeout exceeds AgentHawk's internal eight-second deadline. The handler matches
both canonical shell tools so a PowerShell-only Windows inventory cannot bypass
a Bash-only matcher; the current PowerShell qualifier intentionally denies every
PowerShell command.

The root-bound launch and receipt format is not authorized by this ADR. A later
format slice must bind one OS-CSPRNG installation identifier to the canonical
root identity and exact generated bytes, retain no raw path in the receipt, and
verify that pair on every invocation before deployment trust can become
`project`. Until then, the fixture adapter always records `unknown`.

### Exclusive ownership and collision policy

AgentHawk will never merge into, adopt, normalize, repair, or partially own an
existing `.claude/settings.local.json`. If that file is present without an exact
future root-bound receipt, it is foreign regardless of whether its JSON resembles
the candidate. A later installer must refuse. This deliberately sacrifices
compatibility for a small auditable ownership boundary.

The shareable `.claude/settings.json` remains maintainer-owned and read-only.
Status parses only enough of its duplicate-free bounded JSON object to classify
security-relevant project declarations:

- `disableAllHooks: true` is a blocker;
- any configured `PreToolUse` matcher group is a sibling-hook blocker because
  matching handlers can run in parallel and produce side effects;
- malformed, oversized, linked, aliased, or unstable configuration is unsafe;
- every other key and hook event is retained as untrusted uninterpreted data and
  creates no ownership claim.

AgentHawk does not set `disableAllHooks: false`, remove sibling hooks, edit an
unrelated project setting, change `.gitignore` or another exclude source, or
infer safety from a syntactic match. User, managed, plugin, session, SDK,
`--settings`, `--bare`, selected
setting sources, and workspace trust remain unobserved external activation
conditions. `allowManagedHooksOnly` in particular can suppress the project-local
candidate even when every repository-owned byte is exact.

### Read-only preflight state model

Before an owned receipt format exists, status must not claim ownership or artifact
readiness. The first command is a collision preflight with five bounded
observations:

| Field | Values | Meaning |
| --- | --- | --- |
| `localSettings` | `absent`, `present`, `unsafe` | Whether the exclusively targeted local settings path is available; `present` is foreign, with no content disclosed or adopted |
| `sharedSettings` | `absent`, `present`, `unsafe` | Whether the maintainer-owned shared settings path was safely observed |
| `sharedPreToolUse` | `absent`, `present`, `unknown` | Whether bounded strict shared JSON declares any `PreToolUse` matcher group |
| `sharedDisableAllHooks` | `false`, `true`, `unknown` | The literal shared-project declaration only, never an effective merged value |
| `localSettingsIgnored` | `ignored`, `not_ignored`, `unknown` | The current quiet Git ignore result for the exact future local-settings path; it is a publication precondition, not a guarantee against force-add or later configuration change |

Malformed, duplicate-bearing, oversized, non-object, or unsupported shared JSON
cannot establish either nested observation and produces `unsafe`, `unknown`,
and a fixed blocker without returning parser detail or source text. A present
local settings file is not parsed in this slice: AgentHawk does not own it, will
not merge it, and needs only its safely observed existence to refuse a future
exclusive install.

The initial blockers are bounded enums:

- `local_settings_unsafe`;
- `shared_settings_unsafe`;
- `local_settings_present`;
- `local_settings_not_ignored`;
- `ignore_status_unavailable`;
- `project_hooks_present`;
- `project_hooks_declared_disabled`;
- `linked_worktree` until exact host discovery is proven.

Blockers are deduplicated and emitted in exactly that order. An unsafe local
observation still permits bounded shared and ignore observation but never
produces a healthy precondition. An unsafe shared observation fixes both nested
shared fields to `unknown`; it cannot be hidden by local absence or ignore state.

The report also carries `activation: "unproven"` as a fixed explicit boundary.
It returns only schema/tool version, command, the five observations, blockers,
activation, `providersContacted: false`, and a stable exit meaning. It never
returns paths, commands, settings, identifiers, digests, file contents, user or
managed state, environment values, or parser errors. Both settings absent,
`localSettingsIgnored: "ignored"`, and no observable blocker is healthy only as
a future installation-precondition
result, never healthy enforcement.

The eventual receipt-aware lifecycle may add `owned_inactive`, `owned_exact`,
`record_collision`, `owned_modified`, and artifact-readiness states only after a
separate ADR amendment defines canonical generated bytes, root binding, receipt,
invocation arguments, and recovery. The preflight must not reserve meaning by
pretending those unimplemented artifacts already exist.

### Acceptance criteria for the next implementation slice

The next slice is read-only `agenthawk integrations claude status`. It must:

1. reuse canonical co-root repository authority and bounded shell-free Git
   topology observation;
2. observe only the two fixed settings targets twice and the exact quiet Git
   ignore/topology queries without writes or provider calls;
3. strictly distinguish absent, present, and unsafe settings state without
   parsing or adopting foreign local settings;
4. parse project settings with fatal UTF-8 and duplicate rejection while
   ignoring unrelated keys and detecting only the two public blockers above;
5. emit only bounded minimum-disclosure terminal/JSON fields and always state
   activation is unproven;
6. include adversarial tests for aliases, links, hard links, identity changes,
   oversized/deep/wide shared JSON, duplicate keys, hostile strings,
   cancellation, linked worktrees, no-provider behavior, every observation/
   blocker precedence, ignore changes/failures, tracked or force-added local
   settings, and no raw ignore-pattern output; and
7. update package allowlists and packed-consumer smoke without creating or
   changing `.claude` state.

No install/remove command is included. A mutating lifecycle requires a later ADR
amendment covering the root-binding format, exact owned bytes, no-replace
publication capability, cancellation linearization, recovery ordering,
invocation-time verification, and exact-host discovery.

## Alternatives

- Editing `.claude/settings.json` was rejected because it is shareable
  maintainer-owned configuration and would require structural merge, rollback,
  formatting/comment policy, and per-entry ownership in a file AgentHawk does
  not own.
- Merging into an existing `.claude/settings.local.json` was rejected because
  byte-level receipt ownership cannot safely distinguish future user edits from
  AgentHawk state without a much larger structural transaction model.
- A standalone `.claude/hooks.json` was rejected because official Claude Code
  documentation says that file is not loaded.
- User or managed installation was rejected because it expands authority beyond
  the repository, involves private configuration, and has distinct enterprise
  ownership and recovery requirements.
- A committed absolute command was rejected because it is workstation-specific
  and would publish local runtime paths.
- Treating `/hooks` or a successful status read as activation proof was rejected
  because status does not own an interactive Claude session and cannot observe
  every merged or disabling source.

## Security implications

Future exclusive ownership of a previously absent and currently ignored local settings file avoids rewriting
maintainer data and makes later exact removal possible. It does not prevent a
same-account repository writer from modifying or deleting the hook, receipt,
package, runtime, or lock. It also cannot prevent parallel sibling-hook effects,
host startup/timeout fail-open behavior, direct shell or other tool bypasses, or
higher-authority configuration from excluding the hook.

Repository-only status intentionally has false negatives for user, managed,
plugin, session, and SDK collisions and disablement. Reporting activation as
unproven is therefore mandatory. Protected `scan`/`diff` CI remains the final
repository gate.

## Consequences

The design permits a small read-only status implementation while forbidding
configuration mutation. Repositories that already use local Claude settings or
do not currently ignore the exact local-settings path will be ineligible for the first lifecycle candidate unless a future ownership
decision safely expands the model. No Claude Code native row becomes supported
by accepting this ADR or implementing status.
