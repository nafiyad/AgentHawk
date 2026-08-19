# Threat model

## Scope

This threat model covers npm request parsing, registry and OSV evidence retrieval, deterministic policy evaluation, exact expiring approvals, the bounded public-metadata cache, direct dependency inventory, and Git diff analysis. GitHub reporting will extend it later.

## Assets

- developer workstation and repository integrity;
- source code and repository metadata;
- environment variables and package-registry credentials;
- the integrity and availability of AgentHawk reports;
- the distinction between direct evidence and unverified metadata.

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
| Metadata claims a false repository or integrity value | Treat as registry evidence, not proof of benignness | Independent verification is deferred |
| Strong finding is hidden by a weaker finding | Fixed error > block > review > warn > allow precedence | Policy actions can intentionally suppress approvable rules |
| Similar-looking name is treated as proof | Label PG005 as a heuristic and require review | Conservative matching can still produce false positives or miss confusables |
| Policy YAML exhausts memory or expands aliases | Require a regular file, enforce a 256 KiB bound, reject duplicate keys and aliases | Local filesystem races remain possible within the bounded read |
| Provider diagnostics leak through reports or digests | Fixed rendered messages and normalized failure digest inputs | Timing and provider status remain observable by design |
| Hostile text injects terminal controls | Escape C0/C1 control characters before terminal output | Terminal behavior outside standard control ranges is platform-dependent |
| OSV POST is redirected or oversized | Bound request bodies; reject POST redirects; reuse HTTPS/credential/timeout limits | The OSV endpoint itself may return hostile JSON within the body limit |
| A partial OSV page is treated as complete | Follow `next_page_token`; truncated pagination is PG013 | OSV may still omit records that exist outside the query window |
| Abbreviated batch matches are used as findings | Hydrate `/v1/vulns/{id}` and validate before PG010/PG011 | Hydration failure fail-closes the evaluation |
| CVSS vectors are converted into guessed ratings | Use documented qualitative labels only; unknown severity does not match PG011 | Advisories that publish only vectors are not severity-matched |
| Disabling OSV is confused with provider failure | Explicit `registries.osv.enabled: false` is digest-visible status `disabled` | Operators can disable a required evidence source |
| Broad, stale, or forged approval weakens policy | Strict exact coordinates, required reason/times, maximum validity, and preserved findings | Repository writers can still authorize approvable review findings |
| Cache poisoning, traversal, oversized data, or stale evidence creates false confidence | Provider-aware hashed keys, strict bounded schema, regular-file and timestamp checks, credential stripping, provider payload validation, live-only online admission, and mandatory PG013 for offline cache use | A local-account attacker can forge provisional findings or deny service, but cannot obtain a clean cached admission |
| Hostile Git ref or repository config causes command injection or code execution | Resolve refs with `--end-of-options`; use direct argument arrays, immutable commit IDs, disabled external diff/text conversion, bounded execution, and no shell | The trusted local Git executable and operating system remain in the boundary |
| Manifest changes without regenerated resolution data | PG014 correlates direct dependency changes with a recognized lockfile diff from the same base | A changed lockfile is not proof that its contents correctly resolve the manifest |
| Approval overrides a hard security result | Resolve only approvable review findings; never resolve blocks, errors, or non-approvable reviews | Incorrect `approvable` classification in a future rule remains a code-review risk |

## Unsupported claims

A successful provider result does not mean a package is safe, benign, maintained, uncompromised, or free of vulnerabilities. It means the configured registry returned a validated metadata shape for the selected coordinate at evaluation time.
