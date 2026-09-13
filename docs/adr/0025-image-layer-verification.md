# ADR 0025: bounded fixed image-layer verification

## Status and scope

Implemented 2026-09-13 UTC following the written plan accepted 2026-09-12 UTC
after primary-source research and independent design review. Working-tree review
and the full local gate pass; exact-head review and hosted delivery gates remain open. PR #65
delivered ADR 0024 as `2edd305`; its reviewed head was `c330bf7` and all six checks
passed before and after merge. Clean local/remote main, no open PR/issues and
that exact-main CI were reverified before starting this single slice.

Acquire only the eight compressed layer blobs declared by the already fixed
Linux/amd64 base metadata. Stream into a new private directory, independently
reopen and hash all stored bytes, and retain non-executable data without extracting
or interpreting it. No image construction, Docker/service invocation, runtime or
vendor launch, image publication, hook activation or native support is included.

## Research and sources

Primary sources accessed 2026-09-12 UTC:

1. Open Container Initiative, [Distribution Specification v1.1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md),
   pulling blobs: use the repository-scoped digest endpoint and independently
   verify returned content. Response digest headers are not substitute evidence.
2. OCI, [Content Descriptors v1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md#verification):
   verify content size and digest before expensive interpretation. This slice
   measures compressed bytes only; uncompressed diff IDs are still declarations.
3. CNCF Distribution, [HTTP API V2, pulling a layer](https://distribution.github.io/distribution/spec/api/#pulling-a-layer):
   registry blob GET may redirect with HTTP 307. Range/caching facilities exist,
   but this fixed verifier deliberately does not resume, retry, or adopt caches.
4. Docker, [Registry authentication](https://docs.docker.com/reference/api/registry/auth/):
   public pulls can obtain an anonymous scoped Bearer token. Token/access_token
   fields can coexist; conflicting values must reject. This command fixes its
   own realm, service and pull-only repository scope, never follows challenges
   to arbitrary endpoints and never reads a Docker credential store.
5. Docker, [Desktop domain allowlist](https://docs.docker.com/desktop/setup/allow-list/):
   the current list names `auth.docker.io`, `registry-1.docker.io`, and
   `production.cloudfront.docker.com`. A wildcard CDN policy is unnecessary.
   Other historic CDN names are not justified by this current document.
6. Node.js, [HTTP API](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#class-httpincomingmessage)
   and [filesystem API](https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html):
   complete HTTP message parsing differs from socket closure, and writes may be
   partial. Reuse tracked storage settlement and independently fence identity,
   size, timestamps and EOF. Cancellation is not proof that kernel I/O stopped.
7. GitHub, [Secure use](https://docs.github.com/en/actions/reference/security/secure-use),
   [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
   and [variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables):
   use unprivileged PR/main triggers, minimum read permission, immutable action
   pins, exact source checkout without retained credentials, and explicit hosted
   Linux/X64 guards. The verifier receives a cleared environment. A disposable
   job is not a security guarantee against a compromised runner or action.

Independent small public observations matched both ADR 0024 raw metadata pins:
manifest 2,493 bytes and configuration 6,717 bytes. Configuration GET returned a
307 to the exact documented CloudFront host; the anonymous registry Bearer was
removed before the CDN request. Its digest-bound path had the form
`/registry-v2/docker/registry/v2/blobs/sha256/<prefix>/<hex>/data` and exactly the
query keys `Expires`, `Signature`, `Key-Pair-Id`. The signed URL was 558 bytes.
The anonymous token response was 5,485 bytes with exactly `token`, `access_token`,
`expires_in`, `issued_at`; token length was 2,696 bytes. These are observed shapes,
not a promise of future service behavior. No token or signed value was logged.
One fixed layer HEAD returned 200 and no body: it does not prove layer GET shape
or layer bytes. Actual complete acquisition remains an implementation/hosted gate.

Confidence is high in the cited protocol primitives and measured metadata, not in
unobserved blob transport or filesystem behavior. Initial pins, TLS roots, DNS,
registry/CDN ownership, trusted development code and the host kernel remain trust
assumptions. Hash equality is neither publisher authentication nor benignness,
vulnerability status, decompression validation, portability or isolation.

## Decision and acceptance criteria

1. The production Linux-only command accepts one new absolute destination and no
   URL, hash, token, metadata file, receipt, profile or success-boolean override.
   Acquire fresh exact metadata through the fixed transport and ADR 0024 verifier
   before selecting descriptors. Its private metadata capability, not its public
   JSON fields, yields the exact ordered eight-layer plan. Reject forged results
   before any layer request or output creation. No filesystem name comes from
   server headers, annotations or a signed URL.
2. Add a separate Docker transport; do not loosen existing Claude/npm downloader
   policies. Native HTTPS uses normal TLS validation, no proxy environment,
   cookies, account credentials, automatic decompression or automatic redirects.
   Obtain a bounded anonymous token from the fixed auth endpoint for each resource;
   send it only to the exact registry origin. No token refresh, credentials prompt,
   challenge-driven realm, range/resume or retry is allowed.
3. Accept only 200 bodies and at most one 307 from a fixed registry blob endpoint
   to HTTPS port 443 on the exact CloudFront host and exact requested digest-bound
   path. Reject credentials, fragments, path aliases, extra/duplicate query keys,
   controls and over-bound URLs. Never send Bearer, cookies or referrer to the CDN.
   Token and manifest endpoints cannot redirect. Unknown status/host/framing is a
   fixed redacted failure; rate limiting never becomes a partial success.
4. Bound raw headers to 8 KiB and 32 fields; validate before discarding non-authority
   cookie/checksum metadata. Reject duplicate security fields, conflicting length
   and transfer framing, content range, non-identity content encoding and trailers.
   Count actual raw body bytes independently of headers. Bound token JSON to
   16 KiB, tokens to 4 KiB, redirect URLs to 2 KiB and streamed chunks to 64 KiB.
   Preserve complete/end plus request/response/socket closure observations before
   another hop or blob. Never report destruction requests as confirmed closure.
5. Download sequentially, at most eight blobs, maximum 211,662,335 bytes per blob
   and exactly 409,613,156 aggregate compressed bytes. Bound small requests to
   20 seconds, each blob operation including authentication/redirect to 180 seconds,
   total acquisition/storage to 20 minutes, and network close grace to five seconds.
   Permit at most 65,536 chunks per blob and 1,024 per small response, and 262,144
   attempted filesystem operations across the full run (including short reads,
   writes, EOF, enumeration and identity fences). These reject pathological
   one-byte progress. Use at most 64 path components and 4,096 UTF-8 path bytes.
   Existing bounded storage limits operations to 30 seconds and settlement to five.
   An outer disposable-hosted job has a 30-minute limit. These are rejection
   limits, not throughput promises; no threshold weakening after a failed gate.
6. Reuse `createBoundedRuntimeStorage` with a fresh private 0700 directory, safe
   canonical owned/root-owned ancestors (immediate parent must be owned by the
   active UID), and exclusive no-follow 0600 regular single-link files. Inventory
   is exactly eight fixed digest-derived filenames, with at most nine enumeration
   reads including EOF/extra-entry detection; no receipt is an allowed extra file.
   Never overwrite, adopt, link, extract or automatically delete
   output. Track uncertain creation before starting writes and retain partial state
   on failure. Bound partial-write loops and copy byte chunks before asynchronous
   consumption; reject shared memory, forged views and unexpected sizes.
7. For every layer compare streamed size/SHA-256 to its exact descriptor, sync and
   close the file, then independently reopen with no-follow and remeasure actual
   stored bytes, including extra EOF checks. Validate pre/open/post identity,
   owner, mode, link count, size and timestamps. After all layers, repeat complete
   directory inventory and final file/ancestor identity/content fences. Missing,
   extra, replaced, linked or changed state cannot mint a complete result.
8. Keep first-cause cancellation sticky. Unknown network, sink or filesystem
   settlement remains `closure_unconfirmed`, ahead of cancellation or generic
   failure. No next request or write after cancellation; admitted operations must
   settle before a success or confirmed-failure claim. Partial output is retained.
9. A frozen minimum-disclosure result names only the fixed metadata binding,
   measured layer count/bytes and closed failure states. Successful production
   results may carry private point-in-time storage observations only after all
   handles settle. Clones, JSON and synthetic test-world results cannot recover
   production evidence. Any later consumer must independently revalidate files;
   this is not immutable byte storage or permission to extract/build/launch.
   `imagePrepared`, `executed`, `isolated`, `portableRuntime`, and `nativeSupport`
   remain false. Failure keeps layer verification false.
10. Offline tests use inert small synthetic blobs and trusted transport/filesystem
    seams; their private evidence is isolated from the production instance and
    cannot replace real fixed-pin evidence. Cover input/capability forgery, every
    framing/redirect boundary, no credential forwarding, mismatches, short/extra
    I/O, mutation, ownership, inventory, cancellation and late/unconfirmed closure.
    A secretless GitHub-hosted Linux gate must verify all eight actual fixed blobs
    without extraction, execution, artifact upload, cache or Docker. Exact-head
    independent review plus all local and pre/post-merge CI gates precede delivery.

## Alternatives, implementation and rollback

Retaining copied buffers for roughly 410 MB would increase peak memory and leave
unclear lifetimes. Hash-and-discard would be smaller but provide no retained input
for later preparation. A private flat blob store reuses the existing tracked I/O
model and permits independent measurement. It remains a point-in-time snapshot:
same-account/privileged writers and hostile filesystems are residual risks.

Expected files: fixed layer policy/plan, separate Docker downloader and tests,
layer verification/storage command and tests, hosted verification workflow, strict
development checking and coverage inventory, this ADR and synchronized roadmap,
implementation plan and threat model. No new dependency or public CLI/package
contract. A normal reviewed revert rolls back code; retained destinations require
owner review and are never recursively removed by the verifier.

## Implementation validation

The production metadata-only probe matched both fixed documents through the new
transport and selected eight descriptors / 409,613,156 declared compressed bytes.
No layer bytes were downloaded on the owner machine. The command's invalid-input
and unsupported-Windows smokes return bounded failure JSON without output creation.
An independent working-tree review passed all 223 focused offline tests and strict
semantic checking without a blocking finding. Review covers the separate downloader,
private fixed plan, tracked writer/rereader, storage type boundary and hosted workflow.

The initial complete-suite attempt exposed a five-second test-harness timeout in
the 262,144 attempted-I/O regression. Both expensive count-bound regressions now
have a 30-second harness deadline while retaining the exact production bounds,
all attempted operations and cleanup assertions. Transport timeout/cancellation
codes also receive accurate fixed failure labels instead of a storage-failure
fallback. The final complete suite and coverage run each pass 3,137 tests across
66 suites, with five existing platform skips. Coverage is 94.87% statements /
92.89% branches / 97.04% functions / 96.72% lines; all existing 90% aggregate
thresholds remain unchanged. Lint, package typechecks, explicit strict semantic
checking of the development modules/tests, build, package-content verification,
CLI smokes, dependency audit and diff checks pass. Public package inventories are
unchanged: core 38 files / 198,888 bytes, CLI 58 files / 350,819 bytes.
Actual hosted layer verification and exact-head/pre/post-merge checks remain gates;
local fixture success does not prove complete acquisition or delivery.

Next: separately reviewed image construction and independent inspection, then
isolated own-runtime smokes, bounded vendor driver, activation and support gates.
