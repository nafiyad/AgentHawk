<p align="center">
  <img src="docs/assets/agenthawk-banner.png" alt="AgentHawk — an angular hawk guarding a software package" width="960">
</p>

<h1 align="center">AgentHawk</h1>

<p align="center"><strong>The security layer between AI coding agents and your codebase.</strong></p>

<p align="center">
  <a href="https://github.com/nafiyad/AgentHawk/actions/workflows/quality.yml"><img src="https://github.com/nafiyad/AgentHawk/actions/workflows/quality.yml/badge.svg" alt="Quality status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0 license"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 or newer">
  <img src="https://img.shields.io/badge/posture-local--first-9cff00" alt="Local-first posture">
</p>

AgentHawk is a local-first, deterministic security gate that checks dependencies proposed by AI coding agents before they enter a repository.

> **Project status:** `@agenthawk/core@0.1.0-alpha.1` and `@agenthawk/cli@0.1.0-alpha.1` are public npm alpha packages. The admission-control scope is implemented, but the alpha is not a complete security control and an `ALLOW` verdict is not proof that a dependency is benign.

[Why AgentHawk](#why-agenthawk) · [Current capabilities](#current-capabilities) · [Install](#install-the-public-alpha) · [Development](#development) · [Security](#security-and-privacy-posture) · [Contributing](#contributing)

## Why AgentHawk

Coding agents can propose or install plausible-looking dependencies without the context a maintainer would normally gather. AgentHawk is being designed to resolve the exact request, collect bounded evidence, apply explicit repository policy, and return an explainable `ALLOW`, `WARN`, `REVIEW`, `BLOCK`, or `ERROR` result before installation.

AgentHawk will not use an LLM as the authority for security decisions, execute package code during evaluation, require an AgentHawk account, or claim that a package is universally safe.

## Current capabilities

- Conservative parsing and classification of npm dependency requests
- Bounded, redirect-aware npm registry metadata retrieval
- Normalized package/version, registry-provided distribution integrity, repository, deprecation, and lifecycle-script metadata
- Strict deterministic PG001–PG007, PG010, PG011, PG013, and PG015 policy findings with stable verdict precedence (PG005 name-similarity runs during `scan` against the manifest's other direct dependencies)
- `agenthawk check npm <package-spec>` with terminal/JSON output, strict mode, policy and approval files, bounded caching/offline operation, and stable exit codes
- `agenthawk scan` for aggregate policy evaluation of every bounded root-manifest direct dependency without executing repository code
- `agenthawk diff --base <git-ref>` for direct dependency additions/version changes and PG014 lockfile correlation
- Bounded OSV query, pagination, and batch-match hydration without executing package code
- Stable redacted provider errors without package installation or execution
- Read-only GitHub pull-request evaluation with an isolated opt-in write commenter
- Fail-closed advisory templates for Codex, Claude Code, Cursor, and generic agents
- Exact release-package manifests, dual-use disclosure, checksummed CI artifacts, and protected stage-only trusted publishing for future versions
- Offline fixtures and security regression tests

See [approvals](docs/approvals.md) for the exact exception model.
See [GitHub Actions integration](docs/github-action.md) for the read-only pull-request workflow and opt-in idempotent comments.
See [AI agent integrations](docs/agent-integrations.md) for copyable Codex, Claude Code, Cursor, and generic fail-closed instruction templates.
See the [CLI JSON contract](docs/json-contract.md) for versioning, report families, failure envelopes, and stable exit codes.
See [release operations](docs/releasing.md) for the verified bootstrap record, package gate, protected OIDC staging, and publication boundaries.
See [alpha acceptance status](docs/alpha-acceptance.md) for the implemented-scope matrix, release status, and explicitly deferred platform work.
See [the age-threshold decision](docs/adr/0007-policy-age-thresholds.md) for the evidence, real-project calibration, and limitations behind the default review windows.

## Install the public alpha

```bash
npm install --global @agenthawk/cli@alpha
agenthawk --version
```

Use `@alpha` or the exact `0.1.0-alpha.1` version in automation. npm requires every package to have a `latest` tag, so the first public alpha is also the current default install even though it remains prerelease software.

## Check a proposed dependency

AgentHawk evaluates metadata only; it does not install the package.

```bash
pnpm agenthawk check npm example-package@1.0.0
pnpm agenthawk check npm example-package@1.0.0 --strict --format json
pnpm agenthawk check npm example-package@1.0.0 --policy .agenthawk/policy.yml
pnpm agenthawk check npm example-package@1.0.0 --offline
pnpm agenthawk check npm example-package@1.0.0 --no-cache
pnpm agenthawk scan --format json
pnpm agenthawk diff --base origin/main --strict --format json
```

Exit codes are `0` for allowed/non-strict results, `1` for strict review or block findings, `2` for invalid input or policy, `3` for required provider/evaluation failure, and `4` for unexpected internal failure.

## Development

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm agenthawk --help
```

Node.js 20 or newer and pnpm 10 are required.

## Alpha roadmap

The first alpha focuses on npm dependency admission: package/version resolution, age and lifecycle-script signals, deprecation and repository metadata, OSV evidence, deterministic policy, exact expiring approvals, stable JSON, and strict CI exit codes.

See [the architecture](docs/architecture.md), [threat model](docs/threat-model.md), and [implementation plan](docs/implementation-plan.md) for current boundaries and milestone sequencing.

## Security and privacy posture

AgentHawk is local-first and will not include telemetry. Repository source code and credentials must never be sent to evidence providers. Provider failure will never silently become an allow decision.

Report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).

## Contributing

AgentHawk is in active foundation work. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a contribution.

## License

Licensed under the [Apache License 2.0](LICENSE).
