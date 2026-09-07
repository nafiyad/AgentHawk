# ADR 0021: fixed runtime dependency archive preflight

## Status

Implemented as a development-only, in-memory preflight. No extraction, installation,
portable-runtime claim, image construction, vendor execution, or native support.

## Context and primary research

PR #61 delivered authenticated Claude artifact preparation as `ab208c3`, with
independent approval and green exact-head and post-merge CI. Preparation does not
establish activation. The next runtime must contain AgentHawk and its dependencies
without reaching the checkout: `installedRuntimeSpecifiers()` currently supplies
checkout `link:` overrides to packed-consumer smokes. Those smokes are useful but
are not portability evidence.

Primary sources checked 2026-09-07 UTC:

- [pnpm 10 deploy](https://pnpm.io/10.x/cli/deploy) describes a localized runtime
  but installs dependencies and has injected/legacy workspace semantics. Command
  success alone would not establish our exact byte and containment expectations.
- [npm lockfile format](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/#packages)
  distinguishes archive integrity, dependency edges, links, and install metadata.
  [npm ssri](https://github.com/npm/ssri#-ssricheckdata-data-sri-opts---hashfalse)
  defines data-to-digest equality; it does not prove publisher identity or benignness.
- [node-tar security guidance](https://github.com/isaacs/node-tar#security-information)
  identifies links, decompression expansion and attacker-controlled destinations
  as separate hazards. This slice neither extracts files nor adds a generic tar
  dependency. The existing release reader and its 2 MB ceiling remain unchanged.
- [Node conditional exports](https://nodejs.org/api/packages.html#conditional-exports)
  gives earlier conditions priority. Reviewed root export selectors therefore
  include key order, not just matching keys/values or the existence of targets.

The trusted policy is the four independently reviewed SHA-512 pins already in
`pnpm-lock.yaml`, not values supplied alongside a candidate archive. A bounded
in-memory fetch of each exact public registry archive matched that pin before
inspection on 2026-09-07. No package code was executed or archive persisted.

| Package | Compressed bytes | Tar bytes | Regular files | File bytes | Largest file |
| --- | ---: | ---: | ---: | ---: | ---: |
| commander 15.0.0 | 52,736 | 218,112 | 12 | 207,368 | 87,647 |
| semver 7.8.5 | 29,399 | 144,384 | 53 | 101,065 | 25,669 |
| yaml 2.9.0 | 112,086 | 862,720 | 233 | 685,953 | 35,551 |
| zod 4.4.3 | 759,588 | 5,140,480 | 718 | 4,558,122 | 160,328 |

All four use regular-file ustar entries with 0644/0755 modes, zero padding and a
1,024-byte zero terminator. The original archives omit numeric owner metadata as
all-NUL uid/gid fields. The [node-tar header encoder](https://raw.githubusercontent.com/isaacs/node-tar/main/src/header.ts)
leaves unspecified owner fields unfilled. Accept only that exact absent form or
valid octal owner fields, treating neither as filesystem authority. Required
size, checksum and mode fields must not accept this omission. The first real-byte
implementation probe exposed this representation mismatch; focused regressions
and a repeated four-archive probe are required, not a broader numeric relaxation.
Root licenses are MIT, ISC, ISC, and MIT respectively.
Their root manifests have no runtime, optional, peer, or bundled dependency edges.
yaml and zod include `prepublishOnly` metadata; this is not an install/prepare/pack
hook and must not be described as executed. Preserve licensed source/type files.
Confidence is high for these exact byte observations, not future versions,
publisher authenticity, license-compliance conclusions, portability or support.

## Decision and acceptance criteria

1. Add a pure development policy for only these four package identities, versions,
   SHA-512 pins and measured archive limits. No caller pin, URL or limit override
   is accepted by the pinned verification entrypoint. Bound and copy input bytes,
   reject shared memory, then check the compressed hash before decompression.
2. Use a separate bounded structural inspector for synthetic hostile fixtures.
   It accepts only the reviewed regular-file ustar subset; validate checksum,
   numeric fields, magic/version, type, mode, path, content bounds and complete
   zero padding/termination. Reject links, special files, PAX/GNU/sparse records,
   base-256 fields, traversal, aliases, case-fold and file-prefix collisions,
   embedded node_modules, credential targets and unexpected trailing data.
3. Validate the root name/version/license, exact ordered root entry selectors,
   and required runtime entry files;
   require a nonempty root LICENSE and no runtime/optional/peer/bundled edges or
   install/prepare/pack scripts. Publication-only metadata remains inert. Never
   resolve or execute manifest entrypoints or scripts.
4. Return a deterministic bounded inventory with file hashes and fixed explicit
   non-execution/non-portability/non-support fields. Do not return raw manifests,
   archive data, local paths, or caught diagnostics. Structural inspection alone
   is never integrity evidence. A later assembler must verify its bytes anew.
5. Offline tests cover known hash vectors, current source/lockfile runtime closure
   and pin drift, pre-decode rejection,
   malformed archives, every path/type/header/size boundary and result redaction.
   Synthetic success proves only the exercised mechanics; separately recheck the
   four real pinned archives in memory against the implemented verifier. Include
   new logic in coverage; preserve all quality thresholds and package allowlists.

Independent code review found ASCII decoding could mask high bits in the USTAR
version ([Node Buffer encoding](https://nodejs.org/docs/latest-v24.x/api/buffer.html#buffers-and-character-encodings)).
Compare its two bytes directly, with high-bit regression fixtures. Review
also tightened root export mappings and conditional key order; neither structural
success nor these fixes substitutes for the original compressed-byte pin check.

Expected files: development policy/inspector and adversarial tests, coverage
inventory, this ADR, roadmap, implementation plan and threat model. No runtime
dependency, workflow privilege, public CLI/schema, package version or package
contents change. Full local quality gate, staged secrets/diff review, independent
exact-head review, all exact-head CI and post-merge verification are mandatory.

## Alternatives, risks and rollback

A metadata-only closure statement was rejected as insufficient for archive-byte
inspection. Copying/repacking installed dependency trees was rejected as original
archive evidence. Full runtime assembly and a general extractor would combine
too many boundaries in one review; both remain subsequent work. Future own-package
closure must bind core's semver/zod dependencies as well as the existing CLI graph.

Hash policy, Node crypto/zlib, the trusted source checkout and reviewer remain
assumptions. A matching digest is not provenance, benignness or license approval.
Bounds do not provide a process sandbox; this synchronous development preflight
is not on an enforcement path. A structural inventory is not launch authority.
No filesystem race, materialization or relocation guarantee follows. Rollback is
a normal revert, with no retained user files to delete. The following slice must
bind both freshly built AgentHawk packages to their exact source/build and create
and remeasure a fresh contained runtime before relocation and execution smokes.
