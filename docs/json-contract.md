# CLI JSON contract

AgentHawk JSON output is intended for automation and coding-agent integrations. Successful `check`, `scan`, and `diff` reports and CLI failures use schema version `1.0`. Consumers must parse the process exit code and JSON together and fail closed on malformed output, unsupported schema versions, or unknown values.

## Compatibility policy

Schema version `1.0` is exact: fields and their meanings will not be removed, changed, or silently extended. Consumers should reject unsupported versions and unknown fields. Any shape change requires a new schema version and migration notes.

## Error envelope

Input, output-bound, and internal CLI failures use one shape:

```json
{
  "schemaVersion": "1.0",
  "error": {
    "code": "invalid_input",
    "message": "Package specification is invalid."
  },
  "exitCode": 2
}
```

Stable error codes are `invalid_input`, `output_limit`, and `internal_error`. Messages are safe for display but are not stable machine identifiers.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Allowed, or a non-strict invocation whose report may still contain warnings/review findings |
| `1` | Strict mode stopped on review or block |
| `2` | Invalid input, configuration, policy, or bounded-output failure |
| `3` | Required evidence/evaluation failure represented by an `error` verdict |
| `4` | Unexpected internal failure |

Only exit `0` plus an explicitly acceptable parsed verdict permits an automated agent to proceed. Strict mode is required for admission workflows.

## Report families

- `check npm` returns a package target, verdict and original verdict, findings, provider status, policy/evidence digests, optional approval metadata, and a human-readable exit-code meaning.
- `scan` returns a bounded array of complete `check` reports and their manifest sections, plus the aggregate verdict.
- `diff` binds dependency changes to the requested base and resolved base commit, reports lockfile correlation and findings, and returns `allow` or `review`.

Runtime schemas are exported by `@agenthawk/core` as `evaluationReportSchema`, `scanReportSchema`, `diffReportSchema`, `inventoryReportSchema`, and `cliErrorReportSchema`.
