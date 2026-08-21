# ADR 0003: Exact, expiring approval semantics

Status: accepted

## Decision

Version 1 approvals match the exact ecosystem, normalized name, and resolved SemVer. Records require an approver, approval time, later expiry, and non-empty reason. Wildcards, selectors, and duplicate coordinates are invalid.

Standalone verification reuses the production bounded YAML reader and approval schema. It samples one valid UTC clock instant and classifies records using the same boundaries as application: approval time is inclusive and expiry is exclusive. Expired and future records remain structurally valid but are reported separately; exit `0` therefore means valid file structure, not policy applicability. Policy-owned `maxValidityDays` is evaluated only when applying a record.

The verification digest covers normalized record semantics. Records are sorted by exact coordinate and timestamps are canonicalized to millisecond UTC, so YAML formatting, mapping order, record order, and equivalent accepted timestamp precision do not change the digest. Verification does not expose record contents, apply an exception, or contact a provider.

Application occurs after policy evaluation. Only findings with verdict `review` and `approvable: true` are resolved. Findings and `originalVerdict` remain in the report. Errors, blocks, and non-approvable reviews cannot be resolved.

## Consequences

Exceptions are narrow, time-bounded, auditable, and deterministic. A new version requires a new record. Approval-file errors stop evaluation rather than silently disabling enforcement. Time-state counts help operators find inert records without converting an inactive record into malformed input or changing enforcement semantics.
