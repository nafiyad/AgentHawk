# ADR 0019: isolated Claude host evidence

## Status

Accepted for the development-only launch/evidence contract. Real process launch,
container preparation, and exact-host activation remain a subsequent gated slice.
No native support or isolation evidence follows from a validated plan alone.

## Context and primary evidence

ADR 0018 supplies a bounded model-side fixture, not a sandbox or an execution
oracle. Its client-reported result cannot prove that a hook ran. Primary sources
checked on 2026-09-05 UTC:

- Anthropic's [binary integrity documentation](https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing)
  distinguishes signed release manifests from downloaded executables. The official
  [2.1.241 manifest](https://downloads.claude.ai/claude-code-releases/2.1.241/manifest.json)
  names the Linux x64 executable `claude`, size 342636848 bytes, SHA-256
  `0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8`.
  This is not the release archive hash. The manifest signature has not yet been
  cryptographically verified by this project; HTTPS metadata is the present
  source for this pin, not a signature-verification claim.
- The [CLI reference](https://code.claude.com/docs/en/cli-reference) separates
  `--tools`, scoped `--allowedTools`, `--strict-mcp-config`, and setting sources.
  [Programmatic mode](https://code.claude.com/docs/en/headless) discovers hooks
  with ordinary `-p`; bare mode does not prove project-hook activation.
- Anthropic's [environment reference](https://code.claude.com/docs/en/env-vars)
  documents API routing, traffic suppression, update controls, and subprocess
  credential scrubbing. Scrubbing also uses a Linux PID namespace. Current docs
  are not proof of that behavior in the pinned executable; retain fake-sentinel
  tests and refuse to weaken containment if the host cannot run under it.
- Docker's [none network](https://docs.docker.com/engine/network/drivers/none/)
  leaves only loopback. Its [container run reference](https://docs.docker.com/reference/cli/docker/container/run/)
  exposes read-only roots, bounded tmpfs, dropped capabilities, no-new-privileges,
  process/memory/CPU limits and separate namespaces. The trusted daemon and kernel
  remain outside the evidence provided by a Docker configuration inspection.

Confidence is high for these documented primitives and metadata, not for their
unobserved composition with Claude. There is no real credential, service call,
vendor code redistribution, package execution, or permission bypass in this slice.

## Decision

First target only Linux x64/glibc Claude 2.1.241 in a disposable OCI container.
Fixture, Claude, production AgentHawk hook, Node, Git, and marker helper must share
one isolated loopback namespace. Windows, interactive trust, SDK, desktop, managed
policies, and other versions remain separate unsupported rows.

Implement a pure, dependency-free development contract before adding a launcher:

1. Construct one closed Docker create argument vector for an immutable image ID,
   with network `none`, read-only root, non-root UID/GID, all capabilities dropped,
   no-new-privileges, no bind mounts/volumes/ports/devices/host namespaces, bounded
   writable `/work` and `/tmp` tmpfs, fixed resources and a fixed Node entrypoint.
   Require the prepared image to have no declared volumes. Inspect an exact
   minimal environment before start, since a dynamic loader can process hostile
   variables before `/usr/bin/env -i` clears them. Disable image healthchecks
   explicitly and require the inspected test to be exactly `["NONE"]`. Disable
   daemon logging and restart, and set `--pull never` to prohibit an implicit
   image download during creation. Image preflight precedes creation.
2. Independently validate the resulting daemon inspection, including image ID,
   entrypoint/arguments, environment, namespaces, resource limits, mounts and
   security flags, before any start. Reject missing or unexpected security state;
   do not accept a caller boolean such as `isolated: true` as evidence.
   Bind the inspection to the exact ID returned by create. The closed HostConfig
   fixture profile has not yet been observed against a real daemon; its first
   observation may require reviewed representation changes, never weaker guards.
3. Build Claude's environment from an explicit allowlist, never the parent
   process. Use only fixed container paths and a validated loopback fixture origin
   and synthetic capability. Disable updates/nonessential traffic/auto plugins,
   use empty fixture-owned home/config state, and keep credential scrubbing on.
   These variables are defense in depth, not the network boundary.
4. Extend the closed fixture with one explicit `marker` scenario. It emits only
   `/opt/agenthawk/fixture-marker`; the default echo scenario remains unchanged.
   The next driver supplies this immutable helper; it creates one fixed marker
   exclusively and rejects known fake credential sentinels. No caller command,
   path, or executable is accepted by the protocol fixture.
5. Reduce observations into a fixed, minimum-disclosure evidence result. Positive
   evidence needs the exact artifact, verified containment, completed exchange,
   clean host exit and independent marker. Negative evidence additionally needs
   the expected AgentHawk emergency-denial signal and marker absence after the
   driver corrupts only its own receipt. Require confirmed process/container
   cleanup and production install/status/remove results. Neither client error nor
   missing marker alone establishes denial. A validated summary is conditional
   on trusted measurement by the later driver, not proof by assertion.

## Execution gate and acceptance criteria

This slice contains no process launcher, download, Docker invocation, filesystem
mutation outside fixture tests, or live Claude invocation. Tests exercise exact
vectors, forged/missing/changed daemon security fields, environment injection,
fixed scenario boundaries, false positive/negative evidence, and redaction.
The public plan and coverage inventory include the new development modules. Run
the full gate and independent exact-head review; rollback is a normal revert.

The subsequent launcher must prepare explicit trusted image inputs without a
real repository/home/config bind mount, verify binary bytes before even
`--version`, inspect the created container before starting it, bound every child
stream/deadline, distinguish kill requests from confirmed quiescence, and remove
only its own container/temporary state. Runtime performs no downloads or installs.
No raw vendor prompts, transcripts, environment, capabilities, or host paths may
be uploaded or persisted as report artifacts. Image preparation and execution
are separate; images containing the vendor binary are never published.

An ordinary installed-hook run must create the independent marker. A fresh run
with only the harness-owned receipt invalidated must preserve marker absence and
observe the exact AgentHawk denial. Restore only the original owned bytes before
production removal. Startup/protocol/namespace failures remain failures, never
successful protection or permission to relax the container boundary. The full
ADR 0017 matrix and a separate support decision still follow this first target.

## Alternatives and consequences

API base URL alone, inherited PATH/home, broad permission bypass, fabricated tool
results, and Node fetch interception were rejected as isolation/evidence models.
A VM remains an alternative if the constrained container is incompatible; choosing
one must preserve the same authority and evidence requirements. This contract
does not make hostile Docker daemons, kernels, images, or agents trustworthy and
does not claim universal package safety. No runtime dependency or package change.
