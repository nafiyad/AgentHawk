# CLI JSON contract

AgentHawk JSON output is intended for automation and coding-agent integrations. Successful `init`, `check`, `scan`, `diff`, `policy validate`, `approvals verify`, and `doctor` reports and CLI failures use schema version `1.0`. Consumers must parse the process exit code and JSON together and fail closed on malformed output, unsupported schema versions, or unknown values.

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

Only exit `0` plus an explicitly acceptable parsed verdict permits an automated agent to proceed with dependency admission. Strict mode is required for admission workflows. For `policy validate`, exit `0` plus a schema-valid report with `valid: true` means only that the policy file passed the current file and configuration schemas; it is not a package verdict. For `approvals verify`, the same combination means only that the approval file is structurally valid; consumers must inspect its time-state counts and must not infer policy applicability. For `doctor`, exit `0` plus `ready: true` means only that its bounded documented checks passed; exit `1` is diagnostic attention, not a dependency verdict. For `init`, exit `0` means every expected fixed target was created or matched the release-pinned bytes exactly. Exit `2` means a collision or unsafe precondition prevented initialization; exit `4` includes unexpected publication or unconfirmed-cleanup failures. Init never uses exit `1` or `3`.

## Report families

- `check npm` returns a package target, verdict and original verdict, findings, provider status, policy/evidence digests, optional approval metadata, and a human-readable exit-code meaning.
- `scan` returns a bounded array of complete `check` reports and their manifest sections, plus the aggregate verdict.
- `diff` binds dependency changes to the requested base and resolved base commit, reports lockfile correlation and findings, and returns `allow` or `review`.
- `policy validate` returns command identity, tool version, normalized policy version/mode, and a deterministic policy digest. It does not return the requested path or policy contents and makes no provider request.
- `approvals verify` returns command identity, tool/file schema versions, bounded time-eligible/expired/not-yet-effective counts, one checked instant, and a semantic approval digest. It does not return the requested path or approval contents, apply an approval, or make a provider request.
- `doctor` returns fixed runtime, package-alignment, cache, Git, configuration, and integration-presence states. It returns no paths, contents, environment values, child-process diagnostics, or provider data.
- `init` returns its selected integration and fixed created/unchanged target identifiers. It returns no absolute paths, contents, temporary names, filesystem diagnostics, or provider data.

Runtime schemas are exported by `@agenthawk/core` as `evaluationReportSchema`, `scanReportSchema`, `diffReportSchema`, `inventoryReportSchema`, `policyValidationReportSchema`, `approvalValidationReportSchema`, `doctorReportSchema`, `initReportSchema`, and `cliErrorReportSchema`.

## Planned native-hook internal contracts

`@agenthawk/core` also exports strict `agentActionSchema`, `agentDecisionSchema`, and `commandQualificationSchema` v1 contracts for the Milestone 17 native-hook boundary. These are internal vendor-neutral contracts, not CLI reports and not evidence that a native adapter is installed or supported.

The action envelope is transient and bounded. It includes only the adapter identity/version, deployment-trust declaration, pre-tool event, validated repository/action paths, shell dialect, and command required for qualification. Vendor payloads cannot add prompt, transcript, environment, session, credential, or configuration-path fields. The initial contract requires the action directory to equal the repository root; schema validation alone does not prove that either path is canonical or trusted.

The decision envelope is a strict union: `neutral` is legal only for unrelated, allowed, or harness-visible warning cases, while review, block, error, invalid, unsupported, ephemeral, deadline, configuration, repository-identity, and internal failures deny. Evaluated variants require the original/final verdict, approval state, and a SHA-256 report digest. Messages are fixed redacted literals. The compact serializer emits one UTF-8 JSON value plus a newline and enforces the 8 KiB bound. It does not choose vendor process exit behavior.

The pure qualifier currently recognizes only direct lowercase POSIX `npm install|i|add` and `pnpm add` forms with one to eight flag-free registry operands. Every operand is validated by `parseNpmSpec`; raw command text is absent from the result. Only lexically simple commands with no manager-like token are unrelated. A manager token in any other position, recognized wrappers/interpreters, and shell syntax the qualifier intentionally does not interpret are conservatively unsupported, including benign mentions; unknown script/alias/function bodies that expose no manager token remain residual bypasses. Unsupported and unrelated results do not authorize provider access. Duplicate-key detection, fatal UTF-8 decoding, stdin framing, canonical root discovery, deadline propagation, vendor serialization, and emergency exit behavior remain adapter-layer gates and are not claimed by these core schemas.
