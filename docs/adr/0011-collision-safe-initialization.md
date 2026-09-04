# ADR 0011: Collision-safe initialization

## Status

Accepted.

## Context

Operator setup needs deterministic policy and advisory integration files, but common targets such as `AGENTS.md` and `CLAUDE.md` may already contain maintainer-owned instructions. A normal write or overwrite-capable rename could destroy those files. The public CLI also cannot depend on repository-root templates that are absent from its npm tarball, and portable filesystems do not offer a fully atomic multi-file transaction.

## Decision

`agenthawk init` uses fixed root-relative targets selected by an integration enum. Release-pinned UTF-8/LF bytes are compiled into the CLI and tested against the reviewed source policy and templates. Existing exact bytes are accepted only as `unchanged`; different or unsafe content is never modified.

The command preflights all targets, acquires one exclusive local lock, validates observed parent components, creates only fixed missing directories, writes complete files in a root-local staging directory, and publishes with no-replace hard links. Cross-device or hard-link-unsupported publication fails closed. It verifies file identity, link count, size, and digest. Rollback removes only matching identities with exact expected bytes created by the invocation and only empty directories with non-recursive removal. Changed or unconfirmed file content is preserved. The canonical optional root policy is consumed automatically by `check` and `scan`; explicit policy paths retain precedence.

## Alternatives

- Overwriting, force flags, appending, or automatic Markdown and YAML merging were rejected because they can destroy or reinterpret maintainer security instructions.
- Rename-based publication was rejected because ordinary rename can replace an existing destination.
- Runtime reads from repository-root templates were rejected because those files are not part of the public CLI package.
- A hosted initializer and interactive prompt were rejected to preserve local-first deterministic automation.
- Treating every exact rerun as a collision was rejected because exact-byte idempotency enables safe retry and partial recovery without changing existing bytes or claiming ownership.

## Security implications

The design narrows collision and ordinary failure races but cannot prove a Git root, guarantee transaction atomicity, authenticate a locally installed CLI, or defeat a same-account attacker racing filesystem components. Hard-link exclusion may be unavailable or unreliable on network filesystems; UNC roots are unsupported. Advisory instruction creation does not prove host loading or enforcement. Protected CI and host permissions remain separate boundaries.

## Consequences

### Cleanup content fence (2026-09-04)

Identity alone does not prove unchanged content. Require identity, bounded size,
and exact expected bytes before removing tracked files; preserve changed or
partially written files with an unconfirmed-cleanup result. This also applies to
staged files and the initialization lock. An initially empty owned file may be
removed before writing starts; once a write begins, its content is unknown until
the write completes. The existing same-account filesystem race limitation remains.

Primary reference: [Node.js filesystem documentation](https://nodejs.org/api/fs.html#class-fsstats),
Node.js project, accessed 2026-09-04. File identity and size are metadata, not a
content attestation; filesystem operations are separate calls. The content fence
is a conservative application decision, not a claim of atomic compare-and-delete.

Existing project instructions require manual merge. A crash may leave a fixed lock or incomplete target requiring documented manual inspection. Package verification must include the emitted init modules and a built-consumer initialization smoke. Any future uninstall command requires a separate destructive-action contract.
