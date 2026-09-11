# ADR 0023: independently measured runtime relocation

## Status and scope

Delivered in PR #64 on 2026-09-10 UTC, reviewed head `d9b3ec6`, normal merge
`28f4425`. Independent approval, all seven exact-head checks and all seven
post-merge checks passed. Hosted relocation measured 1,112 files / 6,102,215
bytes, with planned/source/destination hashes all
`af1baec9c9de0e601e0c9ab51384eba3f2c11f0212e7acfcc0f48cd0c2b408e2`.
Execution, portability and native-support flags remained false.
PR #63 delivered ADR 0022 as `43b3b8d`, with all eight
exact-head and post-merge checks green. This slice revalidates the actual fresh
assembly and copies its verified bytes into a separate fresh physical tree.
It does not launch the assembled runtime, create an image, execute vendor code,
activate hooks or establish native support. No public CLI or package change.

The full local gate passed 2,901 tests (five existing platform skips) across 61
suites, with 94.85% statement / 92.73% branch / 97.07% function / 96.70% line
coverage. Both new logic modules exceed 90% statement and branch coverage.
Lint, package and explicit strict development-test typechecks, build, package
verification, CLI help, dependency audit and diff checks passed. Independent
review found no remaining blocker and separately passed all 279 focused tests.
The local fixture evidence and independently measured hosted result are distinct;
neither establishes runtime execution or isolation.

## Research and decision

Primary sources accessed 2026-09-10 UTC:

- [Node 24 permissions](https://nodejs.org/download/release/latest-v24.x/docs/api/permissions.html)
  describe a trusted-code guardrail, not malicious-code isolation. Alternate
  filesystem interfaces, inherited descriptors and initialization occur outside
  parts of its boundary. Therefore cwd changes, cleared module paths or Node
  permission flags alone do not prove OS-level checkout/store exclusion.
- [Bubblewrap](https://github.com/containers/bubblewrap) establishes namespaces
  whose protection depends on the exact launch configuration. Adding another
  launcher and its lifetime proof here would duplicate the already planned
  contained-image boundary in ADR 0019.
- [Docker's none network](https://docs.docker.com/engine/network/drivers/none/)
  retains loopback only. Combined with the separately reviewed filesystem and
  process boundary, that later environment is where own-runtime execution smokes
  belong. A configuration document is not evidence that isolation actually ran.
- [Node filesystem APIs](https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html)
  require explicit handle closure and expose non-atomic path observations. Reuse
  bounded tracked I/O, complete expected-name enumeration, private regular files,
  and pre/post identity/content fences. Same-account races remain a limitation.

Decision: split byte relocation from execution evidence. The dependency order is
relocation verification, contained-image preparation, fixed own CLI/core/hook
smokes with actual checkout/store exclusion, bounded vendor driver, activation
matrix, then a separate support decision. This corrects the earlier ordering in
ADR 0022 without weakening the portability gate. Confidence is high in the cited
primitive limitations, not in unobserved future containment or host behavior.

## Acceptance criteria

1. A development-only Linux command accepts exactly one new absolute destination.
   It derives a separate fresh source and build scratch name; preflight all of
   them before preparation. No caller archive/path list, hash, receipt, success
   boolean, build identity or launch command is accepted as authority.
2. Preserve ADR 0022's default non-relocating command. Expose its fresh plan only
   through a private in-process result brand minted after its final source fence,
   cancellation checks and confirmed storage settlement. A clone or serialized
   result must not recover that authority. Failed preparation never reaches copy.
3. Read the complete source against that exact opaque six-package plan. Require
   canonical owned ancestors, private directories, private regular single-link
   files, exact expected names, sizes and hashes, bounded reads including extra
   EOF checks, and matching pre/open/post file and directory observations. Treat
   the assembly record only as expected data, never an input authority.
4. Mint a private source-snapshot capability only after every handle has settled.
   Its bytes are copies of actual rereads, not substitutions from the original
   archive plan. Forged, copied, rejected or mutable caller snapshots never admit
   writes. A writer must compare snapshot contents to the exact plan again.
5. Reuse exclusive creation and stored-byte verification to write those verified
   snapshots to the fresh destination. Never use filesystem copy, symlinks,
   hard links, installed-store links, overwriting, adoption or automatic deletion.
   Reject overlapping roots and shared source/destination file identities.
6. Independently reread the destination; repeat complete source and destination
   observations after materialization. Require unchanged identities/content within
   each tree and matching planned/source/destination digests. This is bounded
   point-in-time evidence, not an atomic snapshot against a same-account writer.
7. Bound I/O, enumeration, total bytes, per-operation and aggregate deadlines.
   Preserve sticky cancellation and `closure_unconfirmed` precedence across all
   stages. Retain any partial/uncertain output; never mint success from a retained
   record. Successful reads and writes must have confirmed handle closure.
8. Return only closed result states, source/build identifiers and bounded package
   counts/digests. All outcomes keep `executed`, `portableRuntime`, and
   `nativeSupport` false. Neither result brand nor stored bytes authorize launch.
9. Offline adversarial tests cover fresh-brand timing, forgery, source mutation,
   extra/missing files, malformed records, paths, modes, links, replacement,
   short/oversized I/O, failure/cancellation/closure precedence and final fences.
   Add strict development typechecks and coverage for every new security module.
   A secretless exact-head hosted Linux job must demonstrate actual relocation;
   no Docker, service, vendor execution, artifact upload, release or publication.

The reader permits at most 1,400 planned package files, 7,000,000 package bytes,
1 MiB per package file, 2,048 expected directories and 262,144 counted traversal /
read operations per tree. The separately checked assembly record is bounded to
64 KiB. Reads use at most 64 KiB per request and verify EOF beyond the expected
size. Each tree measurement has a four-minute deadline; the orchestration has a
twenty-minute aggregate deadline and the hosted job an outer thirty-minute limit.
These are rejection bounds, not performance or immunity-to-races claims.

## Implementation plan and rollback

Expected files: private finalized-preparation brand and tests, bounded runtime
reader/snapshot module and adversarial tests, narrow existing writer integration,
relocation orchestration and tests, hosted assembly/relocation gate, coverage
inventory, and public ADR/roadmap/implementation/threat-model reconciliation.
No dependency additions, release migration, support-matrix promotion or settings
changes. Run focused tests, independent security review, the complete local gate,
diff/staged secret review, exact-head PR review/CI, and post-merge verification.
The independent reviewer owns no implementation files. Rollback is a normal
reviewed revert; retained state requires owner review and is not auto-cleaned.
