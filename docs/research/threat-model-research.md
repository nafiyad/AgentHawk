# Threat-model research

Accessed: 2026-08-19

## Assets and security objectives

Protect source code, developer credentials, CI credentials, workstation integrity, repository policy, and the integrity of dependency decisions. Preserve privacy by sending only package coordinates and public metadata requests to configured providers. Produce an auditable decision without claiming universal safety.

## Trust boundaries

1. Agent or human input to AgentHawk: package names and specs are hostile.
2. Repository to AgentHawk: manifests, lockfiles, policy, approvals, and Git output are hostile.
3. AgentHawk to network providers: DNS, TLS, redirects, status codes, bodies, and timing can fail or be adversarial.
4. AgentHawk to terminal/Markdown/JSON: provider strings can contain control characters or injection payloads.
5. AgentHawk to agent/CI: exit codes and JSON must be stable and fail closed.

## Abuse cases and controls

| Abuse case | Planned control | Residual risk |
|---|---|---|
| Hallucinated name is absent | PG001 blocks absent coordinate | Attacker can register it before evaluation |
| Newly registered slopsquat | Age/release/name signals require review | Mature malicious packages can evade heuristics |
| Known malicious version | Exact OSV malicious record produces non-approvable block | Data latency or missing records |
| Vulnerable version | OSV version query and documented severity handling | Advisory incompleteness; reachability unknown |
| Install-script execution | Read metadata only; never install, import, unpack, or execute | Registry metadata can omit behavior in package code |
| Provider outage | PG013 maps to policy `review`/`error`, never implicit allow | Availability can impede development |
| Oversized/hostile response | Bounded body, schema validation, escaping, redaction | Parser/library vulnerabilities remain possible |
| Secret disclosure | Never log environment, auth headers, `.npmrc`, or raw credentials | Host process may expose data outside AgentHawk |
| Approval abuse | Exact version, reason, expiry; hard blocks non-overridable | Compromised maintainer can add approvals |
| Malicious policy weakening | Strict schema and explicit digest/report | Authorized repository writers can change policy |
| CI privilege escalation | Minimal permissions, `pull_request`, pinned actions | Platform/workflow compromise remains |

## Evidence versus inference

Direct evidence includes registry existence/metadata, declared lifecycle scripts, exact advisory matches, and cryptographically verified provenance. Heuristics include age, missing repository metadata, and name similarity. Policy facts include deny/allow configuration and approval records. These categories must remain visible in every finding.

## False positives

Legitimate new packages and releases, packages without repository fields, intentional forks, organization scope migrations, and common naming patterns may trigger review. Review must be version-scoped and explainable. Thresholds are defaults, not claims of maliciousness.

## False negatives

A mature package can be compromised; a package can contain malicious code without lifecycle scripts; provider datasets can lag; provenance can faithfully attest a malicious build; repository URLs can be falsified; and name similarity may miss semantic impersonation. AgentHawk cannot certify benignness.

## Sources

| Source | Organization | Finding | Confidence/limitation | Implication |
|---|---|---|---|---|
| [OSV schema](https://ossf.github.io/osv-schema/) | OpenSSF | Advisories encode affected packages/ranges and optional severity | Records vary by source and completeness | Validate records and never manufacture severity |
| [OSV data quality](https://google.github.io/osv.dev/data_quality.html) | OSV | Precision and version semantics are explicit quality goals | Quality can vary and records can become stale | Preserve IDs, timestamps, and provider status |
| [npm provenance](https://docs.npmjs.com/generating-provenance-statements/) | npm | Provenance links a publish to source/build information | Origin is not a malware verdict | Supporting evidence only |
| [SLSA provenance](https://slsa.dev/spec/v1.2/provenance) | SLSA | Provenance describes where, when, and how an artifact was produced | Does not judge source intent | Avoid treating provenance as trust |
| [GitHub secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) | GitHub | Untrusted input, token permissions, and dangerous triggers require hardening | Workflow-specific review remains necessary | Avoid `pull_request_target`; minimize permissions |
