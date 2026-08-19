# Dependency rationale

AgentHawk minimizes runtime dependencies because it is itself a supply-chain security tool.

| Dependency | Scope | Reason |
|---|---|---|
| `zod` | Runtime | Strict validation of untrusted configuration, reports, and provider responses. Hand-written shape checks would duplicate security-sensitive validation logic. |
| `semver` | Runtime | Canonical npm-compatible exact/range/prerelease version parsing and maximum-satisfying selection. Reimplementing npm semver semantics would create correctness and security risk. |
| `commander` | Runtime (CLI) | Stable command parsing and help/error behavior. |
| `yaml` | Runtime (CLI) | Strict parsing of local repository policy files with duplicate-key and alias controls. A maintained parser avoids security-sensitive bespoke YAML handling. |

Development dependencies provide formatting/linting, typechecking, offline tests/coverage, and TypeScript execution during development. Versions are exact in manifests and locked transitively. pnpm dependency build scripts are denied by default except for the explicitly reviewed `esbuild` binary used by Vitest/tsx.
