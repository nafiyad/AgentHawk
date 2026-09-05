# Threat model

## Scope

This threat model covers npm request parsing, registry and OSV evidence retrieval, deterministic policy evaluation and validation, exact expiring approvals, the bounded public-metadata cache, direct dependency inventory, Git diff analysis, GitHub pull-request reporting, agent instruction templates, native pre-tool compatibility candidates and read-only integration preflights, release-package verification, and npm staging.

## Assets

- developer workstation and repository integrity;
- source code and repository metadata;
- environment variables and package-registry credentials;
- the integrity and availability of AgentHawk reports;
- the distinction between direct evidence and unverified metadata.
- release artifact integrity and the npm publishing identity.
- host permission and sandbox authority that AgentHawk must not silently grant or replace.

## Trust boundaries

Package specifications, registry URLs, registry responses, redirects, HTTP status codes, metadata strings, and repository configuration are untrusted. The npm registry is an evidence source, not a trust authority. AgentHawk's normalized internal model is trusted only after schema validation.

Policy configuration is also untrusted input. Strict schemas reject unknown nested fields, numeric thresholds must be non-negative, and the known-malicious action cannot be weakened below `block`.

The Codex hook request path treats the complete payload, declared working directory, raw shell command text, host configuration, hook environment, and vendor failure behavior as untrusted. Only a release-pinned, bounded `PreToolUse` `Bash` shape reaches the transient action contract. Project deployment trust is recorded only after invocation-time verification of the exact current root-bound hook/receipt/runtime pair and no foreign lock; a project hook remains repository-controlled code, not an administrator boundary. Exact local Windows CLI and app-server real-host harnesses pass, and [ADR 0013](adr/0013-codex-project-hook-ownership.md) accepts an exclusive project-hook ownership design. The local ordinary CLI matrix additionally proves unrelated zero-provider behavior, allow execution, visible warn denial, distinct review/block/error denial, malformed emergency denial, exact tool-set binding, removal, and controlled performance. The pinned hosted Windows environment rejects the restricted-token split writable-root projection before execution; its gate pins the normalized output digest and exact tagged-source reason, requires true marker absence, observes zero provider traffic, and verifies removal. [ADR 0014](adr/0014-codex-support-scope.md) therefore keeps the row unsupported. Exact tagged source also shows Code Mode's execute handler does not expose a pre-tool payload. Future vendor edges remain untrusted independent boundaries. [ADR 0012](adr/0012-native-hook-enforcement-boundary.md) defines the complete native gate.

The Claude Code fixture adapter is a separate untrusted edge. Canonical `Bash` and
`PowerShell` payloads, settings sources, shell grammars, host modes, and failure
semantics cannot inherit Codex evidence. Interactive settings hooks wait for
current-folder trust or previously accepted parent trust that extends to the
folder; `-p`/SDK has no trust dialog. Hooks execute with the user's authority and
inherited environment. Bare mode, settings-source selection, managed-only policy,
or hook disabling can exclude them. [ADR 0015](adr/0015-claude-code-hook-edge.md)
pins the research candidate, validates the closed process boundary, and keeps every Claude row unsupported. [ADR 0016](adr/0016-claude-project-hook-ownership.md) adds only a two-snapshot, minimum-disclosure project-settings preflight. It does not mutate settings, prove activation, or establish ownership/readiness.

## Abuse cases and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Spec smuggles a URL, Git ref, alias, or local path | Parse/classify before provider access | npm grammar evolves; unsupported valid forms may require review |
| Control characters or whitespace alter logs/requests | Reject them during parsing | Unicode confusables require later policy handling |
| Registry URL leaks embedded credentials | Reject username/password components | External proxy configuration is outside this boundary |
| Redirect escapes to an unsafe protocol | Manual bounded redirects; validate every target | HTTPS endpoint itself may be malicious |
| Provider hangs or streams indefinitely | Abort timeout and byte-counted stream reads | Network resource use exists within the configured bounds |
| Provider returns huge, malformed, or non-JSON data | Content-length and streaming limits, UTF-8 and JSON validation | Runtime/parser vulnerabilities remain possible |
| Provider error becomes implicit success | PG013 review; strict mode adds a typed evaluation error and makes the finding non-approvable | Provider availability can still interrupt evaluation |
| Invalid or impossible provider timestamps influence age rules | Strict calendar validation at provider and policy boundaries | A valid timestamp remains registry-supplied evidence, not independent proof |
| Hostile body or exception leaks secrets | Fixed diagnostic messages; never include bodies, URLs, headers, or caught details | Host-level logs outside AgentHawk are not controlled |
| Lifecycle script executes during inspection | Read script names only; never install or execute | Malicious code without lifecycle scripts is not detected |
| Metadata claims a false repository, integrity value, or provenance advertisement | Treat it as registry evidence, not proof of benignness; do not label attestation presence as verified provenance | Metadata-only cryptographic binding and artifact-byte verification remain deferred under [ADR 0008](adr/0008-provenance-verification-boundary.md) |
| Strong finding is hidden by a weaker finding | Fixed error > block > review > warn > allow precedence | Policy actions can intentionally suppress approvable rules |
| Similar-looking name is treated as proof | Label PG005 as a heuristic and require review | Conservative matching can still produce false positives or miss confusables |
| Policy YAML exhausts memory or expands aliases | Require a regular file, enforce a 256 KiB bound, reject duplicate keys and aliases | Local filesystem races remain possible within the bounded read |
| Standalone validation exposes policy contents, local paths, or provider data | Return only normalized version/mode and a deterministic digest; use fixed redacted errors; perform no provider/cache operation | The digest intentionally reveals when two normalized policies are equivalent |
| Provider diagnostics leak through reports or digests | Fixed rendered messages and normalized failure digest inputs | Timing and provider status remain observable by design |
| Hostile text injects terminal controls | Escape C0/C1 control characters before terminal output | Terminal behavior outside standard control ranges is platform-dependent |
| OSV POST is redirected or oversized | Bound request bodies; reject POST redirects; reuse HTTPS/credential/timeout limits | The OSV endpoint itself may return hostile JSON within the body limit |
| A partial OSV page is treated as complete | Follow `next_page_token`; truncated pagination is PG013 | OSV may still omit records that exist outside the query window |
| Abbreviated batch matches are used as findings | Hydrate `/v1/vulns/{id}` and validate before PG010/PG011 | Hydration failure fail-closes the evaluation |
| CVSS vectors are converted into guessed ratings | Use documented qualitative labels only; unknown severity does not match PG011 | Advisories that publish only vectors are not severity-matched |
| Disabling OSV is confused with provider failure | Explicit `registries.osv.enabled: false` is digest-visible status `disabled` | Operators can disable a required evidence source |
| Broad, stale, or forged approval weakens policy | Strict exact coordinates, required reason/times, maximum validity, and preserved findings | Repository writers can still authorize approvable review findings |
| Approval verification leaks exception contents or overstates applicability | Return only bounded aggregate time states and a semantic digest; apply nothing; keep policy-owned maximum validity at enforcement time | Counts and digest reveal file equivalence and lifecycle state by design |
| Local diagnostics expose secrets, execute tools, or overstate readiness | Fixed paths and enums, production configuration readers, exclusive cleaned cache probe, bounded sanitized `git --version`, no package-manager/provider invocation, and no raw paths/content/errors | A successful probe is point-in-time capability evidence; local Git and the operating system remain trusted boundaries |
| Initialization overwrites maintainer instructions, escapes the repository, or exposes partial content | Fixed contained targets, compiled bounded assets, exact-byte preflight, case and link checks, exclusive lock, complete staged files, no-replace hard-link publication, identity and bounded exact-content cleanup fences, and non-recursive rollback; changed or unknown bytes are preserved | Portable APIs cannot guarantee a multi-file transaction or defeat a same-user filesystem race; crashes can require documented fixed-target recovery |
| A policy or approval path redirects through a symlink/junction or mutates during read | Reject observed symbolic path components; compare opened identity and pre/post size and identity; use one bounded read | Portable component checks are not atomic against a local actor able to race filesystem changes |
| Cache poisoning, traversal, oversized data, or stale evidence creates false confidence | Provider-aware hashed keys, strict bounded schema, regular-file and timestamp checks, credential stripping, provider payload validation, live-only online admission, and mandatory PG013 for offline cache use | A local-account attacker can forge provisional findings or deny service, but cannot obtain a clean cached admission |
| Hostile Git ref, environment, or repository config redirects analysis or causes execution | Resolve refs with `--end-of-options`; sanitize inherited `GIT_*` variables; use direct argument arrays, immutable commit IDs, fatal UTF-8, disabled external diff/text conversion, bounded execution, and no shell | The trusted local Git executable and operating system remain in the boundary |
| Manifest changes without regenerated resolution data | PG014 correlates direct dependency changes with a recognized lockfile diff from the same base | A changed lockfile is not proof that its contents correctly resolve the manifest |
| Approval overrides a hard security result | Resolve only approvable review findings; never resolve blocks, errors, or non-approvable reviews | Incorrect `approvable` classification in a future rule remains a code-review risk |
| Pull-request content gains privileged workflow authority | Evaluate in an unprivileged `pull_request` workflow; isolate the opt-in commenter in a non-executing `workflow_run`; validate, label, escape, and bound artifacts before rendering | A diagnostic comment is not authoritative and GitHub remains in the trust boundary |
| Hostile report text breaks Markdown or terminal rendering | Escape Markdown structure, HTML, links, C0/C1 controls, DEL, and bidirectional controls; cap rendered summaries and comment searches | New rendering contexts require separate escaping review |
| Agent instruction text is mistaken for enforcement | Templates state that they are advisory, fail closed on unknown outcomes, preserve host permissions, and require protected CI | A compromised or disobedient agent can ignore prompt-level instructions |
| Release tarball omits runtime code, changes dependency linkage, or includes sensitive/development files | Exact canonical dry-run and tar manifests, tar-header validation, non-symlink intermediate directories, regular non-symlink final files, size bounds, metadata locks, packed dependency validation, and entrypoint smoke tests | A reviewed allowlist can still intentionally include vulnerable code |
| Untrusted build code steals a publishing identity | Keep the build/test job credential-free; grant OIDC only to a protected job that performs no checkout, project install, project script, or package-code execution | Pinned GitHub and npm tooling remain supply-chain trust dependencies |
| A substituted or cross-run artifact is staged | Same-run artifact name binds the full commit SHA; require an exact five-file set, SHA-256 checks, strict release manifest, exact version/source identity, and an integrity-pinned npm CLI | GitHub artifact storage and runner integrity remain external dependencies |
| CI directly makes a dual-use package public | Restrict the npm trusted publisher to `npm stage publish`; require protected-environment review and separate npm 2FA promotion; store no npm token | An authorized maintainer can still approve a harmful or mistaken staged release |
| Bootstrap credentials or artifacts are misused | Permit one interactive 2FA bootstrap only for exact manually dispatched CI artifacts, core before CLI; prohibit automation tokens, rebuilds, and silent procedure changes | The first version lacks OIDC provenance and the maintainer workstation is temporarily trusted |
| Provenance is overstated | Describe provenance only as source/build linkage and explicitly record the bootstrap version's absence of attestation | Trusted publishing does not prove code is benign; npm and GitHub remain external trust dependencies |

## Native-hook threats and implementation gates

The development-only [Claude Messages fixture](adr/0018-claude-host-fixture.md)
models a bounded two-turn API exchange on numeric loopback. It emits only one
fixed harmless command, forwards nothing, and launches no process. Its phase and
client-result enums are not evidence of hook activation or command execution.
Real-host testing still requires separately verified artifact, environment,
network, settings, and independent execution/non-execution marker boundaries.
Raw fixture requests and synthetic capability bytes are not logged or reported.

The Claude lifecycle candidate implements ADR 0017 receipt-first install and
settings-first remove. Four exact paths must be ignored/untracked before any
artifact and under its owned lock. Real-filesystem no-replace probes, repeated
ownership checks, exact-byte deletion fences, and non-recursive cleanup protect
against observed collisions. Partial publication or unprovable cleanup reports
recovery rather than success; retained staging keeps its lock. This does not
eliminate same-user TOCTOU races or prove host activation. CLI process termination
can retain crash state; internal API cancellation is tested separately.

The Codex rows describe an implemented but unsupported compatibility candidate plus exact exclusion evidence. Other vendor rows remain design requirements. Installation, recovery, manual activation, and a reproducible named real-host gate must all pass for every separately claimed surface.

| Threat | Required implementation gate | Residual risk |
|---|---|---|
| Vendor hook payload bypasses the policy engine or smuggles hostile fields | The Codex edge uses a release-pinned closed schema, strict bounded JSON framing, and a versioned internal action; raw vendor objects never enter policy | Vendor schemas and tool coverage can change between versions; later adapters require independent edges |
| Hook `cwd`, policy, approvals, and manifest resolve from different roots | The Codex edge passes only the validated absolute `cwd`; the authority loader requires it to equal the discovered canonical Git root, uses only co-rooted defaults, rechecks optional absence and root identity, and rejects nested/workspace-targeted actions | PATH-selected local Git, filesystem-specific identity quality, unsupported path aliases, and same-account races remain in the boundary |
| Ambiguous or unauthenticated-dialect shell text is treated as a safely analyzed dependency add | Record Codex input as restricted `portable`, not an inferred shell; reject percent, caret, exclamation, wrappers, composition, ephemeral execution, and unsupported install-like forms; evaluate only the fixture-backed direct npm/pnpm add grammar | Unknown target-shell constructs, scripts, child processes, manual terminals, remote environments, or unhooked tools can still conceal dependency operations |
| AgentHawk's allow bypasses host permissions or a warning disappears | Serialize allow as neutral; use a tested visible neutral warning channel or deny warn for review; never emit vendor auto-allow or rewritten input | The host may independently allow the command under its own policy |
| Hook failure, serializer failure, or timeout becomes an advertised fail-closed control | The Codex edge creates the shared eight-second deadline before input, disposes it after output, uses bounded framing and normal serialization, and has an independent constant non-empty exit-2 denial. The harness settles started work. Later edges require equivalent proof; document vendor timeout behavior and require Cursor `failClosed: true` | Filesystem cancellation is best effort, remote provider computation and universal process-tree termination are not guaranteed, and a process that cannot start, a host timeout, or a bypassed hook can still proceed; protected CI remains final |
| Hook input or diagnostics disclose commands, prompts, paths, transcripts, or credentials | Read only bounded event/tool/command/cwd fields; keep raw commands transient; use fixed redacted reason codes; exclude sensitive fields from reports, digests, stdout, and stderr | The host itself supplies the hook environment and can log outside AgentHawk |
| Repository or user hook is described as tamper-proof policy | Record `project`, `user`, `managed`, or `unknown` as a non-authoritative deployment declaration and state each tier's limits | A user or repository writer can disable mutable hooks; managed deployment still depends on host and binary integrity |
| Setup overwrites a foreign hook, trusts itself, or removal deletes changed configuration | Use only fixed project targets, a strict paired receipt, exclusive no-replace publication, receipt-first install, hook-first removal, identity fences, bounded redacted states, and no merge/adopt/force/trust write; prove interruption recovery before support | A same-account or repository writer can still mutate the hook, receipt, runtime, package, or Codex settings after a check |
| A copied or replayed receipt is treated as ownership in another repository | Bind the generated hook and strict path-redacted receipt to one 256-bit installation identifier plus the canonical root and exact bigint identity through a fixed length-framed digest; verify the pair again at invocation before declaring project trust | The binding is not a secret or authentication against a same-account writer; repository moves intentionally require recovery |
| Status follows a linked/aliased/changed target, leaks private state, or confuses artifact readiness with host activation | Observe only fixed contained targets twice; reject links, hard links, unexpected types, aliases, oversize content, identity/size changes, malformed closed records, and root-binding/hook/settings/digest mismatch; derive at most one staging target from a canonical lock; emit only bounded ownership/readiness/aggregate-ignore/blocker enums and keep activation explicitly unproven | Portable Node APIs cannot atomically exclude every parent race, Windows reparse type, bind mount, or hostile/network filesystem behavior; a local writer can mutate state after the snapshot |
| A linked worktree receives a hook file that the pinned Codex host does not load | Detect and reject linked worktrees before mutation; Codex 0.149 redirects project hooks to the root checkout while AgentHawk treats the worktree as an independent authority | Future Codex behavior can change; coordinated root-checkout installation needs a separate ownership decision |
| A vendor without neutral output forces AgentHawk to auto-allow, or a cloud surface hides warnings/provider failure | Keep Cursor unsupported until a real fail-closed harness proves neutral no-auto-approve output; treat Copilot cloud npm/OSV reachability as unavailable until administrator-enabled and tested; deny warnings without a visible neutral channel | Vendor contracts, enterprise firewall policy, and cloud UX can change independently |
| Claude settings run under inherited trust or dialog-free programmatic mode | Treat project hook configuration and every payload/environment value as hostile; [ADR 0016](adr/0016-claude-project-hook-ownership.md) permits only fixed-target repository status and requires activation `unproven`; prove current-folder and inherited parent trust separately from dialog-free `-p`/SDK before any support claim | A repository writer can replace the hook or settings, and a hook executes with the user's operating-system authority |
| Machine-local Claude settings, receipt, or crash-recovery artifacts are accidentally published | Before mutation and again under the operation lock, require quiet shell-free Git ignore and untracked proof for the exact local-settings, receipt, lock, and operation-ID staging targets; block removal too until failed ignore/tracking proof is restored; retain no exclude pattern, source path, or Git output; never edit ignore sources | Git may consult user-global exclude configuration; a user can force-add an ignored file, or exclude configuration can change after the point-in-time check |
| A Claude lifecycle overwrites foreign settings or loses ownership state during interruption | [ADR 0017](adr/0017-claude-project-hook-transaction.md) forbids merge/adoption, requires a strict root-bound receipt, actual-filesystem no-replace capability proof, receipt-first publication, settings-first removal, exact-byte deletion, and explicit post-linearization recovery states | Portable Node filesystem APIs cannot prove immunity to every same-account race, reparse type, network-filesystem behavior, or power loss |
| A copied or drifted Claude settings/receipt pair is treated as an active trusted gate | Bind the installation identifier, canonical root identity, exact generated bytes, launch arguments, and packaged adapter in a closed receipt; the implemented invocation verifier uses matching bounded identity-fenced snapshots, rejects any operation lock, recomputes current artifacts, and denies before providers on mismatch; retain activation `unproven` | Root binding is not authentication, a same-account writer can replace runtime bytes, and higher-authority or selected settings can suppress the project hook |
| Claude reads a different project-local settings file than AgentHawk's root-fixed candidate | Require exact canonical-root startup for the first candidate and independently test Windows, POSIX, nested starts, linked worktrees, SDK, IDE/desktop, and bare/excluded-source modes before any support row changes | Current host rules keep local settings with shared settings on Windows and other exceptional layouts, redirect linked worktrees to the main checkout root, and may retain older or SDK-resolved starting-directory files additively |
| Bash-only coverage is generalized to Windows PowerShell | Match canonical `Bash|PowerShell`, preserve distinct dialects, and keep PowerShell dependency admission unsupported until a separate restricted grammar and exact-host row pass | Alternate tools, aliases, scripts, or shells that do not reach a proven hook remain bypasses |
| Claude command-hook infrastructure failure is described as fail closed | Prove structured denial and exit-2 emergency denial, but document that missing executable, startup failure, non-2 error, malformed output, and host timeout continue to normal permissions; retain protected `scan`/`diff` CI as the final gate | An unavailable hook can allow the host to proceed under its own policy |
| Parallel sibling hooks or direct shell mode bypass the intended stop | Prove no alternate shell tool or direct `!` path bypasses `PreToolUse`; disclose that all matching hooks run in parallel and AgentHawk cannot prevent sibling side effects | Vendor execution order and future tool surfaces can change; a sibling hook can act before denial is known |
| Claude hook environment exposes credentials or repository secrets | Ignore the complete environment and emit no captured values; enable documented subprocess credential scrubbing in the real-host matrix and prove fake credential sentinels are absent | The documented scrub covers named credential classes, not arbitrary secrets or host-side logging |

## Unsupported claims

A successful provider result does not mean a package is safe, benign, maintained, uncompromised, or free of vulnerabilities. It means the configured registry returned a validated metadata shape for the selected coordinate at evaluation time.

A native hook does not mean AgentHawk intercepts every dependency operation, cannot be bypassed, is tamper-proof, or fails closed on every host failure. It can deny only recognized actions that reach a supported, enabled hook under the documented deployment and host-version boundary.
