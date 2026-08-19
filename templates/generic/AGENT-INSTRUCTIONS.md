# AgentHawk protocol for coding agents

Apply this protocol before any third-party npm dependency is proposed, added, installed, or updated.

```text
PRECHECK
  Do not install or execute package code.
  Run: agenthawk check npm <exact-package-spec> --strict --format json

DECIDE
  Exit 0 + allow -> proceed
  Exit 0 + warn  -> show findings, then proceed
  review         -> stop and request human approval
  block          -> stop; do not install
  error          -> stop until evaluation succeeds
  malformed/missing output, unavailable tool, unknown value, or nonzero exit -> stop

VERIFY
  Run: agenthawk scan --strict --format json
  If a trusted base exists:
  Run: agenthawk diff --base <trusted-base-ref> --strict --format json
```

The agent must not remove strict mode, alter policy or approvals, use force flags, or retry with weaker options. Human-controlled CI is the enforcement boundary.
