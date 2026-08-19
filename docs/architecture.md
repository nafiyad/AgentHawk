# Architecture

## Current boundary

AgentHawk currently provides a reusable core for parsing npm dependency requests and gathering normalized npm registry metadata. It does not yet make policy decisions or expose `agenthawk check`.

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
```

## Input model

Registry inputs are separated from aliases, Git references, URLs, file/directory paths, and workspace references before network access. Registry names use a conservative lowercase npm grammar. Selectors are classified with the canonical `semver` implementation as exact versions, ranges, tags, or the default wildcard.

Non-registry inputs are not fetched by the npm provider. A later policy rule will report them as explicit review findings.

## HTTP safety boundary

All provider traffic uses `SafeHttpClient`. Remote URLs require HTTPS; HTTP is permitted only for loopback fixture servers. Credentials in URLs are rejected. Requests use explicit time, body, redirect, and retry bounds. Redirects are handled manually and revalidated. Responses must be successful JSON with valid UTF-8 and fit within the byte limit.

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

The policy schema rejects unknown fields at every security-sensitive level. Known-malicious handling remains fixed to `block`; OSV-backed PG010/PG011 evaluation will be added in its dedicated provider milestone.
