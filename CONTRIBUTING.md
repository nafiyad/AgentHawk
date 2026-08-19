# Contributing to AgentHawk

Thank you for helping build a transparent dependency security gate.

## Before opening a change

For substantial behavior or policy changes, open an issue first. Security decisions must remain deterministic, explainable, testable, and free of hidden bypasses. Do not add telemetry or execute third-party package code.

## Development

Use Node.js 20+ and pnpm 10.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

Add focused tests for positive, negative, error, and adversarial paths. Network-dependent unit tests are not accepted; use fixtures and local mock servers.

## Pull requests

Keep changes focused, explain security implications, document user-visible behavior, and ensure every quality command passes. Never include credentials, private package metadata, or proprietary repository content.

By contributing, you agree that your contributions are licensed under Apache-2.0.
