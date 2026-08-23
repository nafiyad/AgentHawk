# AgentHawk product roadmap

Research snapshot: 2026-08-21 UTC

AgentHawk's first public alpha established a narrow, deterministic npm dependency-admission control. This roadmap defines the next product phases required to turn that foundation into an agent-native security gateway without weakening its local-first, evidence-backed security model.

This is an ordered execution plan, not a calendar promise. A milestone starts only after its prerequisite decisions are documented, and it completes only after its security and quality exit gates pass. Public feedback can change the order, but it must not silently broaden a milestone's trust boundary.

## North star

An AI coding agent may propose an action. AgentHawk must be able to classify the action, collect only the evidence that policy allows, apply deterministic policy, and return an explainable `ALLOW`, `WARN`, `REVIEW`, `BLOCK`, or `ERROR` result before the action crosses a protected boundary.

The long-term product is a set of composable shields around high-risk agent actions:

1. **Dependency Shield** — package requests, manifest changes, lockfile correlation, malicious-package evidence, and provenance expectations.
2. **Repository Shield** — security-sensitive repository edits, workflow changes, policy weakening, and protected-file rules.
3. **Secret Shield** — access to credential-bearing files, environment variables, and configured secret paths without collecting secret values.
4. **Command Shield** — explicitly supported high-risk command families and execution contexts.
5. **Network Shield** — destination and protocol policy where an agent platform exposes a reliable enforcement point.

Dependency Shield remains the active product line until its enforcement, workspace, and operability milestones are complete. The later shields require separate research and threat models; they are not authorized by this roadmap alone.

## Permanent product invariants

Every phase must preserve these invariants:

- **Deterministic authority:** an LLM may supply non-authoritative context in a future design, but it never decides a security verdict.
- **Local-first operation:** AgentHawk has no account requirement, hosted control plane, or product telemetry.
- **Minimum disclosure:** source code, prompts, credentials, environment values, and secret contents are not sent to evidence providers.
- **No package execution:** dependency evaluation does not install, import, build, or run candidate package code.
- **Fail visibly:** unavailable required evidence, malformed integration payloads, unsupported schema versions, and internal errors never become a clean `ALLOW`.
- **Bound every boundary:** files, HTTP bodies, redirects, retries, collections, concurrency, output, cache entries, hook input, and hook execution time have explicit limits.
- **Evidence is not innocence:** registry metadata, OSV records, scores, attestations, and the absence of findings are evidence inputs—not proof that software is benign.
- **Exceptions stay narrow:** approvals are exact, attributable, expiring, digest-visible, and unable to override hard blocks, errors, or non-approvable reviews.
- **No hidden weakening:** security defaults, provider requirements, policy schemas, and trust-boundary changes require documentation, tests, and a versioned migration when public contracts change.
- **Green milestones only:** focused tests, security review, the full quality gate, documentation, diff review, and secret scanning precede every merge or release.

## Research synthesis

### Native hooks are now the strongest practical enforcement point

The current advisory instruction templates are useful, but a capable or manipulated agent can ignore prose. Current agent platforms expose pre-action hooks that can deny tool use:

- [Codex hooks](https://learn.chatgpt.com/docs/hooks) include `PreToolUse` decisions and project/user configuration.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks) include `PreToolUse` matchers and deterministic command-hook decisions.
- [Cursor hooks](https://cursor.com/docs/hooks) include shell, file, MCP, and general pre-tool events, with `failClosed` available for security-critical hooks.
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/hooks) expose JSON `preToolUse` decisions for the CLI and cloud agent; GitHub explicitly recommends validating untrusted hook input, avoiding sensitive logs, and setting timeouts.

These mechanisms make pre-action dependency enforcement feasible, but not uniform. Hook schemas, precedence, timeout behavior, trust locations, cloud/local environments, and error defaults differ. Project-level hook configuration may also be writable by the repository or agent, while administrator-managed configuration can establish a stronger boundary. AgentHawk therefore needs a versioned adapter contract and an explicit deployment-trust model rather than a collection of shell snippets.

### The market validates interception, but leaves room for a local deterministic option

Current products demonstrate demand for install interception and agent governance:

- [Socket Firewall](https://docs.socket.dev/docs/socket-firewall-free) proxies package-manager traffic and blocks confirmed malicious packages across several ecosystems; its free mode requires Socket's network service and documents important fail-open/cache limitations.
- [Endor Labs' Cursor hook examples](https://github.com/endorlabs/cursor-hook-examples) intercept recognized install commands and manifest edits, while explicitly documenting unversioned-command, parser, and service-failure gaps.
- [Snyk Agent Guard](https://github.com/snyk/agent-scan/blob/main/docs/cli-reference.md) installs hooks for Claude Code, Cursor, and Codex and connects them to a hosted analysis service.
- Cursor's own [hook partner catalog](https://cursor.com/docs/hooks) now groups dependency security, agent safety, secret management, identity governance, and MCP control around pre-action hooks.

AgentHawk should not imitate hosted malware scoring or claim equivalent coverage. Its differentiated position is a small, inspectable, local-first decision engine with deterministic policy, public evidence, exact approvals, stable machine contracts, and no telemetry or LLM authority.

### Repository-scale dependency semantics are the next coverage gap

The alpha intentionally evaluates only the root manifest. Real repositories commonly use workspaces with different discovery and resolution semantics: [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces/) are declared in `package.json`; [pnpm workspaces](https://pnpm.io/workspaces) require `pnpm-workspace.yaml`; [Yarn workspaces](https://yarnpkg.com/configuration/manifest#workspaces) and [Bun workspaces](https://bun.com/docs/pm/workspaces) add their own patterns and extensions.

Workspace support cannot be implemented as unrestricted recursive file discovery. It needs bounded, ecosystem-aware pattern expansion; repository containment; non-symlink regular-file checks; deterministic ordering; internal-package classification; lockfile ownership; duplicate-name handling; and aggregate output/provider-call limits.

### Public evidence is improving, but policy must own trust expectations

- The OpenSSF [Principles for Package Repository Security](https://repos.openssf.org/principles-for-package-repository-security.html) treat vulnerability warnings, malicious-package reporting, provenance, transparency, hashes, and SBOM support as separate maturity capabilities.
- The OpenSSF [Malicious Packages repository](https://openssf.org/blog/2023/10/12/introducing-openssfs-malicious-packages-repository/) publishes cross-ecosystem malicious-package reports in OSV format. AgentHawk already consumes OSV evidence and should preserve record identity and source semantics rather than collapsing it into a score.
- [deps.dev API v3](https://docs.deps.dev/api/v3/) can add licenses, dependency graphs, advisory keys, project mappings, and verified-attestation observations, but its generic resolved graph is not an exact substitute for a repository lockfile and linked project metadata is not automatically trustworthy.
- npm states that [provenance](https://docs.npmjs.com/generating-provenance-statements/) links a package to source and build instructions but does not prove the package is non-malicious.
- [SLSA v1.2 verification](https://slsa.dev/spec/v1.2/verifying-artifacts) requires more than signature validity: a verifier must bind the subject digest and compare builder, source, build type, and external parameters against policy-owned expectations.

The conclusion is deliberately conservative: new evidence may raise confidence, produce review findings, or satisfy an explicit expectation, but no single positive signal creates a universal safe-package verdict.

### Agent risk extends beyond dependencies

The [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) highlights goal hijacking, tool misuse, identity and privilege abuse, agentic supply-chain compromise, and unexpected code execution. These support AgentHawk's long-term gateway direction. They do not justify immediately combining dependency, command, secret, repository, MCP, and network policy in one engine. Each action family exposes different data, parser, authority, and failure-mode risks and must earn its own boundary.

## Priority model

Work is ranked by five questions:

1. Does it stop a high-impact action before execution?
2. Does it close a known coverage or operability gap in the current product?
3. Can AgentHawk make the decision using deterministic, bounded, verifiable inputs?
4. Can the feature be tested offline across supported platforms and failure modes?
5. Does the maintenance and dependency cost fit a small open-source security project?

Using those criteria, the next sequence is:

| Order | Milestone | Why now | Depends on |
| --- | --- | --- | --- |
| 16 | Operator foundation | Makes policy and integration failures diagnosable before native enforcement ships | Public alpha |
| 17 | Agent-native dependency enforcement | Converts advisory guidance into pre-action controls at the product's core boundary | 16 |
| 18 | Workspace-aware npm admission | Closes the largest repository coverage gap without adding another ecosystem | 16; adapter fixtures from 17 |
| 19 | CI interoperability and local decision receipts | Makes decisions consumable and auditable without a hosted service | 17–18 |
| 20 | Evidence integrity and npm provenance | Adds cryptographic and ecosystem evidence without overstating it | 18–19; ADR 0008 |
| 21 | Second-ecosystem admission | Proves the architecture can expand without flattening ecosystem semantics | 17–20; maintainer demand |
| 22 | Repository Shield incubation | Extends policy to high-risk repository mutations after a separate threat model | Dependency Shield maturity |
| 23 | Secret and Command Shield research | Defines narrower controls for highly sensitive action families | 22 research lessons |
| 24 | v1 hardening and stable contracts | Converts proven alpha capabilities into a supportable stable release | Selected 16–21 scope complete |

## Milestone 16 — operator foundation

### Objective

Make secure setup, policy validation, approval inspection, and environment diagnosis explicit and scriptable before adding native enforcement.

### Deliverables

- `agenthawk init` creates a minimal policy and selected integration template without overwriting an existing file or crossing the repository root.
- `agenthawk policy validate --file <path>` performs the same bounded, strict validation used at enforcement time and returns a versioned machine-readable result.
- `agenthawk approvals verify --file <path>` validates syntax, bounds, timestamps, exact coordinates, expiry, and duplicate entries without applying an approval.
- `agenthawk doctor` reports supported Node/runtime versions, package version alignment, writable cache state, policy/template discovery, Git availability, and integration status without contacting providers by default.
- A documented support matrix identifies operating systems, Node versions, package managers, agent adapters, schema versions, and known fail-open platform behavior.
- Installation, upgrade, uninstall, rollback, and troubleshooting documentation covers the public package rather than only workspace development.
- `SECURITY.md`, release documentation, and package READMEs are checked for status/version drift during release readiness review.

### Security gates

- Setup writes are explicit, confined, non-symlink, collision-safe, and recoverable. No `--force` path may silently replace policy or hook configuration.
- Validation and diagnosis use the production parsers and file boundaries; a second permissive parser is not introduced.
- Diagnostic output contains capability states and redacted paths only. It does not print environment values, tokens, registry credentials, or policy/approval contents.
- JSON results have strict schemas, bounded strings/collections, stable exit codes, hostile-control escaping, and golden contract tests.
- `doctor` performs no package installation, package execution, lifecycle-script execution, or implicit network access.

### Exit criteria

- Fresh Windows, macOS, and Linux test fixtures can initialize, validate, diagnose, and remove the generated integration without manual file repair.
- Adversarial tests cover path traversal, junctions/symlinks, non-regular files, races/growth, exact size boundaries, invalid UTF-8, duplicates, unknown fields, hostile terminal text, and read-only repositories.
- Every generated file is byte-for-byte deterministic for the same version and options.
- The full quality and package-consumer gates pass from a clean checkout.

## Milestone 17 — agent-native dependency enforcement

### Objective

Block or review supported dependency-addition actions before execution through native agent hooks while preserving the existing CLI and CI decision engine.

### Architecture work

- Write an ADR and threat-model extension covering hook authority, configuration trust, bypasses, timeout/error behavior, shell payloads, working directories, cloud agents, and project-controlled files.
- Define one strict internal `AgentAction` envelope and one strict `AgentDecision` envelope. Vendor payloads are translated at the edge and never enter the policy engine directly.
- Separate action qualification from shell interpretation. Support an explicit grammar of package-manager operations; do not claim to understand arbitrary shell programs.
- Reuse the existing npm spec parser, provider interfaces, policy engine, approvals, cache, verdict precedence, and redaction.
- Record adapter name/version and deployment trust (`project`, `user`, `managed`, or `unknown`) in bounded evidence, without treating that label as proof that configuration cannot be changed.

### Delivery order

1. Codex command-hook adapter and fixtures.
2. Claude Code `PreToolUse` adapter and fixtures.
3. Cursor `beforeShellExecution`/`preToolUse` adapter with `failClosed` guidance.
4. GitHub Copilot `preToolUse` adapter after CLI and cloud differences have independent tests.
5. Maintainer-managed installation guidance only after project-level behavior is stable.

### Initial protected actions

- Explicit npm and pnpm dependency additions with resolvable registry specs.
- Explicit Yarn and Bun additions only after their exact argument and workspace semantics have fixtures.
- Ephemeral package execution (`npx`, `npm exec`, `pnpm dlx`, and equivalents) as a separate policy action because it may execute code without changing a manifest.
- Manifest edits remain covered by post-edit scan/diff plus CI until a platform provides reliable pre-edit content and path semantics.

Unknown or ambiguous install-like commands must produce a visible configured outcome; they must not be mislabeled as safely analyzed. Unrelated commands should pass through without provider calls.

### Security gates

- Hook input is size-bounded, strict JSON, invalid-UTF-8 aware, and rejects unknown schema versions/decision values.
- No adapter builds a shell command from untrusted payload text. Child processes, if any, use fixed executables and argument arrays with sanitized environments.
- Timeout, missing binary, malformed output, provider failure, and cache-authentication state have explicit fail behavior for every platform.
- Project-level hooks are documented as defense-in-depth against accidental or manipulated agent behavior, not protection from an actor that can rewrite the hook itself.
- Managed/user-level deployment instructions never embed credentials and never send prompts, source, commands, or secret-bearing environment data to AgentHawk services; no such service exists.
- The LLM-based hook modes offered by some platforms are not used for authority.

### Exit criteria

- For every supported adapter, an actual integration harness proves: benign explicit add can proceed; review/block/error denies under strict enforcement; malformed hook input denies or errors visibly; an unrelated command performs zero provider calls.
- Cross-platform fixtures cover quoting, command chaining, environment assignments, package-manager flags, scoped packages, tags/ranges, URLs/Git/file specs, workspaces, aliases, and multiple-package requests.
- A bypass corpus covers wrapper shells, mixed case, Unicode/control characters, path-qualified executables, double-dash handling, and nested invocation. Unsupported shapes remain explicit.
- Controlled benchmarks target p95 under 50 ms for unrelated-action qualification, under 150 ms for a valid cache hit, and under five seconds for bounded live evidence. Performance failure cannot change the security decision.
- CI remains the final repository gate and independently re-evaluates resulting manifest/lockfile changes.

## Milestone 18 — workspace-aware npm admission

### Objective

Evaluate dependencies across bounded JavaScript/TypeScript monorepos with correct workspace and lockfile context.

### Deliverables

- Discover npm workspaces from the root `package.json` and pnpm workspaces from `pnpm-workspace.yaml` using ecosystem-specific parsers and bounded pattern expansion.
- Evaluate root and member dependency maps with deterministic repository-relative locations.
- Classify internal workspace packages separately from registry packages and reject ambiguous duplicate names or out-of-root targets.
- Model the owning lockfile and package-manager context; correlate additions, removals, section changes, and lockfile deletion across members.
- Provide explicit ignore rules that are bounded, repository-contained, documented, and digest-visible.
- Add aggregate concurrency, dependency, provider-call, report-size, and elapsed-time budgets selected in an ADR from benchmark evidence.
- Add Yarn and Bun workspace discovery only after npm/pnpm behavior and fixtures are stable.

### Security gates

- No recursive repository walk, implicit Git ignore execution, package-manager invocation, lifecycle script, or package code execution.
- Every candidate manifest is reached from a validated root declaration, remains inside the real repository root, and is a non-symlink regular file reached through safe intermediate directories.
- YAML/JSON parsers reject duplicates, aliases where unsupported, invalid UTF-8, unknown fields, and files that grow beyond bounds.
- Internal package classification cannot turn an untrusted registry request into an automatic allow.
- Report ordering and policy digests are independent of filesystem enumeration and provider completion order.

### Exit criteria

- Fixture repositories cover npm/pnpm layouts, nested and excluded patterns, missing members, duplicate names, internal ranges, mixed package managers, lockfile deletion, path traversal, junctions/symlinks, and limit exhaustion.
- Base and head workspace topology changes produce deterministic diff results and conservative review findings.
- A repository at every configured maximum completes within the published resource budget and produces a schema-valid bounded report.

## Milestone 19 — CI interoperability and local decision receipts

### Objective

Make AgentHawk decisions easy to consume in security workflows and locally auditable without adding a hosted backend.

### Deliverables

- Add SARIF 2.1.0 output as a rendering of existing findings, with stable PG rule metadata and repository-relative manifest locations. GitHub documents [SARIF upload for third-party code scanning tools](https://docs.github.com/en/code-security/concepts/code-scanning/sarif-files); SARIF does not become a second policy engine.
- Add bounded GitHub annotations and a reusable workflow example without expanding the existing untrusted-evaluation/privileged-commenter boundary.
- Define an opt-in local decision receipt containing normalized action identity, verdict, rule IDs, evidence/policy/approval digests, timestamps, tool version, and adapter trust label.
- Add receipt verification, retention, rotation, file permissions, and redaction guidance.
- Define whether receipts are standalone signed records or a local hash chain. If a hash chain is used, document that an attacker able to rewrite the entire local store can rewrite the chain; it is tamper-evident continuity, not remote notarization.

### Security gates

- SARIF and annotation renderers escape untrusted text, enforce collection/string/output bounds, and never include raw provider bodies, credentials, commands, prompts, or source code.
- Receipt logging is disabled by default, local only, schema-versioned, bounded, and unable to alter a verdict.
- Receipt or SARIF failure returns a visible output error when the user requested that format; it never converts a blocked decision into success.
- Workflow examples use minimal permissions, immutable action pins, untrusted PR evaluation, artifact bounds, and exact source/workflow/ref binding.

### Exit criteria

- Golden SARIF validates against the OASIS [SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) and renders correctly in a test GitHub repository.
- Receipt verification detects truncation, reordering, mutation, unsupported versions, and chain breaks while preserving redaction.
- All new output families have strict producer/consumer bounds and parser-failure envelopes.

## Milestone 20 — evidence integrity and npm provenance

### Objective

Add narrowly named cryptographic and ecosystem evidence while keeping trust expectations under repository policy.

### Prerequisites

- Complete the proposal and threat model required by [ADR 0008](adr/0008-provenance-verification-boundary.md).
- Choose and security-review the Sigstore/TUF/Rekor implementation and trust-root update model.
- Define policy-owned expected source repositories, builders, workflow identities, build types, and allowed parameters.
- Decide whether metadata-only verification provides enough user value before adding bounded artifact download and hashing.

### Deliverables

- Distinct evidence states such as `not_advertised`, `unavailable`, `invalid`, `verified_metadata_binding`, and—only if bytes are independently hashed—`verified_artifact_binding`.
- Exact binding among package coordinate, registry integrity, attestation subject, source, builder/workflow, and policy expectations.
- Optional deps.dev evidence for licenses, project mapping, and attestation observations with freshness/completeness/source labels.
- Preserve OSV/OpenSSF malicious-record identity and withdrawn state; do not collapse malicious reports and ordinary vulnerabilities into one score.
- Add trust-root, provider, cache, offline, and schema migration documentation.

### Security gates

- Signature validity alone is not a clean allow and is not called source trust, benignness, or artifact verification.
- Unknown builders, sources, build types, parameters, predicate types, and signature algorithms follow explicit conservative policy.
- Trust roots and identity expectations cannot be learned from the untrusted package metadata being verified.
- Network, bundle, certificate, transparency-proof, statement, subject, and dependency bounds have adversarial tests.
- New security-sensitive runtime dependencies receive a dedicated dependency review and exact package-content verification.

### Exit criteria

- Public fixtures cover valid, absent, expired, revoked, mismatched-subject, wrong-package, wrong-source, wrong-builder, unknown-parameter, malformed-bundle, split-view/offline, and trust-root-rotation cases.
- Reports name exactly what was and was not verified.
- The existing no-tarball path remains available unless artifact verification is explicitly enabled by policy.

## Milestone 21 — second-ecosystem admission

### Objective

Prove that AgentHawk can add an ecosystem without pretending all package managers share npm semantics.

### Selection gate

PyPI is the leading candidate because dependency confusion, typosquatting, install-time execution, and public OSV/OpenSSF evidence are relevant, but implementation begins only after public issues or maintainer use cases confirm demand. Cargo, Maven, and NuGet remain later candidates.

### Required work for the selected ecosystem

- Separate research document, threat-model section, grammar, canonical package coordinate, registry behavior, private-index/confusion model, lockfile semantics, provider contract, policy defaults, and release-age calibration.
- Strict parsing of the ecosystem's direct reference forms without fetching arbitrary URLs or executing the package manager.
- Ecosystem-specific workspace/project discovery and lockfile correlation.
- OSV/malicious-package mapping that preserves ecosystem and version semantics.
- Dedicated policy namespaces and findings where npm rules do not transfer exactly.

### Exit criteria

- The ecosystem ships as an explicit provider/policy module, not a generic string switch inside npm code.
- A hostile corpus covers ambiguous names, index confusion, direct URLs/VCS/local paths, pre-release rules, yanked/deleted versions, metadata drift, and install-script equivalents.
- Alpha users can enable the new ecosystem without changing npm results or report semantics.

## Milestone 22 — Repository Shield incubation

### Objective

Research and prototype deterministic policy for repository mutations that can weaken security or conceal risky agent changes.

### Research scope

- GitHub Actions permissions, trigger changes, mutable action references, artifact trust, environment protection, and untrusted pull-request boundaries.
- Changes to AgentHawk policy/approvals/hooks, branch-protection configuration-as-code, CODEOWNERS, release scripts, package-manager configuration, lockfiles, tests, lint/typecheck/coverage thresholds, and security documentation.
- Rename/delete/mode/symlink changes; generated files; submodules; sparse checkouts; worktrees; case-insensitive filesystems; and base-ref integrity.
- Which checks are syntactic, which require repository policy, and which cannot be decided reliably without semantic or human review.

### Prototype boundary

- Begin as read-only `agenthawk repo diff --base <ref>` evidence with stable findings.
- Reuse hardened Git execution and output escaping, but use a separate action/report schema from dependency findings.
- Promote a rule to pre-action enforcement only after it has a low-noise corpus and an adapter provides the required structured file/change information.
- Never use an LLM to decide whether a code or workflow change is secure.

### Exit criteria

- A published threat model and rule inventory maps every proposed finding to evidence, bypass tests, approvability, false-positive risk, and remediation.
- A real-repository calibration corpus demonstrates useful detection without treating test deletion or workflow edits as automatically malicious.
- No repository rule ships merely because a filename looks sensitive.

## Milestone 23 — Secret and Command Shield research

### Secret Shield questions

- Can a platform expose the requested path or environment-variable name before access without exposing the value to AgentHawk?
- Which user/managed policy source is outside the agent's write authority?
- How are path aliases, junctions/symlinks, case folding, alternate data streams, process inheritance, and generated credentials handled?
- Can the control deny access without reading, caching, logging, hashing, or transmitting secret contents?

### Command Shield questions

- Which command families have bounded, testable semantics without attempting to parse arbitrary shell languages?
- How are nested shells, scripts, interpreters, package executors, redirection, pipelines, command substitution, environment mutation, and platform quoting classified?
- When must ambiguity produce review/deny rather than a false claim of safety?
- Which platform timeouts or hook failures are unavoidably fail-open, and what CI or sandbox control compensates?

### Exit criteria

- Separate threat models and prototype corpora exist for secret access and commands.
- A feature proceeds only when the platform exposes enough pre-action structure for deterministic enforcement.
- Network Shield remains research-only until a reliable destination-level enforcement interface exists; a command-string heuristic is not a network firewall.

## Milestone 24 — v1 hardening and stable contracts

### Objective

Graduate the proven subset of AgentHawk—not every roadmap idea—to stable, supportable contracts.

### Release gates

- Freeze the supported feature matrix and explicitly defer incomplete shields.
- Version policy, approvals, reports, hooks, receipts, caches, and migration behavior; publish compatibility and deprecation windows.
- Test current supported Node LTS versions and Windows/macOS/Linux from clean package installs.
- Meet at least 90% statements, branches, functions, and lines for security-sensitive core modules, with higher per-module targets where risk warrants.
- Add property/fuzz tests for parsers, schemas, renderers, command qualification, and hostile Unicode/control input.
- Publish controlled performance/resource benchmarks and a fixed benign/malicious/ambiguous calibration corpus.
- Produce exact package manifests, checksums, SBOMs, provenance, consumer smokes, and a reproducible release-evidence bundle.
- Complete a claim-accuracy audit, dependency audit, threat-model review, and independent security review with no unresolved critical/high findings.
- Document support, vulnerability response, rollback, deprecation, and release ownership.

### Stable-release boundary

`1.0.0` means the published supported contracts are stable and their documented security behavior is tested. It does not mean AgentHawk detects all malicious packages, prevents every agent bypass, or makes an `ALLOW` verdict a guarantee of safety.

## Measurement without telemetry

AgentHawk will measure quality through public, reproducible local and CI fixtures—not collection from user repositories.

| Dimension | Required evidence |
| --- | --- |
| Decision correctness | Golden policy cases, precedence cases, exact approval cases, and stable JSON/SARIF/hook contracts |
| Malicious evidence | Fixed OSV/OpenSSF records with expected hard-block identity and withdrawal behavior |
| False-positive control | Versioned benign and ambiguous package/repository corpora; threshold sensitivity recorded before defaults change |
| Bypass resistance | Hostile parser, path, Git, hook, command, Unicode, cache, HTTP, archive, workflow, and renderer corpora |
| Failure safety | Required-provider, timeout, malformed, oversized, stale, offline, unsupported-version, and internal-error paths never become clean allow |
| Performance | Controlled p50/p95 wall time, provider-call count, concurrency, peak input/output size, and maximum-bound fixtures |
| Privacy | Automated scans for credentials/private paths plus tests proving unrelated actions and offline modes make zero provider calls |
| Release integrity | Exact source SHA, package manifests, checksums, SBOM/provenance state, clean consumer install, and post-release verification |

## Release and contribution cadence

- One security boundary or coherent operator feature per pull request.
- Draft PRs begin with threat model/ADR and tests when a new boundary is involved.
- Every PR states capability, non-capability, network/data flow, policy effect, output/schema effect, migration effect, and rollback.
- Exact-head CI and independent review are required before merge.
- Alpha releases may combine multiple merged milestones only after a release-specific claim audit and package verification.
- Maintainer feedback is collected through public issues and discussions; no product telemetry will be introduced as a shortcut.

## Explicitly not scheduled

The following are not promised phases: hosted dashboards, user accounts, organization telemetry, remote policy administration, automatic dependency installation, automatic approval generation, source-code upload, arbitrary package sandbox execution, general malware classification, an LLM security judge, or a claim that AgentHawk can prove a package safe.

## Immediate next action

Milestone 16 is complete. Milestone 17's research gate, vendor-neutral action/decision contracts, conservative qualifier, typed cancellation, co-root authority, and bounded aggregate evaluator are complete. The Codex `rust-v0.149.0` `PreToolUse` compatibility candidate now has a dedicated packaged binary, strict 64 KiB framing, release-pinned golden fixtures, neutral/deny-only bounded output, constant exit-2 emergency denial, process tests, and packed-consumer verification. It records a deliberately restricted `portable` grammar because the payload omits the target shell even for remote and explicitly selected shells; it never infers dialect from the AgentHawk process OS. It is not installed and is not yet a supported adapter: the desktop host could not be exercised from the development shell and Codex startup/timeouts may proceed. The immediate next action is an isolated real Codex v0.149.0 neutral/deny harness across named local and remote surfaces. If that evidence passes, update the support matrix and installation guidance in a separate ownership-reviewed slice; otherwise repair this same adapter. Do not begin Claude Code while Codex compatibility remains unproven.
