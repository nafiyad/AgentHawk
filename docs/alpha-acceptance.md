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
| Package readiness | Complete, unpublished | Exact offline manifests, tarball parsing, metadata, README/license/disclosure inclusion, path/symlink/size checks, workspace-dependency rewrite, runtime version, and entrypoint smoke tests run in Quality. Both packages remain unpublished. |
| Release control | Complete, not executed | A credential-free job builds checksummed artifacts; only an exact version tag can reach the protected `npm-release` environment, whose isolated OIDC job can stage but cannot promote packages. |

## Quality evidence

The required Quality workflow runs lint, typecheck, the full offline test suite, core coverage thresholds, build, package verification, and CLI smoke testing. Security-sensitive core coverage thresholds are 90% for statements, branches, functions, and lines. Exact results belong to each commit's workflow run; this document intentionally does not freeze a test count that will become stale.

## Remaining operations before publication

The package names, `0.1.0-alpha.1` version, paired release, `npm-release` environment, trusted-publishing posture, persistent dual-use declaration, and one-time interactive 2FA bootstrap are approved. Publication still requires operational evidence and a separate exact-artifact approval:

1. merge the exact-head green release-workflow PR after independent review;
2. run its manual credential-free artifact preparation from the exact current `main` commit;
3. inspect the resulting manifest, checksums, and two package tarballs;
4. explicitly approve publication of those exact hashes;
5. perform the one-time interactive 2FA bootstrap, then configure each package's stage-only trusted publisher and the protected GitHub environment.

The source workspace keeps `workspace:*` so local package relationships cannot drift. `pnpm pack` must rewrite it to the exact shared release version, and the package gate inspects the packed manifest to enforce that invariant. Public metadata in a source manifest is not publication by itself; no workflow path uses direct `npm publish`.

## Explicitly deferred

PyPI/Cargo/Maven/NuGet support, command or secret interception, network sandboxing, MCP server, hosted services, accounts, full malware analysis, and artifact/provenance verification are outside this alpha. The provenance boundary and future-provider requirements are recorded in [ADR 0008](adr/0008-provenance-verification-boundary.md); implementation requires a separate threat model and milestone.

## Permanent product exclusions

AgentHawk will not add telemetry and will not use an LLM as the authority for security verdicts. Those are product principles, not deferred features. Future optional analysis may supply non-authoritative evidence only if a separate design preserves deterministic policy authority and the no-telemetry boundary.
