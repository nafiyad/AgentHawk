# Provider research

Accessed: 2026-08-19

## Provider selection

V1 uses the configured npm-compatible registry for package metadata and OSV.dev for known vulnerabilities/malicious-package records. deps.dev is deferred as optional supporting evidence: it is useful for project, license, dependency, and advisory context but must not become an unexplained trust score or a second source of truth for registry resolution.

## npm registry

The public registry exposes package documents containing versions, dist-tags, time data, repository/deprecation fields, and version manifests including scripts. These shapes are operational APIs rather than a strong, versioned security contract; the provider must validate a deliberately small subset and tolerate unrelated fields. Scoped package names require percent encoding. A 404 distinguishes absence; authentication and private-registry failures must not be reported as nonexistence.

Registry configuration creates privacy risk. V1 should accept an explicit registry base URL and default to the public registry. It must not parse or forward `.npmrc` credentials. Redirects are bounded and must not cause credentials to cross origins.

## OSV

`POST /v1/query` accepts ecosystem, package name, and version. `querybatch` preserves request ordering but returns summary IDs and may paginate; individual records require follow-up retrieval. The API documentation currently states no request rate limit and documents a 32 MiB HTTP/1.1 response limit, but AgentHawk must impose a much smaller local bound and map future 429 responses deterministically.

Severity is optional and may exist at top-level or affected-package level. AgentHawk records source data as supplied and must not synthesize a severity label. Records using the malicious-package convention must be matched exactly and surfaced with their record IDs.

## deps.dev

The stable v3 API provides package, version, dependency, project, and advisory information. It is valuable for later enrichment and cross-links. It is not required for the smallest alpha because it overlaps registry/OSV facts, adds availability coupling, and does not provide a universal package trust verdict.

## Provenance, Sigstore, and SLSA

npm provenance uses Sigstore attestations to associate an artifact with a public source repository and build workflow. Trusted publishing uses short-lived OIDC credentials and can automatically generate provenance for supported public CI workflows. Provenance helps verify origin and build identity; it does not prove code is benign, reviewed, or uncompromised. Automated verification without downloading/installing artifacts needs more research, so v1 records observable provenance as supporting evidence only or defers it.

## HTTP contract

All providers use one native-`fetch` client with TLS-only remote URLs, local HTTP allowed only in tests, explicit timeouts, bounded redirects and retries, body-size limits, content-type/schema checks, redacted diagnostics, and stable errors: `timeout`, `rate_limited`, `invalid_response`, `not_found`, `network_error`, `provider_error`.

## Sources

| Source | Organization | Finding | Confidence/limitation | Decision |
|---|---|---|---|---|
| [npm registry](https://docs.npmjs.com/misc/registry/) | npm | Registry and scope configuration determine resolution | Official; compatible registries vary | Explicit provider boundary |
| [npm package spec](https://docs.npmjs.com/cli/v11/using-npm/package-spec) | npm | Multiple non-registry spec forms exist | Versioned CLI docs | Parse and classify before network use |
| [OSV API](https://google.github.io/osv.dev/api/) | OSV | Query and batch endpoints, current limits, and response behavior | Service behavior may change | Bound locally; support batch architecture |
| [OSV querybatch](https://google.github.io/osv.dev/post-v1-querybatch/) | OSV | Ordered batch summaries and pagination | Summary requires record fetch | Design batch-ready provider |
| [deps.dev API v3](https://docs.deps.dev/api/v3/) | Google Open Source Insights | Stable API for package/version/dependency/project/advisory data | Coverage varies by ecosystem | Optional enrichment, not verdict authority |
| [Trusted publishing](https://docs.npmjs.com/trusted-publishers/) | npm | OIDC replaces long-lived publish tokens and can emit provenance | Provider/workflow constraints | Recommend for AgentHawk releases later |
| [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/) | npm | Provenance links package to build/source and can be verified | Verification often assumes downloaded dependencies | Do not claim benignness |
| [SLSA provenance v1.2](https://slsa.dev/spec/v1.2/provenance) | SLSA | Standard model for artifact build provenance | Attestation strength depends on producer | Treat as origin evidence |
