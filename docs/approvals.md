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

Files are strict YAML, limited to 256 KiB and 1,024 records, and read only through a regular non-symlink path. Duplicate keys, aliases, duplicate coordinates, invalid UTF-8, wildcards, ranges, tags, unknown fields, missing or control-bearing reasons/approvers, and invalid timestamps are rejected. The record limit is an AgentHawk resource bound, not an ecosystem security standard.

An approval matches only the exact ecosystem, normalized package name, and resolved version. It must be active, unexpired, and within `maxValidityDays`. A match may resolve approvable `review` findings. It never deletes findings, changes `originalVerdict`, resolves provider errors or non-approvable reviews, or overrides a block.

Use `agenthawk approvals verify --file .agenthawk/approvals.yml` to inspect the file without applying an approval. Verification samples the clock once, reports bounded counts for time-eligible, expired, and not-yet-effective records, and emits a semantic digest that ignores YAML formatting, record order, and equivalent timestamp precision. An approval is time-eligible when `approvedAt` is at or before the sampled instant and `expiresAt` is strictly after it; equality at expiry is expired.

Exit `0` means the file is structurally valid, even if expired or future records are reported. It does not mean every record satisfies the active policy's `maxValidityDays`, matches a package, or can resolve a finding. Policy-specific validity remains enforced only during application. The command returns no coordinates, approvers, reasons, issue URLs, or path, applies no approval, opens no cache, and contacts no provider.
