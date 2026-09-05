# Implementation plan

Date: 2026-08-20

## Current state

### Implemented slice: Claude host isolation contract (ADR 0019)

Scope: a pure development-only Linux container launch/inspection contract,
explicit minimal Claude environment, closed marker stimulus, and a conservative
host-evidence reducer. No real process launch or activation claim in this slice.
Expected files: `scripts/claude-host-contract.mjs`, `scripts/claude-host-evidence.mjs`,
their adversarial tests, the existing Messages fixture/tests, coverage inventory,
ADR 0019, and these public
state/threat-model notes. No new dependency. Test changed/missing isolation fields,
inherited credential/path injection, fixed command boundaries, false evidence and
cleanup failure; run the full gate and exact-head independent review. Rollback is
a new revert commit. Container preparation and bounded real-host execution follow
this prerequisite; all native support rows remain unsupported.

Local validation on 2026-09-05 UTC passed lint, typecheck, 1,910 tests (5 skipped),
coverage, build, offline package verification, CLI smoke, and dependency audit.
Aggregate coverage is 93.63% statements, 91.23% branches, 96.76% functions, and
95.84% lines. The three development modules pass 749 focused tests; both new
contract/reducer modules have 100% statement/branch/function/line coverage.
Independent review identified implicit image-pull and unstable property-read
hazards. The create vector now prohibits pulling, and bounded descriptor-only
snapshots bind validation to consumption; regression tests cover both fixes.
Working-tree re-review found no remaining blocker. Exact-head PR review and CI
remain delivery gates. No actual Claude/container execution has occurred.

CI gate correction: Windows Node 22 coverage exceeded the existing 20-second
budget in one test containing two independent full lifecycle fixtures. Split the
hook-replacement and inactive-receipt-replacement scenarios into separate tests,
preserving their assertions and the existing per-test timeout. This follows
[Vitest's test boundary](https://vitest.dev/api/test#timeout), checked 2026-09-05;
it changes neither production behavior nor security deadlines. Require both
focused scenarios, the full local gate, renewed exact-head review, and all CI
jobs before delivery. No retries, skips, or threshold relaxation are added.

A subsequent Windows Node 24 coverage run timed out in the old-pair removal
case, then reported a busy temporary root during cleanup. Three isolated
diagnostic runs passed; the original stalled operation remains unidentified.
Keep this repair test-only: construct the removal fixture with the production
artifact builder, prove `owned_exact/current` with real status, and retain actual
removal with the combined artifact-drift/shared-hook conditions and preservation
assertions. Full installer integration tests remain unchanged. Bound fixture Git
execution and refuse cleanup after test cancellation rather than deleting state
an unfinished body might still use; a poisoned fixture module must fail visibly.
[Vitest cancellation](https://vitest.dev/guide/test-context#signal) is cooperative,
not proof of process quiescence. Preserve existing test deadlines and all quality
thresholds; require focused regressions, renewed full gates, and exact-head review.
The sequential cleanup fence has 14 adversarial tests with 100% targeted coverage.
All 1,910 tests pass in the complete test and coverage runs; existing aggregate
coverage thresholds remain unchanged. The original CI stall is not classified as
a product defect or a proven infrastructure failure.

### Implemented slice: Claude host-evidence fixture foundation (ADR 0018)

Implement only the bounded, loopback-only Messages fixture needed by the next
real-host driver. The fixture produces one fixed harmless Bash tool call and
accepts one structurally matched client result, with separate bounded token-count
and connection-probe endpoints. It neither launches Claude nor changes settings,
trust, credentials, policy, package contents, or support. Expected files are one
development script, its adversarial test suite, the coverage inventory, ADR 0018,
and the roadmap/threat-model notes.
Acceptance: bounded bodies/headers/requests/connections/time; fatal UTF-8;
fixed output with no raw data retention; rejection of reordered, concurrent,
replayed, malformed and extra inference; clean cancellation; full quality gate
and independent exact-head review. No new dependency. Rollback is a normal revert.
Actual host artifact, isolation, marker and activation evidence remain separate.

Gate correction discovered during this slice: two existing approval tests omitted
their OSV stub and attempted a live query. Supply the existing deterministic empty
OSV fixture to both; retain strict provider-failure behavior in product code and
assert successful terminal approval explicitly. This is a test-only prerequisite
to a network-independent full gate, not an approval-policy change.

Local validation on 2026-09-05 UTC passed lint, typecheck, 1,271 tests (5 skipped),
coverage, build, offline package verification, CLI smoke, and dependency audit.
Aggregate coverage is 93.40% statements, 90.55% branches, 96.64% functions, and
95.69% lines. The fixture's 125 adversarial tests cover its bounded protocol and
failure paths; fixture coverage is 98.65% statements and 100% branches. Independent
working-tree review found and verified fixes for HTTP expectation and transfer
framing defects, then reported no remaining blocker. Actual Claude activation and
support remain unproven; the next implementation slice is the isolated driver.

### Delivered repair: initialization rollback content fence

Post-merge Windows Node 24 CI for PR #57 reported a replacement-file cleanup
failure. Identity-only removal also demonstrably removes in-place changed bytes.
Scope: require bounded exact-content verification as well as identity before
removing tracked initialization files, including staging and lock files. Preserve
unknown partial writes and report unconfirmed cleanup. Acceptance: same-size
mutation and replacement regressions preserve owner bytes, ordinary rollback
still succeeds, and the full gate and independent review pass. No host-support
or release change. Rollback is a new revert commit; never delete retained files
automatically. Isolated Claude host evidence follows this repair.

Local coverage validation on 2026-09-04 passed 1,146 tests (5 skipped), with
93.11% statements, 90.09% branches, 97.08% functions, and 95.50% lines. The
focused initialization suite passes 55 tests, including partial-write preservation.
Independent review approved `456aa7f`; all nine PR checks passed. PR #58 merged
as `cdd7683`, and all post-merge workflows passed. The checkout and remote main
were verified against that merge before beginning the next slice.

### Documentation reconciliation after PR #56

Scope: reconcile the support matrix, lifecycle ADR, roadmap, and this plan with
the merged source and CI evidence. Acceptance: installation and removal are
described as implemented; status includes ownership and readiness; published
alpha packages remain distinguished from development commands; host activation
and native support remain unproven. This changes documentation only. Verify
claims against the production commands and PR #56, run the required quality
gate, and obtain independent review. Rollback is a revert of this documentation
commit. The next implementation slice remains isolated Claude host evidence.

### Implemented slice: Claude project-hook transaction (ADR 0017, slice 4)

Scope: explicit `integrations claude install|remove`, fixed root-only targets,
receipt-first publication and settings-first removal. Reuse the existing
canonical format and status boundary; no host activation or support claim.
Before delivery, prove all four exact paths ignored and untracked before any
artifact and under the exclusive lock; reject aliases and changed identities;
probe real no-replace publication; preserve changed bytes during cleanup; test
cancellation, partial publication, removal after artifact drift, and retained
recovery locks. Add closed lifecycle reports, packed-consumer proof, current
public guidance, full quality gates, and independent exact-head review.
Rollback is a new revert commit; retained machine-local state requires the
documented exact-ownership remove/recovery workflow, never recursive deletion.

Local validation on 2026-09-03 passed lint, typecheck, 1,140 tests (5 skipped),
coverage (93.10% statements, 90.07% branches, 97.08% functions, 95.52% lines),
build, packed-consumer verification, CLI smoke, dependency audit, diff checks,
and the staged-file secret scan. Independent review found and resolved partial
publication and ambiguous-staging recovery blockers. PR #56 received independent
approval for `89c85d2` and all nine PR checks passed. It merged as `1f6fd02`;
all post-merge workflows passed. The next dependency-ordered slice is isolated Claude
real-host activation evidence, with support remaining explicitly unproven.

Packaging review: the two allowlisted emitted transaction files plus contract
and CLI wiring raise the observed CLI unpacked size from 309,997 to 350,162
bytes. The narrow ceiling moves from 312,000 to 352,000; exact manifest/tar,
dependency, path, and consumer checks remain unchanged.

The repository began empty except for Git metadata; `AGENTS.md` and Milestone 0 research were the first tracked material. All fifteen alpha milestones below are complete: the public alpha implements `check npm`, `scan`, and `diff` with npm/OSV evidence, deterministic policy, approvals, cache/offline behavior, GitHub Action integration, agent templates, hardened JSON contracts, exact package artifacts, and trust-separated staged publishing. The public remote is `https://github.com/nafiyad/AgentHawk`. Both `0.1.0-alpha.1` packages were published from the exact approved CI artifacts and are protected by stage-only trusted publishing for subsequent versions.

## Assumptions and constraints

- Node.js 22 or 24 LTS and pnpm workspaces; TypeScript strict mode. Node 20 reached upstream end-of-life on 2026-03-24 and is no longer an accepted security baseline.
- npm public registry and OSV are the only required remote providers for alpha.
- No package installation or package-code execution occurs during evaluation.
- No telemetry, hosted backend, database, account, secret ingestion, or LLM verdicts.
- Tests use fixtures/local HTTP servers and run without network access.
- Security-sensitive unknown configuration fields fail validation.

## Architecture

`packages/core` owns validated domain types, normalized providers, policy/rules, verdict precedence, approvals, digests, and report schema. `packages/cli` owns argument parsing, orchestration, rendering, and exit codes. External data crosses provider interfaces only. Native `fetch` is wrapped by one bounded client. Pure rule functions make the decision path deterministic and testable.

Initial development dependencies: TypeScript, Vitest/coverage, Biome, and tsup. Candidate runtime dependencies: Zod for strict runtime schemas, `yaml` for policy/approval files, and Commander for CLI parsing. Each is mature and replaces security-sensitive bespoke parsing; versions will be pinned in the lockfile and reviewed when introduced.

## Milestones and acceptance criteria

1. **Research**: five research documents plus this plan; sources and claims reviewed; no core code.
2. **Foundation — complete**: strict workspace, CI, core/CLI packages, domain/report/config skeleton; lint/typecheck/test/coverage/build green.
3. **npm input/provider — complete**: safe spec parser, normalized metadata provider, bounded HTTP client, hostile/error fixtures.
4. **Policy engine — complete**: strict policy, precedence, PG001-007/013/015, complete positive/negative tests.
5. **CLI check — complete**: terminal/JSON, strict mode, policy path, stable errors/codes, smoke tests.
6. **OSV evidence — complete**: version-aware query and records, PG010/011, batch-ready contract.
7. **Approvals — complete**: exact match/expiry/reason, preserved findings, non-overridable malicious block.
8. **Cache/offline — complete**: public metadata only, provider-specific TTLs, strict bounded schema, safe hashed keys, staleness/corruption handling, `--offline`, `--no-cache`.
9. **Scan/diff — complete**: bounded root direct dependency inventory, additions/version/section changes, PG014 lockfile correlation, argument-array Git, temporary-repository tests.
10. **GitHub Action — complete**: read-only pull-request evaluation, safe bounded summary/artifact, isolated opt-in idempotent comment.
11. **Agent templates — complete**: Codex/Claude/Cursor/generic fail-closed instructions with an explicit advisory trust boundary.
12. **Alpha contract hardening — complete**: strict exported schemas for every JSON report family, one versioned failure envelope, compatibility documentation, and golden contract tests.
13. **Release-readiness foundation — complete**: offline package-content validation, consumer-facing package documentation/licenses, changelog, metadata, and an explicit publication lock pending ownership decisions.
14. **Alpha acceptance audit — complete**: implementation-to-test acceptance matrix, current architecture/threat boundaries, publication blockers, and explicit deferred scope.
15. **Release workflow — complete and bootstrapped**: paired public alpha packages, shared runtime version, persistent dual-use disclosure, exact real-tarball verification, checksummed CI artifacts, completed one-time interactive bootstrap, restrictive package access, and an isolated protected OIDC job limited to npm staging.

Every milestone updates docs, reviews its diff, runs focused tests and the full available quality gate, scans staged content for secrets, commits, pushes, and verifies the exact remote head.

## Test strategy

Use table-driven unit tests for parsing/rules/precedence/approvals/digests/escaping/redaction. Use local mock servers for HTTP limits, timeouts, redirects, 429, malformed/oversized JSON, and full CLI flows. Use temporary Git repositories for diff mode. Add explicit regression tests proving no package manager execution, `shell: true`, auth/environment logging, wildcard/expired approvals, or implicit allow on provider failure. Core statement and branch coverage must reach 90% before alpha.

## Security and migration risks

- Provider schemas/semantics drift: validate a small normalized subset and fixture failure paths.
- False confidence: precise product language and visible evidence limitations.
- False positives: configurable thresholds and exact expiring approvals.
- CLI/report compatibility: schema versioning and golden integration tests.
- Dependency compromise in AgentHawk itself: minimize runtime dependencies, pin the lockfile, disable lifecycle scripts, separate build from OIDC authority, and use integrity-pinned stage-only trusted publishing.
- Future action shields: preserve clean core boundaries; do not generalize until requirements exist.

No migration exists for the empty repository. Once public APIs ship, incompatible changes require a schema/version migration plan and changelog.

## Expected files

Milestone 1 adds root workspace/build/test/lint configuration, `.github/workflows/quality.yml`, `packages/core`, `packages/cli`, report/config documentation, README, license, contribution/security/community files, and initial ADRs. Later milestones add only the packages and documentation required by their acceptance criteria.

## Rollback

Milestones are isolated commits. A defective unreleased milestone can be reverted with a new commit; public history is never rewritten. Published npm versions are immutable and must be remediated with a reviewed new version or, when necessary, a visible deprecation rather than an attempted overwrite. Provider features remain behind interfaces so a failing provider can be disabled by an explicit policy/version change without weakening other evidence silently.

## Open questions

[ADR 0014](adr/0014-codex-support-scope.md) keeps every native row unsupported. Codex CLI `0.149.0` on local standard-user Windows remains the first eligibility target with the production project-hook lifecycle, default-disabled Code Mode paths, the named `shell_command` surface, and the existing sandbox/policy boundary. Its local exact-artifact matrix covers unrelated zero-provider behavior, an allowed fake-package-manager marker, visible warn denial, distinct review/block denial, strict required-provider `error` denial, malformed/emergency denial, exposed-tool-set binding, exact removal, per-host live timing, and controlled nearest-rank p95 measurements for unrelated qualification, fresh cache hits, and loopback live evidence. Provider fixtures are loopback-only through a harness-owned Node preload; the host never receives credentials, real provider responses, or package code.

The CLI matrix harness remains development-only and receives no credentials. It must install the project hook through the production transaction, use the pinned app-server protocol only to discover and persist trust for that exact listed key/current hash, close that protocol process, and then exercise every outcome through ordinary `codex exec` launches without the broad hook-trust bypass. A harness-only Node preload redirects the hook process's npm/OSV `fetch` calls to a bounded loopback fixture; the fixture rejects every other destination and records exact per-scenario counts, so the named run is deterministic and cannot contact the public registry or OSV. Codex's own model traffic remains on its separate loopback Responses fixture. Scenario commands use only bare `npm add <exact-registry-spec>` with a fake `npm.cmd` first on the isolated PATH; allow must create only its exact marker, while warn/review/block/error must expose the expected bounded AgentHawk reason and create none. The checksum-pinned GitHub-hosted Windows workflow receives no secrets, uploads no artifact, and positively asserts the exact restricted-token split-writable-root rejection, true neutral-marker absence, zero provider traffic, and removal instead of pretending that environment can run the local matrix. A future support gate requires a fresh standard-user runner and must keep the adapter unsupported if any matrix, tool inventory, lifecycle, cleanup, or latency assertion fails.

The completed managed-only evidence slice is restricted to a fresh GitHub-hosted Windows VM and the pinned official Codex `0.149.0` archive. It refuses a self-hosted or non-Windows runner, verifies the archive SHA-256 and exact CLI version, proves exact project-hook discovery before changing policy, refuses a pre-existing machine requirements path, writes only the exact `allow_managed_hooks_only = true` policy, verifies the requirement through the app-server protocol, proves an empty warning-free hook inventory and zero fixture traffic, and removes only unchanged job-created state in a `finally` path. The workflow has `contents: read`, receives no secrets, uploads no artifact, and does not establish desktop, IDE, Remote, cloud, Linux, macOS, or other-version support. Official GitHub documentation for fresh hosted VMs, Windows administrator execution, and `RUNNER_ENVIRONMENT`/`RUNNER_OS` is the public authority for the isolation preconditions.

There are no unresolved design questions for the first public alpha. The exact-artifact bootstrap, npm scope ownership, restrictive package access, stage-only trusted publishers, and protected GitHub environment are complete; [release operations](releasing.md) records the evidence and remaining provenance limitation. Public feedback must inform any next-version scope change.

Post-alpha work is sequenced in the evidence-backed [product roadmap](roadmap.md). That document starts at Milestone 16 and defines the research prerequisites, dependencies, security gates, measurable exit criteria, and explicit exclusions for each proposed phase. This implementation plan remains the historical source of truth for the completed first-alpha milestones.

Milestone 16 is complete. Its reviewed slices add `policy validate`, `approvals verify`, the Node 22/24 six-platform quality matrix, strict minimum-disclosure `doctor`, and collision-safe `init` with canonical policy discovery and packaged deterministic assets. Milestone 17's research gate is recorded in [ADR 0012](adr/0012-native-hook-enforcement-boundary.md) and the extended threat model. The vendor-neutral slices add strict bounded action/decision v1 schemas, pure restricted registry-only npm/pnpm add qualification, typed redacted cancellation, co-root repository authority, and an adapter-neutral aggregate evaluation harness. The harness uses one fixed eight-second deadline, loads authority once, deduplicates exact coordinates, evaluates at most eight operands through two workers, preserves original order, combines verdicts deterministically, and settles all started work before returning. The Codex `PreToolUse` edge has strict framing, golden fixtures, bounded serialization, an outermost exit-2 denial, and packed-consumer evidence. Its complete local exact-artifact matrix passes, while the pinned GitHub-hosted Windows environment rejects the restricted-token split writable-root projection before execution; [ADR 0014](adr/0014-codex-support-scope.md) therefore keeps every native row unsupported.

[ADR 0015](adr/0015-claude-code-hook-edge.md) records the vendor research gate and original zero-argument fixture boundary. The behavior in this paragraph describes that fixture mode; project-argument invocation is described below. The dedicated `agenthawk-claude-pretooluse` binary accepts one 64 KiB fatal-UTF-8 object, rejects duplicate keys, trailing values, unknown fields, invalid types, relative/control-bearing paths, and over-bound identifiers, commands, descriptions, and timeouts. Current permission modes including `auto` and the optional bounded effort level are validated and discarded. It maps exact `Bash` to `posix` and exact `PowerShell` to `powershell`, retains only the command and untrusted action directory, fixes deployment trust to `unknown`, and ignores the environment. Neutral decisions produce exit `0` and zero stdout bytes; ordinary denials produce only the bounded documented deny object and exit `0`; framing or internal failure produces one fixed redacted stderr line and exit `2`. Golden, adversarial, process, deadline, no-provider, package-policy, startup, and packed-consumer tests are required acceptance evidence. In zero-argument fixture mode, the binary does not inspect or mutate Claude settings and creates no host compatibility or support claim. ADR 0016 completes the collision/ownership design, and its read-only preflight status slice is now implemented.

[ADR 0016](adr/0016-claude-project-hook-ownership.md) established the original read-only collision preflight. ADR 0017 and the subsequent merged slices extended it with a root-bound receipt, ownership and artifact-readiness classification, and explicit installation/removal. The current status command observes fixed settings and ownership artifacts through matching bounded snapshots, reports aggregate ignore and configuration blockers, writes nothing, and contacts no providers. Activation remains `unproven`; shared settings and foreign local settings are never adopted or merged. The lifecycle and receipt-aware status paragraphs below describe current behavior.

[ADR 0017](adr/0017-claude-project-hook-transaction.md) completes the next lifecycle design gate without adding mutation. It fixes canonical generated local-settings bytes, a path-free root-bound receipt, exact ownership/readiness states, invocation-time verification, fixed lock and staging targets, capability-tested no-replace publication, receipt-first install, settings-first remove, cancellation linearization, bounded recovery, and the continuing activation/support boundary. Implementation remains dependency ordered: pure format and known vectors; invocation verification; receipt-aware status; install/remove transaction; then exact-host matrices and a separate support decision. The first four implementation slices are delivered; PR #56 completed transaction review and CI gates. The pure-format slice adds deterministic compact settings and receipt serialization, CSPRNG installation identifiers, length-framed root-binding and launch-vector digests, strict canonical fatal-UTF-8 parsing, fixed Windows/POSIX artifact vectors, and hostile boundary tests for identifiers, bigint identity, paths, controls, duplicate or unknown data, path redaction, and independent digest drift. It adds no command, filesystem observation or mutation, provider access, activation evidence, or native support claim. Invocation-time verification is also complete as the next paragraph records.

The invocation-verification slice is complete and remains limited to the existing Claude fixture binary and the exact six project launch arguments fixed by ADR 0017. It parses and bounds stdin before touching repository state, re-establishes canonical repository authority from the validated `cwd`, verifies the canonical receipt and exact local-settings pair through matching bounded identity-fenced snapshots, recomputes root binding and current Node/adapter readiness, rejects any operation lock, and only then evaluates with deployment trust `project`. Zero arguments retain the existing `unknown`-trust fixture behavior; every other argument shape, unsafe or changing filesystem observation, receipt/settings mismatch, root or artifact drift, cancellation, or unavailable verification emits only the constant exit-2 emergency denial and makes zero provider requests. Deterministic unit, child-process, and packed-consumer tests cover the exact pair, wrong root/identity/identifier/binding, missing/modified/noncanonical/oversized/invalid-UTF-8 files, hard links, changing snapshots, operation locks, adapter/runtime drift, malformed launch arguments, provider suppression, deadline disposal, and packed-package startup. This slice adds no mutation command, activation proof, or support claim.

The receipt-aware status slice is complete. It extends the existing read-only Claude report with closed ownership and readiness enums plus one aggregate integration-ignore state. Matching identity-fenced snapshots now include the canonical receipt, operation lock, and only the staging directory derived from a valid lock identifier. Status validates root binding and exact settings bytes, recomputes current Node/package/adapter/launch artifacts, keeps ownership stable across artifact drift, suppresses readiness when shared hooks or linked-worktree topology prevent a claim, and treats malformed locks as blocking and staging-unknown. The report never emits paths, settings, identifiers, bindings, digests, ignore sources, or parser detail; activation stays `unproven`. No provider is contacted and no file is changed. The implemented transaction slice adds install/remove and actual-filesystem no-replace capability tests; see the acceptance criteria and local validation above.

The shipped CLI now contains the receipt-aware status implementation and its generated declarations. Its deterministic unpacked size increased from 297,902 to 309,997 bytes, so the package-policy ceiling moves narrowly from 300,000 to 312,000 bytes while the exact allowlist, dependency, entry-point, file-mode, symbolic-link, and archive-content checks remain unchanged.

The completed Codex edge slice is limited to the release-pinned `PreToolUse` `Bash` command-hook shape and a deliberately restricted `portable` lexical grammar because the payload does not authenticate the target shell. Its acceptance criteria are: a dedicated binary with no Commander pre-processing; one 64 KiB fatal-UTF-8 JSON object with duplicate-key, trailing-value, unknown-field, type, identifier, path, and command bounds; an eight-second deadline created before input reading and disposed only after output; conversion to the existing action contract with deployment trust fixed to `unknown`; zero stdout bytes and exit `0` for neutral; one bounded documented denial object and exit `0` for ordinary denial; one constant non-empty redacted stderr line and exit `2` for framing, evaluation escape, or serializer failure; no host allow, ask, input rewrite, raw command, path, transcript, model, session, or environment output; golden and adversarial fixtures; no-provider unrelated proof; timeout and quiescence proof; process and packed-package consumer tests. The adapter does not infer dialect from the local OS; shell-specific syntax is denied and unknown shell constructs remain residual. Support decisions are made per exact named host surface; no result is generalized to a different operating system, client, execution environment, deployment authority, or version. Installation remains an explicitly requested compatibility-candidate operation; public guidance retains unsupported status under ADR 0014.

The completed development-only real-host compatibility slice runs an explicitly supplied Codex `0.149.0` executable against a loopback-only deterministic Responses fixture, an isolated temporary Git repository, and an isolated temporary `CODEX_HOME`; it does not read or modify the maintainer's Codex configuration, authentication, transcripts, or hook trust store. The harness verifies the executable version, uses a temporary user hook with the one-invocation trust bypass documented for vetted automation, exercises a neutral command and a denied install-like command, proves the neutral tool result succeeded, proves the denied fake-package-manager marker is absent, rejects non-loopback providers and unexpected fixture traffic, bounds every child process, redacts captured output, and cleans up temporary state. Unit tests may use a fake Codex process, but support claims require separately recorded exact-artifact evidence. This earlier temporary-user-hook result supplements but cannot replace ADR 0014's project-hook matrix. Local CLI evidence does not establish remote, desktop, IDE, cloud, or other-version support; those surfaces require independent decisions.

The Windows sandbox repair is complete in the development harness. Official Codex documentation distinguishes the preferred elevated sandbox from the weaker but supported unelevated fallback. Exact `rust-v0.149.0` source shows that omitting `windows.sandbox` leaves the backend disabled; under a managed filesystem policy, an unmatched command then requires approval and `approval_policy = "never"` rejects it before execution. The cached PowerShell path in the original failure was therefore incidental, not evidence that PowerShell itself was unreadable. The harness now configures `windows.sandbox = "unelevated"` only inside the temporary Windows `CODEX_HOME`, retains `workspace-write`, `approval_policy = "never"`, and the host's ordinary permission flow, explicitly disables sandbox network access, excludes environment and slash temporary directories from implicit writable roots, and leaves non-Windows host selection unchanged. The exact config tests and real `0.149.0` Windows CLI run prove both neutral repository execution and denied fake-package-manager non-execution. This local CLI result must not be generalized to desktop, IDE, remote, cloud, elevated-sandbox, managed-requirements, or other-version support; ADR 0014 keeps the project-hook row unsupported until it is reproducible on a fresh standard-user runner.

The Linux CLI evidence-hardening slice is implemented. The development harness remains vendor-artifact-neutral and accepts only an explicitly supplied absolute executable. It replaces the non-Windows `/usr/bin/true` observation with an exact repository-local regular-file marker, reports distinct Windows, Linux, and macOS surface identifiers, and rejects unknown operating-system values instead of inheriting a generic Unix claim. Unit tests cover platform-to-tool/surface selection, marker shape, symbolic-link rejection, and the requirement that marker evidence exists independently of host-reported status. The named Docker attempt used the official integrity-verified `0.149.0-linux-x64` artifact, but Codex's bundled `bwrap` could not create its sandbox namespace under Docker's default container boundary. The absent marker correctly failed the run. No privileged container, extra administration capability, disabled seccomp, danger-full-access, or external-sandbox bypass was used. Linux remains unproven. The later exact-version local app-server stdio harness is complete and remains a separate Windows-only protocol result; it does not imply IDE, desktop, Remote, cloud, or Linux support.

The scoped local app-server slice is complete against Codex tag `rust-v0.149.0` (commit `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`). The development-only `stdio://` compatibility harness starts a fresh process and temporary `CODEX_HOME` for each scenario, speaks bounded fatal-UTF-8 newline-delimited JSON, verifies the isolated home, inventories exactly the expected temporary hook, trusts only its listed key and current hash through `config/batchWrite`, and drives the hook exclusively through model-originated `thread/start` and `turn/start`. It rejects server requests, approval requests, malformed or oversized protocol output, unexpected hooks and provider traffic, hash changes, weak sandbox/effective-thread settings, missing matching hook notifications, and incomplete process cleanup. Adversarial protocol/process tests pass, and the exact official Windows artifact passed independent regular-file marker proof for neutral execution plus blocked-hook and absent-marker proof for denial under the loopback-only provider. The harness never uses `thread/shellCommand`, `command/exec`, `process/*`, danger-full-access, approval bypasses, or the undocumented broad hook-trust bypass. This establishes only `local-app-server-windows-stdio-shell-command`; it does not establish the VS Code extension, desktop app, Remote, cloud, Linux, macOS, managed requirements, or another version.

[ADR 0013](adr/0013-codex-project-hook-ownership.md) now accepts the separate project-hook ownership boundary. The root-bound hook/receipt format, `agenthawk integrations codex status|install|remove` lifecycle, and temporary exact-version project-hook activation harness are implemented. The harness uses an isolated `CODEX_HOME`, temporary Git root, loopback-only fixture provider, fake package-manager marker, and the real collision-safe installer. Against the checksum-verified official Windows `0.149.0` package it proves installed-untrusted discovery, exact-definition trust, neutral execution, dependency-add denial, mutation to Codex `modified` plus AgentHawk `owned_modified`, and feature-disabled empty discovery with zero provider traffic. A separate disposable GitHub-hosted Windows gate now proves the same exact project hook is present before policy and suppressed with zero provider traffic when the shipped artifact loads `allow_managed_hooks_only = true` from its machine-wide known-folder requirements file. The transaction uses atomic no-replace publication and identity-fenced cleanup and never touches workstation policy. It does not write trust on a user's behalf, execute a package manager, or promote the candidate to supported enforcement. User, managed, plugin, session, portable committed, other-version, other-surface, and other-vendor installation remain deferred.

The root-bound artifact-format prerequisite is implemented. The repository-authority result now carries its already verified bigint `dev`/`ino` identity without serializing it into reports. The pure Codex formatter uses 32 OS-CSPRNG bytes rendered as canonical lowercase hex, a domain-separated and 64-bit-length-framed root binding with a fixed known vector, canonical LF JSON, a closed path-redacted receipt, exact hook/definition/launch/adapter digests, explicit synchronous `PreToolUse` configuration, bounded POSIX and named Windows PowerShell commands, and strict fixed-order launch-argument parsing. Tests cover identifier alphabets and identity bounds, repository move/replacement binding, independent adapter drift, hostile quoting/control rejection, strict receipt fields, deterministic bytes, size caps, and malformed/reordered launch declarations. The package-content allowlist includes only the new emitted formatter module. No hook is written, trusted, enabled, or described as supported by this prerequisite.

Read-only `agenthawk integrations codex status` is complete. It uses one canonical Git-layout snapshot, observes only ADR-owned fixed files and parents through bounded identity-fenced reads, classifies seven ownership states independently from current-artifact readiness and blockers, emits path/content/hash/identifier-free reports, and performs no write, provider call, package execution, or network access.

The completed lifecycle slice is the smallest coherent mutation boundary: `agenthawk integrations codex install|remove` plus invocation-time verification of the published root-bound pair. Install-only is excluded because interruption after receipt publication can leave `owned_inactive`, whose safe automated recovery is `remove`; publishing before the adapter can verify the receipt, hook, launch declaration, repository authority, and current artifacts would create a configuration that the project-trust claim cannot justify. The implementation acquires and identity-checks one exclusive fixed lock; re-establishes authority, Git topology, parents, and targets under that lock; retains but never owns created parent directories; creates canonical synced stage files in one exclusive fixed-name staging directory; capability-tests same-volume hard-link no-replace behavior on the current filesystem; publishes receipt first and hook second; deletes an exact hook first and receipt second; implements the ADR cancellation linearization and bounded recovery states; and reclassifies final state before releasing the exact owned lock. It refuses foreign locks, linked-worktree installation, configuration collisions, aliases, links, unsupported types, target appearance, unowned/modified/colliding state, and unproven publication behavior without merge/adopt/force/repair/trust flags. Removal remains possible for exact or inactive owned state despite current artifact drift or configuration collision. Acceptance includes fault injection at every creation/publication/deletion boundary, two-installer contention, adversarial filesystem identities, packed install/status/invoke/remove proof, six-job OS/Node CI, the full quality gate, and independent exact-head review. Capability probing establishes only observed collision behavior; it does not classify the filesystem as local or prove power-loss durability.

Resolved: OSV malicious-record classification is defined in `docs/architecture.md` (PG010 matches non-withdrawn `MAL-YYYY-N` identifiers or aliases).

Resolved: the 30-day package-age and 72-hour release-age defaults were retained after authoritative-source review and a fixed-revision, real-project sensitivity sample; see [ADR 0007](adr/0007-policy-age-thresholds.md).

Resolved: npm provenance bundles can be cryptographically bound to the exact package coordinate and registry integrity without downloading a tarball, but that does not independently verify artifact bytes. Provenance policy remains deferred pending explicit identity expectations and the separate provider boundary in [ADR 0008](adr/0008-provenance-verification-boundary.md).
