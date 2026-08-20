# ADR 0009: Stage-only npm publishing with a bounded bootstrap

- Status: Accepted
- Date: 2026-08-19

## Context

AgentHawk plans to publish `@agenthawk/core` and `@agenthawk/cli` as public dual-use packages. A release pipeline is a high-value security boundary: repository code and dependencies are inputs to the build, while npm OIDC is a short-lived publishing identity. Combining those authorities in one job would allow compromised build code to request publishing credentials.

npm trusted publishers and staged publishing cannot be configured for a package name that does not yet exist. npm's dual-use policy also excludes direct OIDC publication for declared dual-use packages while allowing OIDC staging followed by interactive 2FA promotion. The first package versions therefore require a bootstrap path, but a long-lived npm token or a permanent workstation release path would create avoidable ongoing risk.

## Decision

The two packages use the same prerelease version and publish as one ordered unit, core before CLI, under the `alpha` distribution tag. Every packed manifest retains `contentPolicy.class: dual-use` and a `DISCLOSURE` file.

The release workflow separates authority:

- `prepare` runs only at the exact current `main`, has read-only repository access and no OIDC, disables lifecycle scripts, runs the full gate, validates real package tarballs, verifies a pinned npm CLI by SHA-512, and emits a checksummed five-file bundle;
- manual dispatch performs only `prepare` and is the bootstrap artifact source;
- a matching immutable version tag may request `stage`, protected by the `npm-release` environment;
- `stage` has `id-token: write` and artifact-read permission but no repository-content permission, checkout, project dependency install, project script, or package-code execution;
- `stage` revalidates exact filenames, hashes, source/version metadata, npm CLI integrity, package order, and publication policy before calling `npm stage publish`;
- npm 2FA promotion remains outside CI, and no long-lived npm token is stored.

The first `0.1.0-alpha.1` versions use a one-time interactive 2FA publication of the exact manually dispatched CI tarballs. The bootstrap disables provenance explicitly because no GitHub OIDC identity is available. It requires a separate exact-hash publication approval. Immediately afterward, each package is configured for this repository, exact `release.yml` workflow, `npm-release` environment, stage-only trusted publishing, and token prohibition.

## Consequences

- Compromised repository build code does not receive an npm identity.
- Compromised stage inputs must pass a fixed manifest, exact-set, and checksum boundary before integrity-pinned npm code handles them.
- CI cannot directly make a dual-use package public; protected GitHub review and npm 2FA are separate gates.
- The first version has no provenance attestation, and that limitation must remain public.
- Version strings and artifact filenames are deliberately explicit in the reviewed workflow; every release requires a PR rather than a moving generic publisher.
- The design still trusts GitHub-hosted runners, pinned GitHub actions, npm's registry/staging service, and the integrity-pinned npm CLI.

## Rejected alternatives

- **Long-lived npm automation token:** rejected because it is reusable, secret-bearing, and unnecessary after bootstrap.
- **Direct OIDC publication:** rejected because AgentHawk is declared dual-use and because staging plus 2FA provides a stronger separation.
- **OIDC in the build job:** rejected because project code and dependencies execute there.
- **Permanent local publication:** rejected because it lacks reproducible CI identity and expands workstation trust.
- **Publishing only the CLI or using a range for core:** rejected because paired exact versions make compatibility and incident handling deterministic.
