# Alpha acceptance status

Date: 2026-08-20

AgentHawk's npm admission-control implementation is feature-complete for the first public alpha scope. Both packages are public; this does not mean that an `ALLOW` verdict proves a dependency benign or that the alpha is a complete security control.

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
| Package readiness | Complete, published | Exact offline manifests, tarball parsing, metadata, README/license/disclosure inclusion, path/symlink/size checks, workspace-dependency rewrite, runtime version, and entrypoint smoke tests run in Quality. Both packages are public at `0.1.0-alpha.1`, and their registry tarballs match the approved CI artifacts. |
| Release control | Complete, configured | A credential-free job builds checksummed artifacts; only matching alpha tags can reach the protected `npm-release` environment, whose isolated OIDC job can stage but cannot promote packages. Both npm trusted publishers are stage-only and bypass-2FA token publication is disabled. |

## Quality evidence

The required Quality workflow runs lint, typecheck, the full offline test suite, core coverage thresholds, build, package verification, and CLI smoke testing. Security-sensitive core coverage thresholds are 90% for statements, branches, functions, and lines. Exact results belong to each commit's workflow run; this document intentionally does not freeze a test count that will become stale.

## Bootstrap completion

The approved one-time bootstrap completed on 2026-08-20 UTC:

1. exact-head release workflow and post-merge Quality checks passed;
2. the credential-free manual run built a five-file bundle from exact `main` commit `a2eccf130055bf14062a209452f77c24265b7f8f`;
3. the two approved tarball hashes were verified before and after publication;
4. core was published before CLI with interactive 2FA and no automation token;
5. the public CLI installation resolved the exact matching core version and started successfully;
6. both packages now use stage-only trusted publishing bound to `nafiyad/AgentHawk`, `release.yml`, and `npm-release`;
7. `npm-release` requires maintainer approval, accepts only `v0.*-alpha.*` tags, contains no secrets, and disallows administrator bypass.

The first version has no provenance attestation because the approved local bootstrap had no GitHub OIDC identity. npm also requires every package to have a `latest` tag, so `alpha` and `latest` both resolve to `0.1.0-alpha.1`; this registry invariant is not a stability claim. The source workspace keeps `workspace:*` so local package relationships cannot drift. `pnpm pack` rewrites it to the exact shared release version, and the package gate inspects the packed manifest to enforce that invariant. No workflow path uses direct `npm publish`.

## Explicitly deferred

PyPI/Cargo/Maven/NuGet support, command or secret interception, network sandboxing, MCP server, hosted services, accounts, full malware analysis, and artifact/provenance verification are outside this alpha. The provenance boundary and future-provider requirements are recorded in [ADR 0008](adr/0008-provenance-verification-boundary.md); implementation requires a separate threat model and milestone.

## Permanent product exclusions

AgentHawk will not add telemetry and will not use an LLM as the authority for security verdicts. Those are product principles, not deferred features. Future optional analysis may supply non-authoritative evidence only if a separate design preserves deterministic policy authority and the no-telemetry boundary.
