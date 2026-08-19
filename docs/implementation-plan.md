# Implementation plan

Date: 2026-08-19

## Current state

The repository began empty except for Git metadata. `AGENTS.md` and Milestone 0 research are the first tracked material. The public remote is `https://github.com/nafiyad/AgentHawk`. There is no legacy API, user data, or compatibility constraint.

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
9. **Scan/diff**: direct dependency changes, lockfile correlation, argument-array Git tests.
10. **GitHub Action**: minimal permissions, safe summary/artifact, optional idempotent comment.
11. **Agent templates**: Codex/Claude/Cursor/generic instructions after JSON stability.

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

- Calibrate 30-day package and 72-hour release defaults using real-project fixtures before alpha.
- Define the exact OSV malicious-record classification from current source records during Milestone 5.
- Decide whether provenance can be verified without artifact download; otherwise defer.
- Confirm the final npm package names and publishing ownership before release work.
