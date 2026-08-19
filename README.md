# AgentHawk

**The security layer between AI coding agents and your codebase.**

AgentHawk is a local-first, deterministic security gate that checks dependencies proposed by AI coding agents before they enter a repository.

> **Project status:** early development. The CLI foundation and public schemas exist; dependency evaluation is not implemented yet. Do not use this release as a security control.

## Why AgentHawk

Coding agents can propose or install plausible-looking dependencies without the context a maintainer would normally gather. AgentHawk is being designed to resolve the exact request, collect bounded evidence, apply explicit repository policy, and return an explainable `ALLOW`, `WARN`, `REVIEW`, `BLOCK`, or `ERROR` result before installation.

AgentHawk will not use an LLM as the authority for security decisions, execute package code during evaluation, require an AgentHawk account, or claim that a package is universally safe.

## Current development commands

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm agenthawk --help
```

Node.js 20 or newer and pnpm 11 are required.

## Planned alpha scope

The first alpha focuses on npm dependency admission: package/version resolution, age and lifecycle-script signals, deprecation and repository metadata, OSV evidence, deterministic policy, exact expiring approvals, stable JSON, and strict CI exit codes.

See [the implementation plan](docs/implementation-plan.md) for milestone sequencing. Security assumptions and limitations will be maintained in `docs/threat-model.md` as the core is implemented.

## Security and privacy posture

AgentHawk is local-first and will not include telemetry. Repository source code and credentials must never be sent to evidence providers. Provider failure will never silently become an allow decision.

Report suspected vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).

## Contributing

AgentHawk is in active foundation work. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before opening a contribution.

## License

Licensed under the [Apache License 2.0](LICENSE).
