# Changelog

All notable changes are documented in this file. AgentHawk follows semantic versioning from its first public alpha.

## Unreleased

### Added

- `agenthawk policy validate --file <path>` reuses the production bounded YAML and strict policy schema, returns terminal or strict JSON output, and contacts no evidence provider.
- `agenthawk approvals verify --file <path>` reports bounded approval time states and a semantic digest without applying an approval or contacting providers.

### Changed

- The development and next-release runtime baseline is Node.js 22 or 24 LTS. Node 20 is no longer declared or tested after its upstream end-of-life.
- Quality CI covers Node.js 22 and 24 on Ubuntu, Windows, and macOS; the dependency-diff workflow uses Node.js 24.

## 0.1.0-alpha.1 - 2026-08-20

First public alpha of `@agenthawk/core` and `@agenthawk/cli`.

### Added

- Local-first npm dependency admission with deterministic policy findings.
- Normalized npm and OSV evidence with bounded HTTP behavior.
- Exact expiring approvals and bounded offline metadata caching.
- `check npm`, `scan`, and `diff` commands with stable strict JSON contracts.
- Read-only GitHub pull-request reporting and fail-closed advisory templates for Codex, Claude Code, Cursor, and generic coding agents.
- Exact dual-use package artifacts with packaged disclosures and an exact CLI-to-core dependency.
- Checksummed release artifacts and protected stage-only npm trusted publishing for future versions; public promotion still requires maintainer review and npm 2FA.

### Security

- Fail-closed provider, cache, policy, parser, and internal-error behavior.
- Bounded untrusted inputs and outputs, redacted diagnostics, and no package execution.

### Known limitations

- This is prerelease software and is not a complete security control. An `ALLOW` verdict does not prove a dependency benign.
- The bootstrap was interactive and has no npm provenance attestation.
- npm requires a `latest` tag for every package, so both `alpha` and `latest` initially resolve to `0.1.0-alpha.1`; this is not a stability claim.
- The immutable first-version tarballs contain pre-publication README wording that calls the packages unpublished. Repository READMEs contain the corrected status for future artifacts.
