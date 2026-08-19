# `@agenthawk/cli`

Local-first dependency admission control for AI coding agents, from [AgentHawk](https://github.com/nafiyad/AgentHawk).

This package is pre-release and remains private until package ownership and release controls are confirmed. It inspects metadata and policy without installing or executing the proposed package.

```bash
agenthawk check npm example-package@1.0.0 --strict --format json
agenthawk scan --strict --format json
agenthawk diff --base origin/main --strict --format json
```

See the repository [README](https://github.com/nafiyad/AgentHawk#readme), [security policy](https://github.com/nafiyad/AgentHawk/blob/main/SECURITY.md), and [JSON contract](https://github.com/nafiyad/AgentHawk/blob/main/docs/json-contract.md).
