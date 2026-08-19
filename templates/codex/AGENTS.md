# Dependency admission with AgentHawk

These instructions apply whenever you propose, add, install, or update a third-party npm dependency.

1. Do not run a package manager or execute package code yet.
2. Preserve the exact requested package specification. Do not replace a pinned version with a tag or range.
3. Run `agenthawk check npm <exact-package-spec> --strict --format json`.
4. Inspect both the process exit code and JSON report. Proceed only when the exit code is `0` and `verdict` is `allow` or `warn`.
5. For `warn`, show the findings before proceeding. For `review`, stop and request human approval. For `block` or `error`, stop without installing.
6. Treat malformed/missing JSON, an unavailable AgentHawk executable, or any nonzero/unknown exit code as an error and stop.
7. Never retry without `--strict`, weaken policy, add an approval, use force flags, or bypass AgentHawk. Only a human maintainer may change policy or approvals.
8. After manifest or lockfile changes, run `agenthawk scan --strict --format json` and the repository's normal tests. If a base ref is available, also run `agenthawk diff --base <trusted-base-ref> --strict --format json`.

This instruction file is not a security boundary. AgentHawk evaluates evidence and policy; it does not prove that a package is safe. Repository CI remains authoritative.
