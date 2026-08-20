# Threat model

## Scope

This threat model covers npm request parsing, registry and OSV evidence retrieval, deterministic policy evaluation and validation, exact expiring approvals, the bounded public-metadata cache, direct dependency inventory, Git diff analysis, GitHub pull-request reporting, agent instruction templates, release-package verification, and npm staging.

## Assets

- developer workstation and repository integrity;
- source code and repository metadata;
- environment variables and package-registry credentials;
- the integrity and availability of AgentHawk reports;
- the distinction between direct evidence and unverified metadata.
- release artifact integrity and the npm publishing identity.

## Trust boundaries

Package specifications, registry URLs, registry responses, redirects, HTTP status codes, metadata strings, and repository configuration are untrusted. The npm registry is an evidence source, not a trust authority. AgentHawk's normalized internal model is trusted only after schema validation.

Policy configuration is also untrusted input. Strict schemas reject unknown nested fields, numeric thresholds must be non-negative, and the known-malicious action cannot be weakened below `block`.

## Abuse cases and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Spec smuggles a URL, Git ref, alias, or local path | Parse/classify before provider access | npm grammar evolves; unsupported valid forms may require review |
| Control characters or whitespace alter logs/requests | Reject them during parsing | Unicode confusables require later policy handling |
| Registry URL leaks embedded credentials | Reject username/password components | External proxy configuration is outside this boundary |
| Redirect escapes to an unsafe protocol | Manual bounded redirects; validate every target | HTTPS endpoint itself may be malicious |
| Provider hangs or streams indefinitely | Abort timeout and byte-counted stream reads | Network resource use exists within the configured bounds |
| Provider returns huge, malformed, or non-JSON data | Content-length and streaming limits, UTF-8 and JSON validation | Runtime/parser vulnerabilities remain possible |
| Provider error becomes implicit success | PG013 review; strict mode adds a typed evaluation error and makes the finding non-approvable | Provider availability can still interrupt evaluation |
| Invalid or impossible provider timestamps influence age rules | Strict calendar validation at provider and policy boundaries | A valid timestamp remains registry-supplied evidence, not independent proof |
| Hostile body or exception leaks secrets | Fixed diagnostic messages; never include bodies, URLs, headers, or caught details | Host-level logs outside AgentHawk are not controlled |
| Lifecycle script executes during inspection | Read script names only; never install or execute | Malicious code without lifecycle scripts is not detected |
| Metadata claims a false repository, integrity value, or provenance advertisement | Treat it as registry evidence, not proof of benignness; do not label attestation presence as verified provenance | Metadata-only cryptographic binding and artifact-byte verification remain deferred under [ADR 0008](adr/0008-provenance-verification-boundary.md) |
| Strong finding is hidden by a weaker finding | Fixed error > block > review > warn > allow precedence | Policy actions can intentionally suppress approvable rules |
| Similar-looking name is treated as proof | Label PG005 as a heuristic and require review | Conservative matching can still produce false positives or miss confusables |
| Policy YAML exhausts memory or expands aliases | Require a regular file, enforce a 256 KiB bound, reject duplicate keys and aliases | Local filesystem races remain possible within the bounded read |
| Standalone validation exposes policy contents, local paths, or provider data | Return only normalized version/mode and a deterministic digest; use fixed redacted errors; perform no provider/cache operation | The digest intentionally reveals when two normalized policies are equivalent |
| Provider diagnostics leak through reports or digests | Fixed rendered messages and normalized failure digest inputs | Timing and provider status remain observable by design |
| Hostile text injects terminal controls | Escape C0/C1 control characters before terminal output | Terminal behavior outside standard control ranges is platform-dependent |
| OSV POST is redirected or oversized | Bound request bodies; reject POST redirects; reuse HTTPS/credential/timeout limits | The OSV endpoint itself may return hostile JSON within the body limit |
| A partial OSV page is treated as complete | Follow `next_page_token`; truncated pagination is PG013 | OSV may still omit records that exist outside the query window |
| Abbreviated batch matches are used as findings | Hydrate `/v1/vulns/{id}` and validate before PG010/PG011 | Hydration failure fail-closes the evaluation |
| CVSS vectors are converted into guessed ratings | Use documented qualitative labels only; unknown severity does not match PG011 | Advisories that publish only vectors are not severity-matched |
| Disabling OSV is confused with provider failure | Explicit `registries.osv.enabled: false` is digest-visible status `disabled` | Operators can disable a required evidence source |
| Broad, stale, or forged approval weakens policy | Strict exact coordinates, required reason/times, maximum validity, and preserved findings | Repository writers can still authorize approvable review findings |
| Cache poisoning, traversal, oversized data, or stale evidence creates false confidence | Provider-aware hashed keys, strict bounded schema, regular-file and timestamp checks, credential stripping, provider payload validation, live-only online admission, and mandatory PG013 for offline cache use | A local-account attacker can forge provisional findings or deny service, but cannot obtain a clean cached admission |
| Hostile Git ref, environment, or repository config redirects analysis or causes execution | Resolve refs with `--end-of-options`; sanitize inherited `GIT_*` variables; use direct argument arrays, immutable commit IDs, fatal UTF-8, disabled external diff/text conversion, bounded execution, and no shell | The trusted local Git executable and operating system remain in the boundary |
| Manifest changes without regenerated resolution data | PG014 correlates direct dependency changes with a recognized lockfile diff from the same base | A changed lockfile is not proof that its contents correctly resolve the manifest |
| Approval overrides a hard security result | Resolve only approvable review findings; never resolve blocks, errors, or non-approvable reviews | Incorrect `approvable` classification in a future rule remains a code-review risk |
| Pull-request content gains privileged workflow authority | Evaluate in an unprivileged `pull_request` workflow; isolate the opt-in commenter in a non-executing `workflow_run`; validate, label, escape, and bound artifacts before rendering | A diagnostic comment is not authoritative and GitHub remains in the trust boundary |
| Hostile report text breaks Markdown or terminal rendering | Escape Markdown structure, HTML, links, C0/C1 controls, DEL, and bidirectional controls; cap rendered summaries and comment searches | New rendering contexts require separate escaping review |
| Agent instruction text is mistaken for enforcement | Templates state that they are advisory, fail closed on unknown outcomes, preserve host permissions, and require protected CI | A compromised or disobedient agent can ignore prompt-level instructions |
| Release tarball omits runtime code, changes dependency linkage, or includes sensitive/development files | Exact canonical dry-run and tar manifests, tar-header validation, non-symlink intermediate directories, regular non-symlink final files, size bounds, metadata locks, packed dependency validation, and entrypoint smoke tests | A reviewed allowlist can still intentionally include vulnerable code |
| Untrusted build code steals a publishing identity | Keep the build/test job credential-free; grant OIDC only to a protected job that performs no checkout, project install, project script, or package-code execution | Pinned GitHub and npm tooling remain supply-chain trust dependencies |
| A substituted or cross-run artifact is staged | Same-run artifact name binds the full commit SHA; require an exact five-file set, SHA-256 checks, strict release manifest, exact version/source identity, and an integrity-pinned npm CLI | GitHub artifact storage and runner integrity remain external dependencies |
| CI directly makes a dual-use package public | Restrict the npm trusted publisher to `npm stage publish`; require protected-environment review and separate npm 2FA promotion; store no npm token | An authorized maintainer can still approve a harmful or mistaken staged release |
| Bootstrap credentials or artifacts are misused | Permit one interactive 2FA bootstrap only for exact manually dispatched CI artifacts, core before CLI; prohibit automation tokens, rebuilds, and silent procedure changes | The first version lacks OIDC provenance and the maintainer workstation is temporarily trusted |
| Provenance is overstated | Describe provenance only as source/build linkage and explicitly record the bootstrap version's absence of attestation | Trusted publishing does not prove code is benign; npm and GitHub remain external trust dependencies |

## Unsupported claims

A successful provider result does not mean a package is safe, benign, maintained, uncompromised, or free of vulnerabilities. It means the configured registry returned a validated metadata shape for the selected coordinate at evaluation time.
