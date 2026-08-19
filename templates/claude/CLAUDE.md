# Dependency admission with AgentHawk

Before proposing, adding, installing, or updating any third-party npm dependency:

- Do not execute the package manager or package code first.
- Keep the user's exact package specification and run `agenthawk check npm <exact-package-spec> --strict --format json`.
- Proceed only if the process exits `0` and the JSON verdict is `allow` or `warn`. Surface every warning.
- Stop and ask a human for `review`. Do not install on `block` or `error`.
- Fail closed if AgentHawk is unavailable, its output is missing or malformed, or its exit code/verdict is unknown.
- Never omit `--strict`, change security policy, create an approval, use force flags, or retry in a weaker mode to obtain an allow result.
- After dependency files change, run `agenthawk scan --strict --format json`; when a trusted base is known, also run `agenthawk diff --base <trusted-base-ref> --strict --format json`.

This instruction file is not a security boundary. Preserve Claude Code permission controls and rely on protected CI for the final gate.
