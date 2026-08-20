# Release operations

AgentHawk's reviewed first alpha, `0.1.0-alpha.1`, is public as `@agenthawk/core` and `@agenthawk/cli`. The packages were published together, core first, from the exact approved CI artifacts. No Git tag or GitHub Release was created for the bootstrap because an exact version tag would invoke the stage workflow for an already-published version.

## Recorded maintainer decisions

- Package names: `@agenthawk/core` and `@agenthawk/cli`.
- First version: `0.1.0-alpha.1`.
- Release unit: both packages at the same version, core before CLI.
- GitHub protection: the `npm-release` environment.
- Permanent authentication: npm trusted publishing with GitHub OIDC and no stored npm token.
- Dual-use handling: persistent `contentPolicy.class: dual-use` metadata and a packaged `DISCLOSURE` file.
- Initial bootstrap: one-time interactive publication of the exact CI-built tarballs with npm 2FA.

The bootstrap-process approval was separate from the exact-artifact publication approval. That one-time operation is complete; future versions must use the protected stage-only path below.

## Bootstrap completion record

- Date: 2026-08-20 UTC.
- Source: exact `main` commit `a2eccf130055bf14062a209452f77c24265b7f8f`.
- Artifact run: [Release candidate run 32319267651](https://github.com/nafiyad/AgentHawk/actions/runs/32319267651), whose manual dispatch ran only the credential-free `prepare` job.
- Core artifact SHA-256: `fa3f906bcd4ad4337c25c01da379bacd033214807c6269f91b31a3d20221aaa0`.
- CLI artifact SHA-256: `343c6ea56cc4c0e115a6ff0501d31d889775f7721c4d642614f7238c348650eb`.
- Registry verification: names, versions, SHA-1 shasums, SHA-512 integrity values, file counts, public access, dual-use declarations, downloaded tarball SHA-256 values, and the CLI's exact core dependency all matched.
- Consumer verification: a clean public-registry installation selected CLI and core `0.1.0-alpha.1`, and the installed CLI returned help successfully.
- Authentication: interactive npm 2FA with no automation token; the first version intentionally has no provenance attestation.
- Permanent npm controls: both trusted publishers bind to `nafiyad/AgentHawk`, `release.yml`, and `npm-release`, permit only `npm stage publish`, and use the restrictive package setting that disallows bypass-2FA tokens.
- Permanent GitHub controls: `npm-release` requires reviewer `nafiyad`, permits only `v0.*-alpha.*` tags, has no environment secrets, and disallows administrator bypass. Self-review remains permitted because the repository currently has one maintainer.

npm's [registry metadata format](https://github.com/npm/registry/blob/master/docs/responses/package-metadata.md) requires every package document to define `latest`. The first publication therefore created `latest` alongside the requested `alpha` tag, and npm rejected removing it. Both tags currently resolve to `0.1.0-alpha.1`; this does not make the version stable. Users and automation should request `@alpha` or the exact version. Any later retargeting of `latest` requires a reviewed release decision.

The published `0.1.0-alpha.1` tarballs were correctly immutable after verification, so their bundled READMEs still contain the pre-publication sentence that called them unpublished candidates. Repository READMEs correct that wording for future artifacts; the stale sentence in the first registry version is a known documentation limitation, not grounds to rebuild or overwrite the release.

## Package and artifact gate

`pnpm package:check` builds both packages and performs two independent offline checks:

1. `npm pack --dry-run --ignore-scripts --offline --json` must match the exact reviewed file manifests.
2. `pnpm pack` creates temporary tarballs, whose tar headers, paths, file types, manifests, versions, and CLI-to-core dependency rewrite are verified before the temporary directory is removed.

The verifier requires:

- exact identity, version, repository, license, Node engine, dual-use declaration, and public-alpha publication metadata;
- the complete reviewed compiled JavaScript/declaration manifest, `README.md`, `LICENSE`, and `DISCLOSURE`;
- positive bounded unpacked size, canonical contained paths, non-symlink directories, and regular non-symlink files;
- no extra or missing source, tests, coverage, source maps, build metadata, `.env`, `.npmrc`, or nested tarballs;
- core import, CLI startup, and the shared runtime version;
- `workspace:*` only in the source workspace and an exact `0.1.0-alpha.1` core dependency inside the packed CLI.

The Quality workflow runs this gate on every change. It cannot publish, invoke package lifecycle scripts, or contact npm during package verification.

## Trust-separated workflow

`.github/workflows/release.yml` has two jobs with deliberately different authority:

### Prepare

The `prepare` job checks out only the exact current `main` commit, has `contents: read` and no OIDC permission, installs with lifecycle scripts disabled, runs the full quality gate, and creates two package tarballs. It also downloads the exact npm CLI tarball pinned by version and SHA-512 integrity. The resulting bundle contains only:

- `agenthawk-core-0.1.0-alpha.1.tgz`;
- `agenthawk-cli-0.1.0-alpha.1.tgz`;
- `npm-12.0.2.tgz`;
- `release-manifest.json`;
- `SHA256SUMS`.

A manual dispatch stops after this job. It is the credential-free path used to build the initial bootstrap artifacts.

### Stage

An exact `v<package-version>` tag also enables the `stage` job after `prepare` succeeds. The job is protected by the `npm-release` environment and has only `actions: read`, `id-token: write`, and no repository-content permission. It does not check out the repository, run project scripts, install project dependencies, or execute package lifecycle scripts. It downloads the same-run artifact, verifies the exact five-file set, checks every SHA-256 digest and manifest invariant, installs the integrity-pinned npm CLI from the local bundle, then runs `npm stage publish` for core followed by CLI.

The stage job cannot make a package public. A maintainer must inspect and approve each staged release with npm 2FA. Direct `npm publish` is intentionally absent from the workflow.

## One-time interactive 2FA bootstrap

npm requires a package to exist before a trusted publisher can be configured and before `npm stage publish` can stage a version. The first version therefore uses this bounded bootstrap:

1. Merge the exact green release-workflow PR normally.
2. Manually dispatch `release.yml` from the exact current `main` commit. Do not create the version tag.
3. Confirm the run's `Build and verify release artifacts` job is green and that no `stage` job ran.
4. Download `agenthawk-release-<full-main-SHA>` from that run to a clean maintainer workstation.
5. Confirm the workflow run SHA equals the intended `main` SHA. Run `sha256sum --check SHA256SUMS` (or an equivalent trusted SHA-256 verifier), inspect `release-manifest.json`, and confirm the directory contains exactly the five documented files.
6. Confirm the npm account controls the `@agenthawk` scope, uses 2FA for publishing, and is logged in interactively. Install the verified bundled CLI with `npm install --global ./npm-12.0.2.tgz --ignore-scripts`, then require `npm --version` to print exactly `12.0.2`. Do not create or export an automation token.
7. Obtain a separate explicit release approval for these exact hashes.
8. From the verified artifact directory, publish core first and CLI second, allowing npm to prompt interactively for 2FA:

   ```bash
   npm publish ./agenthawk-core-0.1.0-alpha.1.tgz --access public --tag alpha --ignore-scripts --provenance=false
   npm publish ./agenthawk-cli-0.1.0-alpha.1.tgz --access public --tag alpha --ignore-scripts --provenance=false
   ```

   `--provenance=false` is an explicit bootstrap exception: local interactive publication has no GitHub OIDC identity. Record that the first version lacks an npm provenance attestation. Never substitute a rebuilt tarball.
9. Verify both public registry versions, their `alpha` tags, integrity values, packaged `DISCLOSURE` files, and the CLI's exact core dependency. Record any registry-created `latest` mapping rather than assuming it can be absent.
10. Configure each npm package's trusted publisher to this repository, the exact workflow filename `release.yml`, and environment `npm-release`. Restrict the allowed action to `npm stage publish` and disallow bypass-2FA token publishing.
11. Configure the GitHub `npm-release` environment with required reviewers, restricted release tags, and no administrator bypass where repository ownership permits.

If either publish fails, stop. Do not rebuild, overwrite, unpublish, change tags, or publish the CLI without a verified compatible core version. Diagnose and obtain a new explicit approval for any changed artifact or procedure.

## Subsequent prereleases

1. Use a reviewed PR to update both manifests, the shared runtime version, exact package allowlists/tests, changelog, workflow filenames, and release documentation.
2. Run and merge only an exact-head green PR.
3. Create the exact `v<version>` tag on the then-current `main` commit without moving or recreating it.
4. The release workflow reruns every quality gate, builds the exact bundle, and uses OIDC only to stage core and then CLI.
5. Inspect the staged packages and provenance, then approve each with npm 2FA. Do not promote a partially staged pair.
6. Verify npm registry identity, integrity, provenance, dependency linkage, and the `alpha` tag. `latest` currently points to the first alpha because npm requires it; retargeting it requires its own reviewed release change.

Never publish from a source checkout, reuse an artifact from another run, attach a long-lived npm token, bypass the protected environment, move a release tag, run lifecycle scripts, or claim provenance proves the package benign.

## Full release-candidate gate

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm package:check
pnpm audit --audit-level high
```

This design follows npm's official [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/cli/v12/commands/npm-stage/), [dual-use package](https://docs.npmjs.com/policies/dual-use/), [package manifest](https://docs.npmjs.com/files/package.json/), and [provenance](https://docs.npmjs.com/generating-provenance-statements/) documentation. Provenance establishes a source/build relationship; it does not establish that code is safe or benign. [ADR 0009](adr/0009-release-publishing-security.md) records the trust decision.
