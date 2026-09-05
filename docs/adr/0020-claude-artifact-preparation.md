# ADR 0020: authenticated Claude fixture artifact preparation

## Status

Accepted for implementation of a development-only acquisition command. No vendor
execution, image construction, hook activation, or native support follows.

## Context and primary evidence

ADR 0019's pure host contract was delivered in PR #60, merge `522bd4d`, with
independent exact-head approval and successful CI before and after merge. The
manifest was authenticated during research, but executable bytes remain unmeasured.
Preparation must perform its own verification, not trust a research note.

Primary material checked on 2026-09-05 UTC:

- Anthropic's [binary integrity documentation](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing)
  separates signed release manifests from executable hashes. The official
  [bootstrap script](https://downloads.claude.ai/claude-code-releases/bootstrap.sh),
  read only as bounded text, constructs the uncompressed artifact URL from the
  release and platform. Our fixed target is
  `https://downloads.claude.ai/claude-code-releases/2.1.241/linux-x64/claude`.
  Do not follow its latest-version selection or substitute its compressed path.
- GnuPG's [machine-status specification](https://raw.githubusercontent.com/gpg/gnupg/master/doc/DETAILS)
  distinguishes cryptographic signature validity from key/signature expiry and
  revocation. `VALIDSIG` may accompany adverse signature statuses. A successful
  exit and one expected `GOODSIG`/`VALIDSIG` pair are required; adverse or ambiguous
  records fail verification. The full signing and primary fingerprints, algorithm,
  signature class, and time fields must match the accepted policy.
- GnuPG's [configuration reference](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Configuration-Options.html)
  explains that a keyring argument adds to defaults unless defaults are disabled.
  Use an isolated home, no options file, no default keyring, no automatic key
  retrieval/import, no helper autostart, and no interactive input. Isolated
  `TRUST_UNDEFINED` is not itself a bad signature and must not be hidden by a
  trust override.
- Node's [filesystem reference](https://nodejs.org/docs/latest-v24.x/api/fs.html)
  requires explicit file-handle closure and notes that filesystem operations are
  not synchronized. Exclusive creation, bounded descriptor reads, and identity
  checks are necessary but do not defeat a privileged or same-account attacker.
  POSIX permission claims do not establish equivalent Windows ACL isolation.
- Node's [HTTP agent documentation](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)
  distinguishes global environment-derived proxy configuration from explicitly
  configured agents. This fixed public acquisition uses its own bounded HTTPS
  agent without inheriting proxy credentials or request headers.

Confidence is high for these primitives and the previously authenticated pins,
not for unobserved executable behavior. No source repository, prompt, credential,
or environment value is an acquisition input or an outbound request field.

## Decision

Implement a Linux-host-only development command, outside published packages,
which accepts only a new output directory. Version, platform, URLs, key, hashes,
sizes, and limits are fixed policy, with no bypass or override flags.

1. Require a canonical, owned, non-group/other-writable staging parent and a
   previously absent destination. Create and verify private directory/file modes
   (`0700`/`0600`), regular single-link files, and stable parent/file identities.
   Do not adopt, resume, replace, or normalize existing state.
2. Fetch only the fixed official public key, manifest, and detached signature.
   Require TLS verification, HTTP 200, no redirects, no credentials, bounded
   headers/bodies/time, and an explicit identity-encoding policy. Bound the entire
   operation as well as individual requests and child output.
3. Bind the exact public key and manifest bytes to the reviewed pins. Verify the
   detached signature anew with trusted `/usr/bin/gpg` in fresh private state,
   using fixed argument arrays and a minimal environment. Require confirmed
   successful closure and the closed accepted status evidence before binary GET.
4. Stream the exact uncompressed binary to an exclusive non-executable file.
   Count and hash actual bytes, not just headers. Require exactly 342636848 bytes
   and SHA-256 `0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8`.
   Sync/close, independently rehash stored bytes with identity fences, and confirm
   closure before producing a completion receipt.
5. Keep one shared immutable pin definition for preparation and the conditional
   host-evidence reducer. A receipt includes only a closed schema, public pins,
   relative artifact names, and explicit non-execution/non-support state. It is
   not authority for a subsequent launch; the later driver revalidates bytes.
6. On failure, stop further work, settle bounded network/GPG/file activity, report
   a fixed redacted failure, and retain the destination without automatic deletion.
   A failed attempt may contain partial files or a partial receipt. Their presence
   proves nothing. Retry requires a fresh destination. Never recursively clean an
   uncertain parent, overwrite a collision, or return success before closure.

Filesystem awaits have a 30-second response deadline and a terminal five-second
settlement grace. Timeout or cancellation permanently stops new admission. Pending
kernel calls remain accounted for; a late file handle is closed only after its
own I/O actually settles. Failed settlement reports `closure_unconfirmed`, never
quiescence. Node cannot cancel every filesystem syscall: retained files may change
later, and pending libuv work may keep the process alive. The hosted job therefore
also has an external timeout. No success or subsequent launch may rely on an
uncertain outcome, and no timed-out directory is automatically deleted.

The current authenticated manifest SHA-256 is
`8e2c930ddd0034b799f83212f5b1ccf6314a43e4a3eb9cd476c4751ffc1a8a66`.
The signing/primary fingerprint is
`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`. The armored public key is 1688 bytes,
SHA-256 `bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6`;
its dearmored form is 1188 bytes,
SHA-256 `0e122272125dd4bed96be0034cd95c84e9db07b4cf9bcddbe7c3ae01f3580646`.
Unexpected key or manifest updates require review, not automatic trust rotation.

## Acceptance and validation

Offline tests must cover transport failures/limits/cancellation; hostile GPG
environment/status/output/exit behavior; bad/multiple/expired/revoked/future
signatures; changed pins; premature binary requests; partial writes and readback
mutation; links/collisions/identity/mode drift; receipt failure; and redaction.
Small independently generated test bytes may exercise hashing and orchestration,
but do not establish a real pinned-artifact measurement.

Use a separate minimal-permission standard hosted Ubuntu CI job for actual
acquisition and verification. It must not install GPG, execute Claude, publish a
vendor binary/image, upload raw metadata/diagnostics, or use secrets. Record only
the redacted result. Existing six-platform offline gates remain required, and
new development logic joins the coverage inventory without lowering thresholds.

No chmod, version probe, installer, package installation, Docker startup, host
configuration change, or real model call is part of this slice. Native Claude
support remains unproven even when artifact preparation succeeds.

## Alternatives, risks, and rollback

Reusing a recorded research assertion, trusting a checksum without its accepted
manifest binding, inheriting keyrings, running an installer, and treating file
presence as preparation success were rejected. Automatic cleanup was deferred
to avoid deleting uncertain retained state. Linux-only permission semantics are
deliberate; unsupported hosts fail before acquiring data or creating artifacts.

The trusted runner, kernel, GPG implementation, system TLS roots, signing key,
and same-account process boundary remain assumptions. No keyserver lookup proves
the absence of separately distributed revocations, and authentic software need
not be benign. Acquisition does not sandbox executable behavior. Runtime package
assembly, container validation/execution, and the full activation matrix follow
as separate reviewable work. Rollback is a normal revert; retained directories
are never automatically repurposed or removed by a later invocation.
