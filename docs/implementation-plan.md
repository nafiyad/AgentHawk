# Implementation plan

Date: 2026-08-19

## Current state

The repository began empty except for Git metadata; `AGENTS.md` and Milestone 0 research were the first tracked material. All fourteen alpha milestones below are now complete: the pre-publication alpha implements `check npm`, `scan`, and `diff` with npm/OSV evidence, deterministic policy, approvals, cache/offline behavior, GitHub Action integration, agent templates, hardened JSON contracts, and an offline package-content gate. The public remote is `https://github.com/nafiyad/AgentHawk`. Packages remain `private: true` at version `0.0.0` pending explicit publication authorization.

## Assumptions and constraints

- Node.js 20+ and pnpm workspaces; TypeScript strict mode.
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

Every milestone updates docs, reviews its diff, runs focused tests and the full available quality gate, scans staged content for secrets, commits, pushes, and verifies the exact remote head.

## Test strategy

Use table-driven unit tests for parsing/rules/precedence/approvals/digests/escaping/redaction. Use local mock servers for HTTP limits, timeouts, redirects, 429, malformed/oversized JSON, and full CLI flows. Use temporary Git repositories for diff mode. Add explicit regression tests proving no package manager execution, `shell: true`, auth/environment logging, wildcard/expired approvals, or implicit allow on provider failure. Core statement and branch coverage must reach 90% before alpha.

## Security and migration risks

- Provider schemas/semantics drift: validate a small normalized subset and fixture failure paths.
- False confidence: precise product language and visible evidence limitations.
- False positives: configurable thresholds and exact expiring approvals.
- CLI/report compatibility: schema versioning and golden integration tests.
- Dependency compromise in AgentHawk itself: minimize runtime dependencies, pin lockfile, use trusted publishing/provenance later.
- Future action shields: preserve clean core boundaries; do not generalize until requirements exist.

No migration exists for the empty repository. Once public APIs ship, incompatible changes require a schema/version migration plan and changelog.

## Expected files

Milestone 1 adds root workspace/build/test/lint configuration, `.github/workflows/quality.yml`, `packages/core`, `packages/cli`, report/config documentation, README, license, contribution/security/community files, and initial ADRs. Later milestones add only the packages and documentation required by their acceptance criteria.

## Rollback

Milestones are isolated commits. A defective unreleased milestone can be reverted with a new commit; public history is never rewritten. Provider features remain behind interfaces so a failing provider can be disabled by an explicit policy/version change without weakening other evidence silently.

## Open questions

- Confirm the final npm package names and publishing ownership before release work (see `docs/releasing.md`).

Resolved: OSV malicious-record classification is defined in `docs/architecture.md` (PG010 matches non-withdrawn `MAL-YYYY-N` identifiers or aliases).

Resolved: the 30-day package-age and 72-hour release-age defaults were retained after authoritative-source review and a fixed-revision, real-project sensitivity sample; see [ADR 0007](adr/0007-policy-age-thresholds.md).

Resolved: npm provenance bundles can be cryptographically bound to the exact package coordinate and registry integrity without downloading a tarball, but that does not independently verify artifact bytes. Provenance policy remains deferred pending explicit identity expectations and the separate provider boundary in [ADR 0008](adr/0008-provenance-verification-boundary.md).
