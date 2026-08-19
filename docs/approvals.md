# Approvals

AgentHawk approvals are local, exact, expiring review records. By default, `check npm` looks for `.agenthawk/approvals.yml`. Use `--approvals <path>` to require a different file.

```yaml
version: 1
approvals:
  - ecosystem: npm
    name: example-package
    version: 1.2.3
    approvedBy: github:maintainer
    approvedAt: 2026-08-19T00:00:00.000Z
    expiresAt: 2026-09-19T00:00:00.000Z
    reason: Source and release reviewed.
```

Files are strict YAML and limited to 256 KiB. Duplicate keys, aliases, duplicate coordinates, invalid UTF-8, wildcards, ranges, tags, unknown fields, missing reasons, and invalid timestamps are rejected.

An approval matches only the exact ecosystem, normalized package name, and resolved version. It must be active, unexpired, and within `maxValidityDays`. A match may resolve approvable `review` findings. It never deletes findings, changes `originalVerdict`, resolves provider errors or non-approvable reviews, or overrides a block.
