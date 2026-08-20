# Architecture

## Current boundary

AgentHawk provides npm request parsing, normalized registry and OSV evidence, deterministic policy evaluation, `check`, `scan`, `diff`, and `policy validate` commands, exact expiring approvals, a bounded public-metadata cache, read-only GitHub evaluation with an isolated opt-in write commenter, advisory agent templates, and trust-separated release-package verification and staging.

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

The provider also does not surface npm attestation advertisements as verified provenance. [ADR 0008](adr/0008-provenance-verification-boundary.md) distinguishes cryptographic binding to registry metadata from independent verification of artifact bytes and records the requirements for any future provenance provider.

## Deterministic policy boundary

The policy engine consumes a parsed npm spec, validated policy, normalized provider result, an explicit evaluation clock, and optional existing direct dependency names. Independent rules emit structured `PG` findings; they never perform network access, install dependencies, or execute lifecycle scripts.

Implemented rules are PG001 through PG007, PG010, PG011, PG013, PG014 (in `diff`), and PG015. PG003 also enforces the explicit prerelease policy when a resolved version is a prerelease. Name-similarity checks are intentionally conservative: scope changes, separator-only changes, one edit, or one adjacent transposition are considered only for names of useful minimum length. A match is a review heuristic, not proof of maliciousness. `agenthawk scan` evaluates PG005 for each entry against the manifest's other direct dependency names; a standalone `check npm` has no dependency context and does not emit PG005.

PG002 and PG003 use separate, configurable age signals. The default 30-day package-identity window and 72-hour selected-release window are review heuristics, not trust scores. Their rationale, real-project sensitivity sample, boundary semantics, and limitations are recorded in [ADR 0007](adr/0007-policy-age-thresholds.md).

Verdicts use stable precedence: `error` > `block` > `review` > `warn` > `allow`. Findings are sorted by rule identifier. Missing, failed, or incomplete required provider evidence produces a PG013 review finding rather than silently allowing the dependency; an explicit digest-visible provider opt-out (`enabled: false`) is reported as status `disabled` and does not produce PG013. Strict mode adds a separate typed evaluation error and makes the PG013 finding non-approvable; it does not widen the stable finding-verdict schema. `onUnknownVersion: error` uses the same separate error channel while preserving the underlying PG001 block finding.

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

`agenthawk check npm <package-spec>` is a thin orchestrator over the parser, npm provider, OSV provider, cache, and policy engine. It supports terminal or JSON output, an optional strict YAML policy file, strict exit behavior, a configurable registry URL, `--offline`, and `--no-cache`. Policy files are bounded to 256 KiB, must be regular files, reject duplicate keys and unsupported aliases, and still pass the strict core schema.

`agenthawk policy validate --file <path>` uses that same production file reader and strict core schema without resolving a package, opening the metadata cache, or contacting npm/OSV. Success reports only the normalized policy version/mode and deterministic digest; invalid policy uses the shared bounded CLI error envelope and exit `2`.

Only successful normalized public provider results enter the cache, and credential-bearing URL fields are removed first. npm entries expire after one hour and OSV entries after 15 minutes. Online checks always use live providers. Offline fresh entries can supply provisional findings but always add PG013 because local cache data is unauthenticated; they can never produce a clean admission. Offline cache misses, corruption, and staleness perform no network request and become visible provider failures. See [ADR 0004](adr/0004-cache-location.md).

Terminal rendering escapes control and ANSI characters. JSON output is validated by the versioned evaluation-report schema and includes canonical SHA-256 policy/evidence digests plus a documented exit-code meaning. Provider failure diagnostics are normalized before rendering or digesting; raw upstream messages are excluded. The command never invokes npm, downloads a tarball, installs a package, or executes lifecycle scripts.

## Scan and Git diff boundary

`agenthawk scan` reads only the repository-root `package.json`, bounded to 1 MiB and requiring a regular non-symlink UTF-8 JSON file without duplicate keys. It accepts at most 64 direct entries with bounded names/specifiers, evaluates them as one bounded parallel set through the same npm/OSV/policy/approval pipeline as `check npm`, preserves the manifest section, combines verdicts by deterministic precedence, and caps serialized output at 2 MiB. It does not traverse installed packages or execute manifest scripts.

`agenthawk diff --base <git-ref>` resolves the requested ref to an immutable commit before reading the base manifest. Git is invoked directly with argument arrays, a sanitized Git environment, fatal UTF-8 decoding, bounded output and time, disabled external diff/text conversion, no pager, no terminal prompts, and no shell. The comparison reports direct additions, requested-version changes, and section moves. PG014 requires at least one recognized root lockfile to be both updated and still present as a regular non-symlink file. This establishes correlation, not proof that a lockfile is semantically correct.

## Approval boundary

Approvals are parsed as strict, bounded YAML and applied only after original policy evaluation. Matching uses the normalized resolved coordinate, never the requested selector. Reports preserve all findings and both verdicts. Only approvable review findings are resolved; errors, non-approvable reviews, and blocks remain effective.

## GitHub reporting boundary

The pull-request workflow runs with read-only repository permission on untrusted PR code, uses immutable action pins, disables credential persistence, and uploads a bounded JSON diagnostic. Optional PR comments are isolated in a `workflow_run` job that never checks out or executes PR code. It validates and labels the artifact as untrusted diagnostic data, escapes hostile rendering content, and performs a bounded idempotent bot-comment search. See [ADR 0006](adr/0006-github-action-security.md).

## Agent-instruction boundary

Codex, Claude Code, Cursor, and generic templates require strict JSON evaluation before dependency installation and fail closed on unavailable tooling, malformed reports, or review/block/error decisions. An allow may proceed and a warning must be surfaced. These files guide model behavior; they are not an enforcement boundary. Host permissions and protected CI remain authoritative.

## Release-package boundary

Both `0.1.0-alpha.1` packages are public and carry persistent npm dual-use metadata plus packaged disclosures. Their registry tarballs match the approved CI artifacts, and the CLI has an exact `0.1.0-alpha.1` dependency on core. The offline package gate validates exact canonical dry-run and real-tarball manifests, tar header checksums, intermediate path components as non-symlink directories, final entries as regular non-symlink files, bounded positive size metadata, required consumer documentation/license/disclosure, shared runtime version, core/CLI entrypoint startup, and the packed CLI's exact core dependency. It cannot publish.

The release workflow separates build authority from publishing identity. The credential-free `prepare` job must run at the exact current `main`, executes the full quality gate, verifies an integrity-pinned npm CLI, and uploads a five-file checksummed bundle. Manual dispatch ends there. Only an exact version tag can request the `stage` job; that job is protected by `npm-release`, has OIDC but no repository-content permission, performs no checkout or project execution, verifies the same-run bundle, and calls `npm stage publish` in core-then-CLI order. npm 2FA promotion remains a maintainer action.

Because npm cannot configure a trusted publisher or stage a package before its name exists, the first version used an approved one-time interactive bootstrap from the exact CI artifact. That completed exception used no automation token and has no provenance attestation. Both packages now restrict OIDC to `npm stage publish`, reject bypass-2FA token publication, and bind to `nafiyad/AgentHawk`, `release.yml`, and `npm-release`; all later versions use this stage-only path. See [release operations](releasing.md) and [ADR 0009](adr/0009-release-publishing-security.md).
