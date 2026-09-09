# ADR 0022: fresh fixture-runtime assembly

## Status and scope

Implemented after PR #62 (`04dbfbb`), which received independent approval and all six
pre-merge and post-merge Quality jobs green. This development-only Linux command
materializes the six-package fixture runtime and independently
remeasures stored bytes. Relocation execution, image preparation, vendor execution,
hook activation and native support are subsequent gates, not implied capabilities.

The complete local gate passed on 2026-09-09 UTC: 2,721 tests with five existing
skips across 59 suites; coverage 94.66% statements, 92.44% branches, 97% functions
and 96.57% lines. All new logic modules exceed 90% statement and branch coverage.
Lint, package and explicit development-test typechecks, build, package verification,
CLI help, dependency audit and diff checks passed. Independent working-tree review
found no remaining blocker after preserving unconfirmed transport closure. Exact-head
hosted assembly, frozen-commit approval, feature delivery and post-merge verification
remain required; local fixtures are not substituted for that actual preparation.

## Research and decision

Primary sources checked 2026-09-09 UTC:

- [Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html)
  describes unsynchronized asynchronous operations, explicit handle closure and
  platform/network-filesystem caveats for exclusive creation. Use bounded tracked
  operations and private regular-file identities; do not claim atomic immunity to
  a same-account writer, hostile kernel, or network filesystem.
- [Node package resolution](https://nodejs.org/api/packages.html) separates package
  exports and physical package layout. Checkout `link:` smokes do not establish a
  portable runtime. Preserve the reviewed manifests and all licensed files in six
  physical package directories, without a package-manager store or binary shims.
- [Git porcelain status](https://git-scm.com/docs/git-status) supplies stable
  machine-readable state. Clean Git state alone does not prove fresh build output:
  ignored `dist` can be old. Require its absence before a controlled build, derive
  HEAD/tree/lockfile identity ourselves, and fence source again after build/pack.
- [pnpm 10 pack](https://pnpm.io/10.x/cli/pack) packages workspace output; packaging
  is not source provenance. Disable lifecycle scripts, validate both own manifests
  and exact contents, and retain only the existing exact packed core-version rewrite.
- [actions/checkout](https://github.com/actions/checkout) distinguishes a PR merge
  checkout from the PR head. The hosted preparation gate must explicitly select the
  exact head, omit persisted credentials, and compare the checked-out source SHA.
- [Node HTTP incoming headers](https://nodejs.org/docs/latest-v24.x/api/http.html#messageheaders)
  explicitly represent repeated `set-cookie` fields. A bounded public npm archive
  probe on 2026-09-09 encountered those fields. The npm-only transport discards
  them after existing byte/count/syntax validation; it never stores, sends or
  trusts cookies. Framing, redirects, all other duplicate checks and the Claude
  transport contract remain unchanged. All four original archives subsequently
  passed the closed transport and exact compressed/tar/manifest checks in memory;
  that probe neither extracted nor executed package code.

The trusted builder, Node, pnpm, TypeScript, Git and filesystem remain assumptions.
This is an observed fresh-build binding, not reproducible-build proof, publisher
authentication, a safe-package verdict, or executable launch authority. No new
runtime dependency or public CLI/schema is introduced.

## Acceptance criteria

1. The production command accepts only a new absolute destination. It derives its
   source identity and tool versions; caller-provided SHAs, archive pins, receipts,
   URLs, limits and success booleans are not authority. Reject unsupported hosts,
   dirty/index-changing source and existing own `dist` before building. Never
   delete output to manufacture freshness. Use fixed shell-free bounded own-build
   and pack commands, and retain uncertain scratch/output on failure.
   Rehash every bounded regular tracked file against its index blob, fence the
   index and HEAD, and reject ignored/untracked own source inputs. Direct-child
   closure alone is insufficient: confirm the owned Linux process group is gone,
   kill remaining descendants on failure, and retain `closure_unconfirmed` when
   bounded settlement cannot establish quiescence.
2. Validate core's exact semver/zod graph and CLI's exact core/commander/yaml/zod
   graph, with no optional/peer/bundled edges or install/prepare hooks. Reuse the
   two own-package allowlists and release reader without increasing its 2 MB bound.
   Freshly packed own bytes must match the build's measured archive hashes.
3. Reuse ADR 0021 for the four exact external archives. Compressed pin checks and
   complete tar/manifest/totals validation precede any entry-byte access. Inventory
   APIs keep their old semantics. Structural-only fixtures, forged receipts and
   mutable caller buffers cannot authorize writes. Bound and snapshot all inputs.
4. Reuse the existing bounded HTTPS transport with a separately closed npm policy
   entrypoint: exactly four public registry URLs and sizes, no ambient credentials,
   proxy, redirects, retries or caller URL/size override. Preserve the existing
   Claude command's URL and response contracts. Verify pins before decoding.
5. Verify all six inputs before creating the runtime destination. Write only
   `runtime/node_modules/@agenthawk/core`, `@agenthawk/cli`, `commander`, `semver`,
   `yaml`, and `zod` under it, plus one bounded assembly record. Do not install,
   import, execute, symlink, hard-link, add shims, or copy an installed store.
6. Require canonical owned parents, fresh exclusive 0700 directories and 0600
   regular single-link files. Track every intermediate directory, compare parent
   and file identities around I/O, bound short writes and reads, sync and close,
   then independently reopen and hash stored bytes. Keep file execution disabled.
7. Extend the guarded storage only with bounded directory-handle operations. Read
   expected names plus at most one unexpected entry; reject extra files, aliases,
   links, growth and replacement. Late directory handles join the existing sticky
   cancellation and settlement accounting. Never report success with unconfirmed
   process/file closure, and never automatically delete, resume or adopt output.
8. Return deterministic bounded source/build identifiers, package/archive hashes
   and a remeasured tree digest. Keep `executed`, `portableRuntime`, and
   `nativeSupport` false. A retained or partial record proves neither success nor
   authority for future relocation/execution; later consumers revalidate bytes.
9. Offline adversarial tests cover source/build drift, old output, closure failure,
   exact dependency closure, tampering, mutable buffers, malformed/forged inputs,
   directory/file races, short I/O, extra files, cancellation and redaction. Add all
   new security logic to coverage and explicit strict development-test checking.
   A secretless exact-head Ubuntu job must demonstrate actual fresh build, fixed
   archive acquisition and physical-tree remeasurement. No vendor/container run,
   artifact upload, package publication, support change or owner-machine service.

## Implementation and rollback

Expected files: internal archive-entry and six-package input modules/tests, exact
own-package policy tests, closed transport wrapper/tests, bounded storage extension
and tree writer/tests, fresh-build orchestration/tests, hosted workflow, coverage
inventory, this ADR and public roadmap/implementation/threat-model reconciliation.
The independent reviewer owns no implementation files. Full gates and exact-head
review precede feature-only delivery. Rollback is a normal revert; retained state
requires owner review and is never automatically deleted by the next invocation.

The following slice proves relocation with separately measured copies and fixed
own CLI/core/hook smokes without checkout/store access. Image preparation and
actual Claude execution remain separate reviewed boundaries after that proof.

The preparation command retains its fresh `<destination>.build` scratch directory
and the controlled own `dist` outputs. It never removes them, even after success.
The stored assembly record labels source identifiers as caller observation only;
only successful production orchestration emits `observed_fresh_build` in its
bounded result after the final source fence. Neither form authorizes later launch.
