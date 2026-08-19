# ADR 0003: Exact, expiring approval semantics

Status: accepted

## Decision

Version 1 approvals match the exact ecosystem, normalized name, and resolved SemVer. Records require an approver, approval time, later expiry, and non-empty reason. Wildcards, selectors, and duplicate coordinates are invalid.

Application occurs after policy evaluation. Only findings with verdict `review` and `approvable: true` are resolved. Findings and `originalVerdict` remain in the report. Errors, blocks, and non-approvable reviews cannot be resolved.

## Consequences

Exceptions are narrow, time-bounded, auditable, and deterministic. A new version requires a new record. Approval-file errors stop evaluation rather than silently disabling enforcement.
