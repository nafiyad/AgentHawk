# `@agenthawk/cli`

Local-first dependency admission control for AI coding agents, from [AgentHawk](https://github.com/nafiyad/AgentHawk).

`0.1.0-alpha.1` is the first public alpha. Its dual-use declaration and disclosure are packaging policy. It inspects metadata and policy without installing or executing the proposed package.

```bash
npm install --global @agenthawk/cli@alpha
agenthawk --version
```

The currently published `0.1.0-alpha.1` package does not include `agenthawk init`. Initialization is implemented in the source revision that contains this README and is available only after that revision is released. Check `agenthawk --help` for the commands present in your installed version.

```bash
agenthawk check npm example-package@1.0.0 --strict --format json
agenthawk policy validate --file .agenthawk.yml --format json
agenthawk approvals verify --file .agenthawk/approvals.yml --format json
agenthawk doctor --format json
agenthawk scan --strict --format json
agenthawk diff --base origin/main --strict --format json
```

From a source checkout containing the initialization milestone:

```bash
pnpm agenthawk init --integration none --format json
```

See the repository [README](https://github.com/nafiyad/AgentHawk#readme), [security policy](https://github.com/nafiyad/AgentHawk/blob/main/SECURITY.md), and [JSON contract](https://github.com/nafiyad/AgentHawk/blob/main/docs/json-contract.md).
