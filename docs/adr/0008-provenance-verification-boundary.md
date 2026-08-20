# ADR 0008: Defer provenance policy until artifact binding is explicit

Status: accepted
Date: 2026-08-19

## Context

npm packages may advertise Sigstore attestations in version metadata. AgentHawk already normalizes the selected package name, version, registry-provided integrity, repository URL, and tarball URL, but it deliberately does not download the tarball or treat registry metadata as independent proof.

The open design question was whether AgentHawk could verify npm provenance without downloading package artifacts. The answer depends on what “verify” means:

- A client can cryptographically verify the attestation bundles and bind their subject to the package name, version, and registry-provided integrity digest without downloading the tarball.
- A client cannot independently prove that the future tarball bytes match that digest unless it downloads and hashes those bytes.

Those are different security claims and must not share one undifferentiated “provenance verified” label.

## Evidence

npm provenance contains a build-provenance attestation and a registry publish attestation. npm documents `npm audit signatures` as its supported consumer verifier; that command operates on downloaded dependencies in a project tree. The underlying npm Pacote implementation is narrower: when asked to verify an exact registry manifest, it retrieves the advertised attestation endpoint, validates the signed bundles, compares the in-toto subject PURL with the exact package coordinate, and compares the subject SHA-512 with the packument integrity digest. It does not need to fetch the tarball for those metadata checks.

SLSA's artifact-verification guidance requires a verifier to compare the provenance subject with the digest of the artifact in question, validate the provenance signature and predicate type, establish a trusted builder identity, and compare build parameters and source identity with policy-owned expectations. Sigstore likewise describes artifact verification as checking the signature, certificate identity and trust root, transparency-log inclusion, and the signed artifact digest.

Authoritative sources, accessed 2026-08-19:

- [npm: Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [npm: Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/)
- [npm: `audit signatures`](https://docs.npmjs.com/cli/v11/commands/npm-audit/#audit-signatures)
- [npm provenance implementation notes](https://github.com/npm/provenance)
- [Pacote exact-manifest attestation verification](https://github.com/npm/pacote/blob/c82bdcdd8010a9a87c95e1e09b0ba51322b4f93f/lib/registry.js)
- [Sigstore overview and verification model](https://docs.sigstore.dev/about/overview/)
- [SLSA v1.2: Verifying build artifacts](https://slsa.dev/spec/v1.2/verifying-artifacts)
- [SLSA v1.2 build-provenance predicate](https://slsa.dev/spec/v1.2/build-provenance)

## Live metadata check

During the 2026-08-19 review, a metadata-only check of `zod@4.4.3` observed:

- an npm packument integrity value and registry signature;
- an advertised npm attestation URL;
- one npm publish-attestation bundle;
- one `https://slsa.dev/provenance/v1` bundle;
- the exact subject `pkg:npm/zod@4.4.3`; and
- a subject SHA-512 equal to the hexadecimal form of the packument's base64 SHA-512 integrity value.

This check inspected public JSON only. It did not install the package, download the tarball, execute package code, or independently verify the bundle signatures. The cryptographic behavior described above is grounded in npm's documented verifier and reviewed Pacote implementation, not inferred from the presence of those fields.

The check also confirmed that provenance is not universal: `typescript@7.0.2` exposed a registry signature but no attestation advertisement at the observation time. Absence is therefore not, by itself, evidence that a package or release is malicious.

## Decision

Do not add a provenance provider, policy rule, or positive security claim to the current alpha.

AgentHawk will continue to omit attestation advertisements from normalized evidence. Merely observing `dist.attestations` must not become “verified provenance,” an allow signal, or a reason to weaken another finding.

Metadata-only cryptographic verification is technically feasible, but a future implementation must name its result precisely—for example, `verified_metadata_binding`—and must state that it verifies consistency among signed attestations, the exact package coordinate, and the registry-provided digest. It must not claim that the package artifact itself was verified unless AgentHawk hashes the retrieved artifact bytes.

Artifact-byte verification remains outside the no-tarball alpha boundary. If introduced, it requires a separate opt-in milestone and threat model. It may stream a strictly bounded tarball only to a cryptographic hash, must never extract or execute it, and must compare the calculated digest with the signed subject and registry integrity.

## Requirements for a future provider

A future provenance proposal must satisfy all of the following before implementation:

1. Accept only an exact registry package coordinate from the conservative parser.
2. Fetch the packument, registry keys, and attestation bundles through bounded, credential-safe HTTPS clients with strict response schemas, timeouts, redirect limits, and size limits.
3. Ignore the host in a registry-provided attestation URL and reconstruct the path against the already configured registry origin, matching Pacote's confused-deputy protection.
4. Verify the registry signature over the exact name, version, and integrity value.
5. Verify both the npm publish attestation and SLSA provenance bundle using maintained Sigstore trust-root handling, certificate validation, transparency-log proof, integrated time, and key-expiry semantics.
6. Require exactly matching package PURL, version, and SHA-512 subject data.
7. Compare builder, source repository, workflow identity, build type, and external parameters with explicit policy-owned expectations. Do not derive trust expectations solely from publisher-controlled repository metadata.
8. Distinguish `absent`, `advertised_unverified`, `verified_metadata_binding`, `invalid`, and provider-error states. Missing or failed required verification must never silently become an allow.
9. Add no blanket provenance requirement by default. Repositories may later opt into exact expectations because legitimate packages do not universally publish attestations.
10. Use offline fixtures and local mock servers for all tests; the quality gate must not depend on npm, Sigstore, Rekor, GitHub, or another live service.

## Alternatives considered

- **Treat attestation presence as provenance:** rejected because an advertisement is unverified metadata.
- **Implement metadata-only verification now:** deferred because correct Sigstore/TUF verification adds a substantial security-sensitive dependency and trust-root lifecycle, while the alpha has no policy model for expected source, workflow, builder, or build parameters.
- **Invoke `npm audit signatures`:** rejected because it operates on already-downloaded dependencies through a package manager and does not fit pre-install admission control.
- **Use Pacote directly:** deferred. Its exact-manifest verifier demonstrates feasibility, but Pacote is a broad package fetcher with behaviors and dependencies beyond AgentHawk's narrow provider boundary.
- **Download and hash every tarball:** rejected for the current alpha because it changes the privacy, bandwidth, caching, denial-of-service, and hostile-content threat model.
- **Treat missing provenance as a default review or block:** rejected because provenance is not universal and absence does not establish maliciousness.

## Security implications

- The current alpha makes no provenance claim and preserves its no-tarball invariant.
- A registry integrity string remains registry evidence, not independent artifact verification.
- Signed provenance describes source/build linkage and does not prove benign behavior, correct source code, trustworthy maintainers, or freedom from vulnerabilities.
- A compromised trusted build platform, authorized malicious source change, or malicious maintainer can still produce valid provenance.
- Metadata-only verification can still be valuable in a later policy, but only with an explicit result type and policy-owned identity expectations.
- AgentHawk's own future npm release should still use OIDC trusted publishing and generated provenance; producing provenance for AgentHawk and verifying third-party dependency provenance are separate trust decisions.

## Consequences

No runtime dependency, provider, finding, report field, network call, or cache entry is added. Artifact/provenance verification remains explicitly deferred from the alpha.

The implementation-plan question is resolved: provenance can be cryptographically bound to registry metadata without a tarball, but complete artifact verification cannot. AgentHawk will revisit the feature only through the requirements above and a separately reviewed milestone.
