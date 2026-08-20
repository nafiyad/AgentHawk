# Alpha acceptance status

Date: 2026-08-19

AgentHawk's npm admission-control implementation is feature-complete for the repository's pre-publication alpha scope. This does not mean the software is published or that an `ALLOW` verdict proves a dependency benign.

## Acceptance matrix

| Capability | Status | Verification and boundary |
| --- | --- | --- |
| npm spec parsing and non-registry classification | Complete | Parser/provider unit tests cover exact, range, tag, scoped, malformed, alias, Git, URL, file, and workspace inputs. Unsupported non-registry forms produce PG015 rather than provider access. |
| Bounded npm evidence | Complete | Local HTTP tests cover redirects, timeouts through body completion, retries, response bounds, invalid UTF-8/JSON, credential URLs, and normalized fields. No tarball or package code is downloaded. |
| OSV and malicious-package evidence | Complete | Offline tests cover version queries, batch hydration, pagination, truncation, record identity, MAL identifiers, withdrawal, qualitative severity, and provider failures. |
| Deterministic policy | Complete | PG001–PG007, PG010, PG011, PG013, PG014, and PG015, verdict precedence, prereleases, strict unknown versions, evidence timestamps, and calibrated age-threshold boundaries are tested. |
| Exact approvals | Complete | Exact resolved coordinates, reason/time bounds, expiry, partial approvals, and non-overridable blocks/errors are tested and documented. |
| Cache and offline mode | Complete | Provider-specific TTLs, hashed keys, strict bounded files, credential stripping, corruption/staleness, no-network offline behavior, and mandatory unauthenticated-cache PG013 are tested. |
| CLI and JSON contract | Complete | `check`, `scan`, and `diff` use strict v1 runtime schemas, stable exit codes, versioned failure envelopes, redaction, and parser/internal-error regressions. |
| Repository scan and diff | Complete | Root regular-file constraints, 64-dependency bound, deterministic reports, hostile Git environment/ref handling, immutable base resolution, and PG014 lockfile correlation are tested. |
| GitHub pull-request reporting | Complete | Read-only unprivileged evaluation, bounded artifact/summary, isolated opt-in commenter, hostile rendering tests, and immutable pins are documented and CI-tested. |
| Agent templates | Complete | Copyable Codex, Claude Code, Cursor, and generic instructions are fail-closed and explicitly advisory. |
| Package readiness | Complete but locked | Exact offline manifests, metadata, README/license inclusion, path/symlink/size checks, and entrypoint smoke tests run in Quality. Both packages remain private and unpublished. |

## Quality evidence

The required Quality workflow runs lint, typecheck, the full offline test suite, core coverage thresholds, build, package verification, and CLI smoke testing. Security-sensitive core coverage thresholds are 90% for statements, branches, functions, and lines. Exact results belong to each commit's workflow run; this document intentionally does not freeze a test count that will become stale.

## Remaining blockers before publication

These are owner decisions, not missing alpha admission features:

1. confirm final npm package names and ownership;
2. choose the first semantic prerelease version;
3. decide whether CLI and core publish together;
4. configure protected release approvers and npm trusted publishing;
5. authorize a separate release-workflow PR and release candidate.

Until then, `private: true` is the npm publication guard. Version `0.0.0` and the CLI's `workspace:*` dependency are additional readiness sentinels that the package gate requires; they are not npm publication controls by themselves.

## Explicitly deferred

PyPI/Cargo/Maven/NuGet support, command or secret interception, network sandboxing, MCP server, hosted services, accounts, full malware analysis, and artifact/provenance verification are outside this alpha. They require separate threat models and milestones.

## Permanent product exclusions

AgentHawk will not add telemetry and will not use an LLM as the authority for security verdicts. Those are product principles, not deferred features. Future optional analysis may supply non-authoritative evidence only if a separate design preserves deterministic policy authority and the no-telemetry boundary.
