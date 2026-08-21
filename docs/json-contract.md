# CLI JSON contract

AgentHawk JSON output is intended for automation and coding-agent integrations. Successful `check`, `scan`, `diff`, `policy validate`, `approvals verify`, and `doctor` reports and CLI failures use schema version `1.0`. Consumers must parse the process exit code and JSON together and fail closed on malformed output, unsupported schema versions, or unknown values.

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
| `0` | Command completed successfully; an admission report may still contain non-strict warnings/review findings |
| `1` | Strict mode stopped on review/block, or a completed diagnostic requires attention |
| `2` | Invalid input, configuration, policy, or bounded-output failure |
| `3` | Required evidence/evaluation failure represented by an `error` verdict |
| `4` | Unexpected internal failure |

Only exit `0` plus an explicitly acceptable parsed verdict permits an automated agent to proceed with dependency admission. Strict mode is required for admission workflows. For `policy validate`, exit `0` plus a schema-valid report with `valid: true` means only that the policy file passed the current file and configuration schemas; it is not a package verdict. For `approvals verify`, the same combination means only that the approval file is structurally valid; consumers must inspect its time-state counts and must not infer policy applicability. For `doctor`, exit `0` plus `ready: true` means only that its bounded documented checks passed; exit `1` is diagnostic attention, not a dependency verdict.

## Report families

- `check npm` returns a package target, verdict and original verdict, findings, provider status, policy/evidence digests, optional approval metadata, and a human-readable exit-code meaning.
- `scan` returns a bounded array of complete `check` reports and their manifest sections, plus the aggregate verdict.
- `diff` binds dependency changes to the requested base and resolved base commit, reports lockfile correlation and findings, and returns `allow` or `review`.
- `policy validate` returns command identity, tool version, normalized policy version/mode, and a deterministic policy digest. It does not return the requested path or policy contents and makes no provider request.
- `approvals verify` returns command identity, tool/file schema versions, bounded time-eligible/expired/not-yet-effective counts, one checked instant, and a semantic approval digest. It does not return the requested path or approval contents, apply an approval, or make a provider request.
- `doctor` returns fixed runtime, package-alignment, cache, Git, configuration, and integration-presence states. It returns no paths, contents, environment values, child-process diagnostics, or provider data.

Runtime schemas are exported by `@agenthawk/core` as `evaluationReportSchema`, `scanReportSchema`, `diffReportSchema`, `inventoryReportSchema`, `policyValidationReportSchema`, `approvalValidationReportSchema`, `doctorReportSchema`, and `cliErrorReportSchema`.
