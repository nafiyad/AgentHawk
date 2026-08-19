# Release readiness

AgentHawk is not yet published. Both workspace packages remain `private: true` at version `0.0.0`; this is a deliberate publication lock, not a release version.

## Current package gate

`pnpm package:check` builds both packages and runs `npm pack --dry-run --ignore-scripts --offline --json` against each package directory. The verifier requires:

- the expected package identity, repository, license, Node engine, and publication lock;
- the exact reviewed compiled JavaScript/declaration manifest and consumer entrypoint smoke tests;
- package-specific README and Apache-2.0 license files;
- bounded unpacked size;
- canonical contained paths backed by regular non-symlink files;
- no extra or missing files, source, tests, coverage, source maps, build metadata, `.env`, `.npmrc`, or tarballs.

The quality workflow runs this gate on every change. It cannot publish, invoke lifecycle scripts, or contact the registry.

## Decisions required before publication

A maintainer must explicitly confirm:

1. final npm package names and ownership;
2. the first semantic prerelease version;
3. whether the CLI and core library publish together;
4. the protected GitHub environment and release approvers;
5. npm trusted-publisher configuration for the exact workflow path.

Only after those decisions may a separate PR remove `private`, replace `workspace:*` with a publishable version relationship, and add a release workflow.

## Required release security

The eventual workflow must use npm trusted publishing with GitHub OIDC, a GitHub-hosted runner, least privilege, a protected release environment, immutable action pins, and a repository URL that exactly matches the public source repository. It must not store a long-lived npm token. Trusted publishing can produce provenance for a public package from a public repository, but provenance proves the source/build relationship—not that the package is benign.

Before a release candidate is authorized:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm package:check
pnpm audit --audit-level high
```

Review the generated file manifests and changelog, verify a clean exact tag target, and publish only from the reviewed release workflow. Never publish from a developer workstation.

The packaging behavior follows the official [npm pack](https://docs.npmjs.com/cli/pack/), [package.json](https://docs.npmjs.com/files/package.json/), [trusted publishing](https://docs.npmjs.com/trusted-publishers/), and [provenance](https://docs.npmjs.com/generating-provenance-statements/) documentation.
