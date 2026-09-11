# ADR 0024: fixed image-base metadata preflight

## Status and scope

Implemented 2026-09-11 UTC after research, a written scoped plan and independent
design review. Local validation and working-tree review pass; exact-head review,
CI and delivery remain pending for this image-preparation prerequisite.
ADR 0023 was delivered in PR #64 as `28f4425`; all seven checks passed before and
after merge. This slice verifies only two small fixed image-metadata documents.
It does not prepare an image, download layers, contact Docker, start services,
execute the relocated runtime or vendor, activate hooks, or establish support.

## Research and sources

Primary sources accessed 2026-09-11 UTC:

1. Open Container Initiative, [Content Descriptors, v1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md):
   descriptors bind media type, raw byte size and digest. Verify raw bytes before
   interpreting them. Optional remote URLs and embedded content are unnecessary
   for this fixed profile and are not accepted.
2. OCI, [Image Manifest, v1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md)
   and [Image Configuration, v1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/config.md):
   a platform manifest references a configuration and ordered layer descriptors;
   its configuration hash is the image ID. Uncompressed `diff_ids` are distinct
   from compressed layer digests. Neither list proves any layer was obtained.
3. Docker, [Dockerfile reference](https://docs.docker.com/reference/dockerfile/):
   base-image `ONBUILD` instructions can run when a downstream `FROM` is processed.
   Environment and command defaults also require deliberate treatment. A recipe
   with no explicit `RUN` is therefore insufficient proof of non-execution.
4. Docker, [Build best practices](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions):
   tags can move; a digest fixes selected content but requires intentional refresh.
   This development pin is not a promise of current vulnerability status.
5. Node.js, [exact image recipe revision](https://github.com/nodejs/docker-node/blob/c4eb0858f5c522521768d5b6dc1d9f1631d4854d/24/bookworm/Dockerfile)
   and Docker Library, [Bookworm SCM recipe](https://github.com/docker-library/buildpack-deps/blob/master/debian/bookworm/scm/Dockerfile):
   the full Bookworm image builds on buildpack-deps; its SCM recipe includes Git.
   These recipes explain the selection, not independently measured filesystem
   contents or reproducibility. No upstream recipe is executed by this preflight.
6. Moby, [Engine API changelog](https://github.com/moby/moby/blob/master/api/docs/CHANGELOG.md),
   v1.52: unset image volumes/build triggers and container build triggers may be
   omitted. ADR 0019's literal-null inspection profile may reject this shape.
   Actual daemon observation and any narrowly reviewed normalization belong to
   the later preparation boundary; this slice does not weaken that validator.

Anonymous public registry observations used the fixed `library/node` repository.
Small metadata and anonymous pull-token responses were read in memory. The
short-lived anonymous token was used only for public registry reads, never stored
or printed. No account credential, layer, image, source checkout or vendor
executable was transmitted or persisted by this observation.
The public `24.20.0-bookworm` tag selected the Linux/amd64 manifest below. Its
index was 3,881 bytes with SHA-256
`be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2`.
That index is research context, not output evidence of this two-document verifier.

| Fixed input | Raw bytes | SHA-256 |
| --- | ---: | --- |
| Platform manifest | 2,493 | `9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b` |
| Linked configuration | 6,717 | `aa09691f441f07a6d1f076f25470751bff882a4ba88274f3d7f9fa5af542f0ce` |

The manifest advertises eight gzip layers totaling 409,613,156 compressed bytes.
Those are declared sizes, not measured layer bytes. Configuration declares eight
ordered diff IDs, Linux/amd64, the ordinary Node entrypoint and command, and three
environment defaults: PATH, Node 24.20.0 and Yarn 1.22.22. It declares no volume,
port, healthcheck or build trigger. These source defaults are not the final
minimal launch profile: in particular, inherited Node/Yarn environment fields
must not silently enter ADR 0019's container environment.

Confidence is high in the observed metadata equality and cited format semantics.
TLS/registry ownership, upstream build infrastructure and initial pin selection
remain trust assumptions. A hash is neither publisher authentication nor evidence
that this base is benign, patched, runnable or isolated.

## Decision and acceptance criteria

1. Add one dependency-free, development-only verifier for the exact manifest and
   linked configuration. Accept only bounded intrinsic unshared byte views;
   snapshot before hashing. Reject strings, parsed objects, shared memory,
   subclasses, proxies, detached views, wrong sizes and one-byte changes without
   leaking input values or exceptions. No caller-selectable pin or policy factory.
2. Compare each complete raw document to its compiled size/SHA-256 pin before
   decoding. Exact-wire equality also rejects duplicate keys, alternate grammar,
   extra fields, changed media types, embedded data/URLs, platforms, volumes,
   build triggers and inherited execution defaults. These are fixed documents,
   not a general-purpose OCI acceptance policy.
3. Independent fixture-consistency tests bind the manifest's config descriptor to
   the configuration pin and verify the closed reviewed configuration, ordered
   layer descriptors/diff IDs and bounds. Preserve original bytes in small public
   offline fixtures; do not publish raw research, registry tokens or image layers.
4. Only complete success may mint a private metadata capability containing copied
   verified inputs. A clone, proxy, serialized summary or failed result cannot
   retrieve it. Any accessor returns fresh byte copies, never mutable internals.
   This capability attests only to these metadata snapshots; it supplies no
   runtime-tree authority and cannot authorize preparation or launch by itself.
5. Return a frozen bounded summary naming metadata verification and declared layer
   count/size. Every result explicitly denies layer verification, image preparation,
   runtime execution, portability and native support. No paths, raw configuration,
   environment values, annotations, history or exceptions appear in the summary.
6. Adversarial offline tests and strict development checks cover the new module.
   Independently repeat the two original public-byte measurements through the
   production verifier without a daemon. Complete all local gates, staged secret
   review, independent exact-head review, the six-job OS/Node CI matrix and
   post-merge verification.

## Implementation plan and rollback

Expected files: `scripts/fixture-image-base.mjs`, its tests and small public byte
fixtures, coverage and strict development typecheck inventory, this ADR, and
roadmap/implementation/threat-model reconciliation. No package dependency, emitted
package content, product API, provider behavior or support-matrix change.
Rollback is a normal reviewed revert; no local image or runtime state is created.

## Local validation

The verifier intentionally needs no runtime JSON parser: matching both complete
wire documents binds the fixed profile; independent offline fixture tests check
its parsed descriptor/configuration relationships. Original fixtures additionally
passed fatal UTF-8 and duplicate-key inspection with the existing development
parser. Independent fresh public reads passed through the production verifier,
and copied inputs matched the fetched bytes. No layer or daemon was involved.

The full 2026-09-11 local gate passed lint, package typecheck, strict semantic
JavaScript/TypeScript checking of the new code and tests, all 2,914 tests across
62 suites (five existing platform skips), coverage, build, package verification,
CLI help, dependency audit with no known vulnerabilities, and diff checks.
Coverage: 94.88% statements / 92.75% branches / 97.08% functions / 96.72% lines.
The new verifier has 100% coverage in all four measures. Independent review
separately passed all 13 focused tests and strict checks. Review repaired shared
memory disguised with an ArrayBuffer prototype; intrinsic branding and regression
tests now reject it. Package inventories remain core 38 files / 198,888 bytes
and CLI 58 files / 350,819 bytes. Exact-head review and CI still gate delivery.

## Next boundary

After delivery, image preparation still requires actual bounded layer acquisition,
verified fresh runtime/vendor inputs, a reviewed fixed construction method that
cannot inherit build triggers or execution defaults, independent image inspection,
and a secretless disposable hosted gate. Do not use workstation Docker or publish
vendor-containing images. Fixed isolated own-runtime smokes follow image preparation;
the bounded vendor driver, activation matrix and support decisions remain separate.
