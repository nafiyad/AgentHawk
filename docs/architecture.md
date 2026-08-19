# Architecture

## Current boundary

AgentHawk provides npm request parsing, normalized registry and OSV evidence, deterministic policy evaluation, `agenthawk check npm`, and exact expiring approvals.

```text
untrusted package spec
        |
        v
conservative parser ----> non-registry classification
        |
        v
package coordinate
        |
        v
npm provider ----> bounded HTTP client ----> configured registry
        |
        v
normalized metadata (no raw response)
        |
        v
OSV provider ----> bounded POST/GET ----> api.osv.dev
        |
        v
policy engine ----> ALLOW / WARN / REVIEW / BLOCK / ERROR
        |
        v
terminal or JSON report
```

## Input model

Registry inputs are separated from aliases, Git references, URLs, file/directory paths, and workspace references before network access. Registry names use a conservative lowercase npm grammar. Selectors are classified with the canonical `semver` implementation as exact versions, ranges, tags, or the default wildcard.

Non-registry inputs are not fetched by the npm provider. PG015 reports them as explicit review findings.

## HTTP safety boundary

All provider traffic uses `SafeHttpClient`. Remote URLs require HTTPS; HTTP is permitted only for loopback fixture servers. Credentials in URLs are rejected. Requests use explicit time, body, redirect, retry, and request-size bounds. GET redirects are handled manually and revalidated. POST is used for OSV queries and must not redirect. Responses must be successful JSON with valid UTF-8 and fit within the byte limit.

Errors are normalized to `timeout`, `rate_limited`, `invalid_response`, `not_found`, `network_error`, or `provider_error`. Diagnostics exclude request URLs, response bodies, headers, and caught exception details so tokens or hostile metadata are not reflected.

## npm provider

The provider retrieves one package document, validates only the required shape, resolves exact versions/tags/ranges, and returns selected fields:

- resolved version;
- first-publication and selected-release timestamps;
- deprecation text;
- repository URL;
- names of security-relevant lifecycle scripts;
- tarball URL and integrity metadata.

It does not retain arbitrary scripts, maintainers, README content, or the raw registry response. It never downloads a tarball, invokes a package manager, imports package code, or executes lifecycle scripts.

## Deterministic policy boundary

The policy engine consumes a parsed npm spec, validated policy, normalized provider result, an explicit evaluation clock, and optional existing direct dependency names. Independent rules emit structured `PG` findings; they never perform network access, install dependencies, or execute lifecycle scripts.

Implemented rules are PG001 through PG007, PG013, and PG015. PG003 also enforces the explicit prerelease policy when a resolved version is a prerelease. Name-similarity checks are intentionally conservative: scope changes, separator-only changes, one edit, or one adjacent transposition are considered only for names of useful minimum length. A match is a review heuristic, not proof of maliciousness.

Verdicts use stable precedence: `error` > `block` > `review` > `warn` > `allow`. Findings are sorted by rule identifier. Missing, disabled, failed, or incomplete required provider evidence produces a PG013 review finding rather than silently allowing the dependency. Strict mode adds a separate typed evaluation error and makes the PG013 finding non-approvable; it does not widen the stable finding-verdict schema. `onUnknownVersion: error` uses the same separate error channel while preserving the underlying PG001 block finding.

Provider results carry their own strictly validated retrieval timestamp. Policy evidence uses that provider-owned time rather than the caller's evaluation clock. Publication timestamps reject impossible calendar dates at the provider boundary and are revalidated by the policy engine before age calculations.

The policy schema rejects unknown fields at every security-sensitive level. Known-malicious handling remains fixed to `block`.

## OSV evidence boundary

OSV is queried only after npm successfully resolves a package version. The provider uses bounded JSON `POST` for `/v1/query` and `/v1/querybatch`, and bounded `GET` for `/v1/vulns/{id}` hydration of abbreviated batch matches. POST responses must not redirect. Request bodies are size-limited before they are sent.

Batch results preserve input order and associate each hydrated record set with its exact package query. Hydrated record identifiers must equal the abbreviated identifier requested; mismatches fail closed.

Pagination follows `next_page_token` until it is absent. A first page that contains only a token is not treated as empty evidence. A configured page or record limit that is hit while a token remains is incomplete evidence (PG013), not a clean result.

**PG010** treats OpenSSF Malicious Packages records as malicious when the OSV `id` or an alias matches `MAL-YYYY-N` and the record is not withdrawn. This signal is grounded in the [OpenSSF malicious-package OSV records](https://github.com/ossf/malicious-packages/tree/main/osv/malicious/npm), whose canonical record identifiers use that namespace. It does not infer malware from advisory prose.

**PG011** accepts only explicit qualitative `CRITICAL`, `HIGH`, `MEDIUM`, `MODERATE`, or `LOW` labels present in normalized OSV database or affected-package severity fields. `MODERATE` maps to `MEDIUM`. CVSS vectors described by the [OSV severity schema](https://ossf.github.io/osv-schema/#severity-field) are not converted into qualitative ratings; records without a supported label have unknown severity and do not match PG011. Version filtering is delegated to the documented [OSV package-and-version query](https://google.github.io/osv.dev/post-v1-query/) rather than reimplemented from advisory ranges.

`registries.osv.enabled` defaults to `true`. An explicit `enabled: false` is a deliberate policy opt-out: it is included in the policy digest, reported as provider status `disabled`, and does not produce PG013. An enabled OSV provider that is missing, truncated, or unavailable produces PG013 and the existing evaluation-error channel.

## CLI check boundary

`agenthawk check npm <package-spec>` is a thin orchestrator over the parser, npm provider, OSV provider, and policy engine. It supports terminal or JSON output, an optional strict YAML policy file, strict exit behavior, and a configurable registry URL. Policy files are bounded to 256 KiB, must be regular files, reject duplicate keys and unsupported aliases, and still pass the strict core schema.

Terminal rendering escapes control and ANSI characters. JSON output is validated by the versioned evaluation-report schema and includes canonical SHA-256 policy/evidence digests plus a documented exit-code meaning. Provider failure diagnostics are normalized before rendering or digesting; raw upstream messages are excluded. The command never invokes npm, downloads a tarball, installs a package, or executes lifecycle scripts.

## Approval boundary

Approvals are parsed as strict, bounded YAML and applied only after original policy evaluation. Matching uses the normalized resolved coordinate, never the requested selector. Reports preserve all findings and both verdicts. Only approvable review findings are resolved; errors, non-approvable reviews, and blocks remain effective.
