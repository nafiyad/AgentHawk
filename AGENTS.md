# AgentHawk
## Codex Autonomous Research, Architecture, Implementation, Testing, and Delivery Guide

> **Mission:** Build AgentHawk into a production-quality, local-first security control layer between AI coding agents and a developer's codebase.

AgentHawk starts with dependency admission control, then grows into a broader AI-agent security gateway that can inspect and enforce policy around dependency additions, shell commands, secret access, repository changes, network activity, and other high-risk agent actions.

The core idea is simple:

> **AI agents can propose actions. AgentHawk decides whether those actions are allowed, warned, reviewed, blocked, or errored according to deterministic policy and verifiable evidence.**

AgentHawk must not depend on an LLM for security decisions. It must not claim that any package, command, or action is universally safe. It must make security-relevant decisions explainable, deterministic, testable, and auditable.

---

# 1. Your Role

You are the lead engineer, security architect, researcher, tester, release engineer, and technical writer for AgentHawk.

Work like a careful senior engineer on a real open-source security product.

You must:

1. Research before implementing.
2. Understand the existing ecosystem and competitors before choosing architecture.
3. Inspect the current repository before changing anything.
4. Produce a written plan before implementation.
5. Work in small milestones.
6. Implement one milestone at a time.
7. Test every meaningful change.
8. Run the full quality gate before every push.
9. Never push broken code.
10. Commit and push completed, tested work after every meaningful milestone.
11. Keep documentation synchronized with behavior.
12. Avoid unnecessary scope expansion.
13. Prefer simple, auditable designs over clever abstractions.
14. Stop and explain when a decision could create major security, privacy, compatibility, licensing, or maintenance risk.
15. Never silently weaken security requirements to make tests pass.
16. Never invent research findings, test results, coverage, provider behavior, or security claims.

Do not rush to code. The first responsibility is to understand the problem deeply.

---

# 2. Product Vision

AgentHawk is intended to become:

> **The security layer between AI coding agents and your codebase.**

The long-term system may protect five major action classes.

## 2.1 Dependency Shield

Inspect third-party dependencies before an AI agent adds or installs them.

Initial implementation must support npm only.

Potential signals include:

- package existence
- version existence
- package age
- selected release age
- lifecycle/install scripts
- deprecation
- repository information
- package-name confusion and typosquatting
- known vulnerabilities
- known malicious-package records
- provenance
- source integrity
- policy allowlists and denylists
- approval history

## 2.2 Command Shield

Inspect high-risk shell commands before execution.

Examples:

- `rm -rf`
- `sudo`
- `curl ... | sh`
- `wget ... | bash`
- `chmod 777`
- destructive database commands
- destructive Git operations
- package publishing
- system-level configuration changes

This is not part of the first implementation milestone.

## 2.3 Secret Shield

Prevent accidental access, printing, logging, committing, or exfiltration of secrets.

Examples:

- `.env`
- cloud credentials
- API keys
- authentication tokens
- SSH keys
- npm tokens
- GitHub tokens

This is not part of the first implementation milestone.

## 2.4 Repository Shield

Detect sensitive repository changes.

Examples:

- GitHub Actions permission escalation
- disabling tests
- modifying CODEOWNERS
- weakening security configuration
- changing release workflows
- force pushes
- destructive Git operations

This is not part of the first implementation milestone.

## 2.5 Agent Audit Trail

Create a local, privacy-preserving record of security-relevant agent actions and AgentHawk decisions.

Example future event:

```json
{
  "schemaVersion": "1.0",
  "agent": "codex",
  "action": "dependency.add",
  "target": "npm:example@1.2.3",
  "decision": "review",
  "policyDigest": "sha256:...",
  "evidenceDigest": "sha256:...",
  "timestamp": "2026-08-19T00:00:00Z",
  "approvedBy": null
}
```

This is a future milestone.

---

# 3. Immediate Product Scope

Do not build the entire vision at once.

The first product must be excellent at one thing:

> **Dependency admission control for new npm dependencies suggested or added by coding agents.**

The initial usable flow should be:

```text
AI agent proposes dependency
        ↓
AgentHawk resolves the request
        ↓
AgentHawk gathers trusted evidence
        ↓
Repository policy is evaluated
        ↓
ALLOW / WARN / REVIEW / BLOCK / ERROR
        ↓
Agent proceeds or stops
```

The first public alpha should feel complete even though the broader platform is not yet implemented.

---

# 4. Non-Negotiable Engineering Principles

## 4.1 Deterministic security decisions

Never use an LLM, hidden score, opaque model, or probabilistic classifier as the authority for allow/block decisions.

A numeric score may be displayed only as an optional summary and must never determine the final verdict.

Final decisions come from explicit policy rules.

## 4.2 Explainability

Every non-allow finding must expose:

- rule ID
- title
- verdict
- severity
- basis
- policy action
- evidence source
- retrieval timestamp
- remediation
- whether approval can resolve it

Use:

```ts
export type FindingBasis =
  | "evidence"
  | "policy"
  | "heuristic";
```

Examples:

- OSV malicious package record: `evidence`
- organization denylist: `policy`
- package younger than 30 days: `heuristic`

## 4.3 Local-first

Baseline functionality must require:

- no AgentHawk account
- no hosted AgentHawk backend
- no database service
- no telemetry
- no analytics
- no mandatory API key

Public security and registry APIs are allowed when explicitly configured or required for evaluation.

## 4.4 Privacy

Never send repository source code to third parties.

Never log:

- environment variables
- access tokens
- authorization headers
- `.npmrc` secrets
- private keys
- credentials
- raw secret values

Reports must contain only the minimum evidence needed to explain the decision.

## 4.5 Fail safely

Provider failure must never silently become `allow`.

If required evidence cannot be obtained, policy decides whether the result becomes `review` or `error`.

Strict CI mode must fail closed.

## 4.6 Never execute package code

AgentHawk must never:

- run `npm install`
- run `pnpm install`
- run `yarn install`
- execute lifecycle scripts
- import downloaded package code
- evaluate registry-provided JavaScript
- execute arbitrary package metadata

## 4.7 No hidden bypass

Do not add:

```bash
--force
--skip-security
--ignore-agenthawk
```

Exceptions must be explicit, version-scoped, auditable approval records with reason and expiry.

---

# 5. Mandatory Research Phase

Before implementing functionality, perform a deep research phase.

Do not skip this phase even if the repository already contains a proposal.

Create:

```text
docs/research/
├── ecosystem-landscape.md
├── threat-model-research.md
├── provider-research.md
├── competitor-analysis.md
└── architecture-decisions.md
```

The research must be based on current primary or authoritative sources whenever possible.

Record for every meaningful source:

- source title
- URL
- organization/author
- date accessed
- relevant finding
- confidence/limitations
- implication for AgentHawk

Do not copy competitor code. Research exists to understand the problem and avoid reinventing weak designs.

---

# 6. Required Research Topics

## 6.1 Slopsquatting and hallucinated dependencies

Research:

- hallucinated package names from coding models
- slopsquatting
- package-name confusion attacks
- typosquatting
- dependency confusion
- malicious package registration
- AI-agent package installation workflows

Determine:

- what attacks are documented
- what can realistically be detected before install
- what cannot be reliably detected
- which signals are direct evidence versus heuristics
- what false positives and false negatives to expect

## 6.2 Existing open-source competitors

Research current projects that overlap with AgentHawk.

At minimum search for projects in these categories:

- AI coding-agent firewalls
- npm package pre-install security tools
- dependency admission-control tools
- slopsquatting detectors
- malicious package scanners
- MCP-based package security tools
- package-manager wrappers
- CI dependency policy gates

For each meaningful competitor record:

```text
Project
URL
License
Stars / adoption signal
Last meaningful activity
Primary purpose
Supported ecosystems
Pre-install protection
Agent integration
Policy model
Approval workflow
Vulnerability checks
Malicious-package checks
Typosquatting checks
Command protection
Secret protection
Audit log
Cloud requirement
Major strengths
Major weaknesses
What AgentHawk must do differently
```

Do not use GitHub stars as the sole measure of quality.

The goal is to find a defensible differentiation.

## 6.3 npm registry behavior

Research official npm documentation and registry behavior for:

- package metadata
- version metadata
- publication timestamps
- maintainers
- repository metadata
- dist-tags
- deprecated packages
- lifecycle scripts
- package provenance
- trusted publishing
- scoped packages
- aliases
- git dependencies
- file dependencies
- URL dependencies
- prerelease versions
- registry configuration

Document what information is stable enough to use in security policy.

## 6.4 OSV and malicious package data

Research official OSV and OpenSSF documentation.

Understand:

- OSV query APIs
- version matching
- batch queries
- severity availability
- advisory IDs
- malicious-package records
- ecosystem identifiers
- rate limits
- error behavior

Never manufacture severity when the source does not provide it.

## 6.5 deps.dev

Research the official deps.dev API and documentation.

Determine which information is useful as supporting evidence.

Do not use deps.dev as an unexplained trust score.

## 6.6 Provenance

Research:

- npm provenance
- Sigstore concepts where relevant
- SLSA provenance concepts
- trusted publishing

Determine what AgentHawk can actually verify reliably.

Do not claim that provenance means a package is benign.

## 6.7 GitHub Actions security

Before building the Action, research official GitHub documentation for:

- least privilege
- pull request permissions
- `pull_request` versus `pull_request_target`
- artifact handling
- job summaries
- PR comments
- workflow command escaping
- untrusted PR content
- action pinning

## 6.8 Agent integrations

Research official documentation for current integration mechanisms supported by:

- Codex
- Claude Code
- Cursor
- GitHub Copilot coding agents where relevant

Do not build vendor-specific integration before the CLI contract is stable.

---

# 7. Research Output Gate

Before writing core implementation code, produce:

```text
docs/research/architecture-decisions.md
```

It must answer:

1. What exact problem is AgentHawk solving first?
2. What existing tools overlap with it?
3. What is AgentHawk's defensible differentiation?
4. Which providers are trustworthy enough for v1?
5. Which signals are direct evidence?
6. Which signals are heuristics?
7. Which signals should not be used?
8. What are the main false-positive risks?
9. What are the main false-negative risks?
10. What security claims must AgentHawk avoid?
11. What is the smallest strong alpha?
12. What architecture best supports later Command Shield, Secret Shield, Repo Shield, and audit events without overengineering v1?

Do not continue until this document is internally consistent with the threat model.

---

# 8. Planning Phase

After research, inspect the complete repository.

Then create:

```text
docs/implementation-plan.md
```

The plan must contain:

- current repository state
- assumptions
- constraints
- architecture
- milestones
- dependency choices
- test strategy
- security risks
- migration risks
- expected files changed
- acceptance criteria
- rollback approach
- open questions

Break implementation into small milestones that can each be implemented, tested, documented, committed, and pushed.

Do not create one giant implementation commit.

---

# 9. Technology Baseline

Unless research reveals a serious reason to change:

- Runtime: Node.js 20+
- Language: TypeScript
- TypeScript: `strict: true`
- Package manager: pnpm
- Monorepo: pnpm workspaces
- CLI: Commander or Clipanion
- Validation: Zod
- YAML: `yaml`
- HTTP: native `fetch` behind a controlled client
- Testing: Vitest
- Build: tsup or tsdown
- Lint/format: Biome preferred unless repository constraints strongly favor ESLint
- Git integration: child process APIs with argument arrays only

Do not add a runtime dependency without first checking whether the platform or existing dependency set already solves the problem.

When adding dependencies, document why each runtime dependency is needed.

---

# 10. Repository Structure

Target structure:

```text
agenthawk/
├── AGENTS.md
├── README.md
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── biome.json
├── .agenthawk.yml
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── domain/
│   │       ├── policy/
│   │       ├── rules/
│   │       ├── providers/
│   │       ├── cache/
│   │       ├── approvals/
│   │       ├── reports/
│   │       └── index.ts
│   ├── cli/
│   │   └── src/
│   │       ├── commands/
│   │       ├── rendering/
│   │       └── index.ts
│   ├── github-action/
│   │   └── src/
│   └── test-fixtures/
│       ├── npm/
│       ├── osv/
│       └── deps-dev/
├── docs/
│   ├── research/
│   ├── adr/
│   ├── threat-model.md
│   ├── architecture.md
│   ├── implementation-plan.md
│   ├── policy-reference.md
│   ├── report-schema.md
│   ├── integrations.md
│   └── roadmap.md
└── .github/
    └── workflows/
```

Do not create future packages until the milestone requires them.

---

# 11. Core Domain Model

Design stable domain types before provider implementation.

At minimum:

```ts
export type Verdict =
  | "allow"
  | "warn"
  | "review"
  | "block"
  | "error";

export type Severity =
  | "info"
  | "low"
  | "medium"
  | "high"
  | "critical";

export type FindingBasis =
  | "evidence"
  | "policy"
  | "heuristic";

export interface PackageCoordinate {
  ecosystem: "npm";
  name: string;
  requestedSpec: string;
  resolvedVersion?: string;
}

export interface Evidence {
  provider: string;
  fetchedAt: string;
  sourceUrl?: string;
  stale?: boolean;
  digest?: string;
  data: Record<string, unknown>;
}

export interface Finding {
  ruleId: string;
  verdict: Exclude<Verdict, "error">;
  severity: Severity;
  basis: FindingBasis;
  title: string;
  message: string;
  evidence: Evidence[];
  remediation?: string;
  approvable: boolean;
}

export interface ProviderStatus {
  provider: string;
  status: "ok" | "error" | "timeout" | "rate_limited" | "offline" | "stale";
  fetchedAt?: string;
  message?: string;
}

export interface EvaluationReport {
  schemaVersion: "1.0";
  toolVersion: string;
  generatedAt: string;
  target: PackageCoordinate;
  verdict: Verdict;
  originalVerdict: Verdict;
  findings: Finding[];
  providerStatus: ProviderStatus[];
  policyDigest: string;
  evidenceDigest: string;
  approval?: ApprovalMatch;
  exitCodeMeaning: string;
}
```

The exact types may evolve during research, but changes must be documented.

---

# 12. Provider Architecture

All external data must live behind provider interfaces.

Do not allow raw provider response shapes to leak through business logic.

Example:

```ts
export interface PackageProvider {
  readonly id: string;

  getPackage(
    input: PackageCoordinate,
    options: ProviderOptions
  ): Promise<ProviderResult<PackageMetadata>>;
}

export interface VulnerabilityProvider {
  readonly id: string;

  query(
    input: PackageCoordinate,
    options: ProviderOptions
  ): Promise<ProviderResult<VulnerabilityRecord[]>>;
}
```

Each provider must:

- validate responses
- normalize data
- enforce timeouts
- enforce body-size limits
- bound retries
- provide descriptive errors
- expose provider status
- support fixtures/mocks
- avoid leaking secrets
- support offline mode where possible

---

# 13. HTTP Safety

Create one shared HTTP client.

Requirements:

- explicit request timeout
- bounded redirects
- bounded retries
- exponential backoff where appropriate
- response body-size limit
- descriptive User-Agent
- JSON content validation
- no credential logging
- no unbounded reads
- no automatic execution of returned content
- TLS only except fixture/local test servers
- deterministic error mapping

Provider errors must be distinguishable:

```text
timeout
rate_limited
invalid_response
not_found
network_error
provider_error
```

---

# 14. Policy Model

Initial repository policy:

```yaml
version: 1
mode: review

defaults:
  onProviderError: review
  onUnknownVersion: review
  allowPrerelease: false

registries:
  npm:
    enabled: true

rules:
  packageAge:
    minDays: 30
    action: review

  releaseAge:
    minHours: 72
    action: review

  requireRepositoryUrl:
    action: warn

  deprecatedPackage:
    action: review

  lifecycleScripts:
    action: review
    scripts:
      - preinstall
      - install
      - postinstall
      - prepack
      - prepare

  similarToExistingDependency:
    action: review

  knownMaliciousPackage:
    action: block

  vulnerabilities:
    action: review
    severities:
      - CRITICAL
      - HIGH

  nonRegistrySpecifier:
    action: review

approvals:
  requireReason: true
  requireExpiry: true
  maxValidityDays: 180

ci:
  failOn:
    - review
    - block
    - error
```

Policy parsing must be strict. Unknown security-sensitive fields should not be silently ignored.

---

# 15. Approval Model

Create:

```text
.agenthawk/approvals.yml
```

Example:

```yaml
version: 1

approvals:
  - ecosystem: npm
    name: example-exporter
    version: 1.0.0
    approvedBy: github:maintainer
    approvedAt: 2026-08-19T00:00:00Z
    expiresAt: 2027-01-01T00:00:00Z
    reason: Required vendor SDK; release and source reviewed.
    issue: https://github.com/org/repo/issues/123
```

Rules:

- exact ecosystem match
- exact package-name match
- exact resolved-version match
- reason required
- expiry required
- expired approval does nothing
- malformed approval fails validation
- approvals never remove original findings from reports
- approvals may resolve explicitly approvable `review` findings
- approvals must never override a known-malicious package `block`
- no wildcard approvals in v1
- no hidden command-line bypass

---

# 16. V1 Rule Set

Implement rules independently. Each rule returns structured findings.

## PG001: Package or version does not exist

Default: `block`

## PG002: Package is newly published

Default: `review`

Initial threshold: 30 days.

This is a heuristic, not proof of maliciousness.

## PG003: Selected release is extremely fresh

Default: `review`

Use a separate threshold from package age.

Research 72 hours as the initial candidate, but do not assume it is correct until research validates the tradeoff.

## PG004: Deprecated package

Default: `review`

## PG005: Package name resembles an existing direct dependency

Default: `review`

Start conservatively. Potential features:

- edit distance
- scope changes
- separator changes
- repeated letters
- prefix/suffix confusion

False positives must be tested carefully.

## PG006: Missing repository URL

Default: `warn`

Do not describe this as proof of maliciousness.

## PG007: Lifecycle scripts present

Default: `review`

Inspect:

- preinstall
- install
- postinstall
- prepack
- prepare

Do not execute them.

## PG010: Known malicious package record

Default: `block`

Must cite the source record ID.

This is evidence-based.

## PG011: Known vulnerability affecting resolved version

Default: `review`

Severity handling must follow actual provider data. Never invent severity.

## PG013: Required provider unavailable

Default: `review`

Strict policy may produce `error`.

## PG014: Dependency introduced without corresponding lockfile update

Implement during diff milestone.

Default: `review`

## PG015: Non-registry specifier

Examples:

- git URL
- HTTP URL
- file path
- unsupported alias/tag form

Default: `review`

---

# 17. Verdict Precedence

Use deterministic precedence.

Suggested model:

1. invalid input or invalid policy -> `error`
2. non-overridable hard block -> `block`
3. unresolved block -> `block`
4. unresolved review -> `review`
5. warnings -> `warn`
6. otherwise -> `allow`

Provider errors follow policy.

Approval application occurs after original findings are calculated.

Always preserve:

- original verdict
- final verdict
- approval effect

---

# 18. CLI Contract

Initial commands:

```bash
agenthawk init
agenthawk check npm <package-spec>
agenthawk policy validate
agenthawk doctor
```

After the first milestone is stable:

```bash
agenthawk scan
agenthawk diff --base <git-ref>
agenthawk approve npm <package-spec>
agenthawk verify-approvals
```

Output formats:

```text
terminal
json
github
```

SARIF comes later.

---

# 19. CLI Example

```text
AgentHawk v0.1.0

Target: npm:example-exporter@1.0.0
Verdict: REVIEW

REVIEW PG002  Package was first published 3 days ago.
REVIEW PG007  Package declares a postinstall lifecycle script.
WARN   PG006  No repository URL was present in registry metadata.
PASS   PG010  No matching malicious-package record found in enabled sources.
PASS   PG011  No matching vulnerability record found for the resolved version.

Action:
Review the package before installation or use an approved alternative.

Policy:
sha256:...

Evidence:
sha256:...
```

Terminal rendering must escape untrusted content and ANSI control sequences.

---

# 20. Exit Codes

Use stable documented exit codes:

```text
0 = allowed; warnings may exist
1 = review or block in strict mode
2 = invalid input or invalid policy
3 = required provider/evaluation error
4 = unexpected internal error
```

JSON output must also include `exitCodeMeaning`.

---

# 21. Cache

Implement a safe metadata cache only after core provider correctness works.

Requirements:

- cache public metadata only
- TTL
- provider-aware cache keys
- schema version
- staleness metadata
- safe corruption handling
- no tokens
- no private registry credentials
- `--offline`
- `--no-cache`

Offline mode must clearly report stale or missing evidence.

---

# 22. Git Diff Milestone

After `check` is stable, implement:

```bash
agenthawk diff --base origin/main
```

Rules:

- compare direct dependencies only
- detect additions and version changes
- classify dependency section
- handle scoped names
- detect lockfile presence/update
- avoid shell interpolation
- use Git argument arrays
- fail clearly on invalid refs
- never execute repository code

Use temporary Git repositories in integration tests.

---

# 23. GitHub Action Milestone

Only begin after research into GitHub Actions security is complete.

Requirements:

- checked-out repository only
- minimal permissions
- no `pull_request_target` unless a documented security reason exists
- safe job summary
- optional idempotent PR comment
- no raw untrusted provider dump in public comments
- optional JSON artifact
- comments require write permission only when enabled
- action behavior must be testable

Example:

```yaml
- uses: agenthawk/action@v1
  with:
    base-ref: main
    policy-path: .agenthawk.yml
    fail-on: review,block,error
    comment: summary
```

---

# 24. Agent Integration Milestone

Do not build vendor integration until JSON schema is stable.

Provide documentation/templates for:

- Codex
- Claude Code
- Cursor
- generic AGENTS.md workflows

Agent policy:

```text
Before adding or installing any new third-party dependency:

1. Run AgentHawk.
2. Parse the JSON verdict.
3. ALLOW: proceed.
4. WARN: show the warning.
5. REVIEW: stop and request approval.
6. BLOCK: do not install.
7. ERROR: do not install until evaluation succeeds.
8. Never bypass AgentHawk with force flags.
```

---

# 25. Future Command Shield Architecture

Do not implement now, but ensure the architecture can later represent security actions generically.

Potential future model:

```ts
export interface SecurityAction {
  kind:
    | "dependency"
    | "command"
    | "secret"
    | "repository"
    | "network";

  actor?: {
    type: "agent" | "human" | "ci";
    name?: string;
  };

  payload: Record<string, unknown>;
}
```

Do not prematurely migrate v1 code to this abstraction unless doing so clearly reduces complexity.

---

# 26. Testing Philosophy

Security behavior is incomplete until tested.

Tests must be deterministic and run offline wherever possible.

Never require the real npm registry or OSV service for unit tests.

Use saved fixtures and local mock servers.

---

# 27. Required Unit Tests

Test:

- package spec parsing
- scoped packages
- exact versions
- prereleases
- invalid names
- non-registry specifiers
- policy parsing
- invalid policies
- unknown security-sensitive fields
- every rule's positive path
- every rule's negative path
- verdict precedence
- approval matching
- approval expiry
- approval inability to override hard blocks
- provider timeout
- provider rate limiting
- malformed provider JSON
- stale cache behavior
- terminal escaping
- Markdown escaping
- secret redaction
- evidence digest stability
- policy digest stability

---

# 28. Required Fixtures

Create fixtures for:

- mature package
- nonexistent package
- fresh package
- mature package with fresh release
- deprecated package
- lifecycle-script package
- scoped package
- prerelease package
- package without repository
- vulnerable package
- known malicious package
- provider timeout
- rate limit
- malformed JSON
- oversized response
- hostile Markdown
- ANSI escape content
- suspicious Unicode package text
- non-registry dependency
- valid approval
- expired approval
- malformed approval

Fixtures should represent normalized test cases, not unnecessary copies of huge provider payloads.

---

# 29. Integration Tests

Use local mock HTTP servers.

Test complete flows:

```text
CLI input
  -> provider request
  -> normalization
  -> rule evaluation
  -> approvals
  -> verdict
  -> JSON
  -> exit code
```

For diff mode use temporary Git repositories.

Do not depend on network access.

---

# 30. Security Regression Tests

Add tests specifically for dangerous behavior.

Verify AgentHawk never:

- executes package scripts
- executes package-manager install commands
- uses `shell: true`
- interpolates package names into shell strings
- logs Authorization headers
- logs environment variables
- leaks npm tokens
- blindly renders terminal escape sequences
- silently allows provider failure
- accepts expired approvals
- accepts wildcard approvals
- allows approval to override known-malicious hard block

These tests are mandatory.

---

# 31. Quality Gates

Before every push, run the full gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
```

Also run CLI smoke tests such as:

```bash
pnpm agenthawk --help
```

and milestone-specific tests.

Do not push if any required check fails.

---

# 32. Coverage Expectations

Core security logic should target at least:

```text
90% statement coverage
90% branch coverage
```

Do not game coverage with meaningless tests.

Focus especially on:

- block paths
- review paths
- error paths
- provider failures
- approval logic
- precedence
- parsing
- escaping
- redaction

---

# 33. Commit and Push Protocol

The repository owner wants progress committed and pushed regularly.

## Before starting work

Run:

```bash
git status
git branch --show-current
git remote -v
git log -5 --oneline
```

Never discard unrelated user changes.

If the repository contains uncommitted user work:

- preserve it
- do not overwrite it
- isolate your changes when possible
- explain conflicts if isolation is impossible

## After every meaningful completed milestone

1. Review `git diff`.
2. Run the full required quality gate.
3. Update relevant documentation.
4. Run `git status`.
5. Stage only intended files.
6. Scan staged changes for accidental secrets.
7. Create a focused commit.
8. Push the current branch to its configured remote.
9. Verify the push succeeded.
10. Record the commit hash in the milestone summary.

Use conventional, meaningful commit messages, for example:

```text
docs: add AgentHawk security research
chore: initialize TypeScript workspace
feat(core): add npm package normalization
feat(policy): implement deterministic rule engine
feat(cli): add dependency check command
feat(osv): add vulnerability provider
test(core): add security regression fixtures
feat(action): add dependency review workflow
```

Do not use meaningless messages such as:

```text
update
changes
fix stuff
wip
```

## Do not push when

- tests fail
- typecheck fails
- lint fails
- build fails
- security regression tests fail
- secrets appear in the diff
- generated junk files are present
- the milestone leaves normal repository behavior broken

If authentication or remote permissions prevent pushing, do not repeatedly retry destructive alternatives. Make the local commit if appropriate, then report the exact blocker.

---

# 34. Branch Safety

Never:

- force push
- rewrite public history
- reset unrelated user commits
- delete remote branches
- push credentials
- modify Git remotes without explicit reason
- bypass protected branch rules

Follow repository branch conventions if they exist.

If no convention exists, keep changes small and avoid history rewriting.

---

# 35. Secret Scan Before Push

Before every push, inspect staged changes for obvious secrets.

At minimum check for accidental inclusion of:

- `.env`
- `.npmrc`
- API keys
- tokens
- private keys
- credential files
- provider authentication headers
- test secrets that resemble real credentials

Use obviously fake values in fixtures.

Never commit real credentials.

---

# 36. Documentation Must Stay Current

After each milestone update relevant docs.

The README must ultimately include:

- one-sentence problem
- why AI agents increase dependency risk
- quick start
- installation
- sample policy
- sample output
- strict mode
- approvals
- GitHub Action
- limitations
- threat model
- privacy model
- security disclosure
- development commands

Avoid claims such as:

- safe
- malware-free
- guaranteed secure
- verified benign

Prefer:

- policy finding
- risk signal
- known advisory
- matching malicious-package record
- no matching record found in enabled sources at evaluation time

---

# 37. Threat Model

Create and maintain:

```text
docs/threat-model.md
```

Assume:

- AI agents may issue arbitrary commands
- dependency names are untrusted
- package metadata is hostile input
- repository config is potentially malicious
- lockfiles can be malformed
- Git output can contain hostile strings
- APIs may fail
- APIs may return stale data
- a repository may contain secrets
- attackers may intentionally craft package metadata to exploit terminal/Markdown rendering

Threat model must cover:

- assets
- trust boundaries
- attackers
- abuse cases
- mitigations
- residual risk
- unsupported threats

---

# 38. Architecture Decision Records

For major decisions create lightweight ADRs in:

```text
docs/adr/
```

Examples:

```text
0001-policy-engine.md
0002-provider-boundaries.md
0003-approval-semantics.md
0004-cache-location.md
0005-github-action-design.md
```

Each ADR should contain:

```text
Context
Decision
Alternatives
Security implications
Consequences
Status
```

Do not create ADRs for trivial choices.

---

# 39. Performance Requirements

AgentHawk is in the developer feedback loop.

Design for:

- parallel provider requests
- bounded concurrency
- cache reuse
- OSV batching during scan
- no unnecessary repository traversal

Do not sacrifice correctness for micro-optimization.

Benchmark only after correctness.

---

# 40. Error Handling

Never expose raw stack traces by default.

Terminal example:

```text
AgentHawk could not complete the evaluation.

Provider: osv
Reason: request timed out
Policy response: REVIEW
```

Debug mode may expose diagnostic information after redaction.

JSON errors must remain schema-valid where possible.

---

# 41. Logging

Default output should be concise.

Future log levels:

```text
silent
normal
verbose
debug
```

Debug output must still redact secrets.

Never log complete process environments.

---

# 42. Deterministic Digests

Calculate stable digests for:

```text
policyDigest
evidenceDigest
```

Canonicalize input before hashing.

Do not rely on object insertion order accidentally.

Document digest semantics in:

```text
docs/report-schema.md
```

Tests must prove identical normalized input generates identical digests.

---

# 43. Report Persistence

A later milestone may save:

```text
.agenthawk/reports/
```

Reports must:

- use stable schema versions
- redact secrets
- include provider timestamps
- include findings
- include original/final verdict
- include approval effect
- include policy digest
- include evidence digest

Avoid storing unnecessary raw provider responses.

---

# 44. Dependency Discipline

AgentHawk itself is a supply-chain security tool.

Its own dependency practices must be strong.

Before adding a dependency:

1. explain why it is needed
2. prefer mature packages
3. minimize runtime dependency count
4. inspect package provenance where practical
5. prefer platform APIs for simple functionality
6. pin lockfiles
7. update dependency documentation if security-relevant

Do not add convenience dependencies for tiny utilities that can be implemented safely in a few lines.

---

# 45. Scope Control

Do not implement these during the first milestone:

- PyPI
- Cargo
- Maven
- NuGet
- MCP server
- hosted dashboard
- user accounts
- authentication
- billing
- database
- telemetry
- analytics
- command interception
- secret interception
- network sandbox
- full static malware analysis
- LLM security scoring
- browser automation
- package execution sandbox

Record good ideas in:

```text
docs/roadmap.md
```

Do not allow them to distract from a strong npm alpha.

---

# 46. Milestone Sequence

Use this sequence unless research produces a documented reason to change it.

## Milestone 0: Research

Deliver:

- ecosystem research
- competitor analysis
- provider research
- threat research
- architecture decisions
- implementation plan

Quality gate:

- docs reviewed for contradictions
- sources valid
- scope clearly defined

Commit and push.

## Milestone 1: Foundation

Deliver:

- pnpm workspace
- TypeScript strict mode
- lint/format
- Vitest
- build pipeline
- core/cli packages
- CI quality workflow
- domain types
- report schema
- config schema skeleton

Run all checks.

Commit and push.

## Milestone 2: npm Input and Provider

Deliver:

- package spec parser
- npm provider
- normalization
- HTTP safety client
- fixtures
- provider tests

Run all checks.

Commit and push.

## Milestone 3: Policy Engine

Deliver:

- policy schema
- deterministic rule engine
- precedence
- PG001 through PG007
- PG013
- PG015
- full tests

Run all checks.

Commit and push.

## Milestone 4: CLI Check

Deliver:

```bash
agenthawk check npm <package>
```

Support:

- terminal
- JSON
- strict mode
- policy path
- provider errors
- stable exit codes

Run all checks plus smoke tests.

Commit and push.

## Milestone 5: OSV Security Evidence

Deliver:

- OSV provider
- PG010
- PG011
- batch-ready architecture
- malicious package fixtures
- vulnerability fixtures

Run all checks.

Commit and push.

## Milestone 6: Approvals

Deliver:

- approvals schema
- exact matching
- expiry
- non-overridable hard block
- reporting
- tests

Run all checks.

Commit and push.

## Milestone 7: Cache and Offline

Deliver:

- TTL cache
- `--offline`
- `--no-cache`
- staleness reporting
- corruption handling

Run all checks.

Commit and push.

## Milestone 8: Scan and Diff

Deliver:

- direct dependency scan
- Git diff
- PG014
- temporary Git integration tests

Run all checks.

Commit and push.

## Milestone 9: GitHub Action

Deliver:

- secure action
- job summary
- JSON artifact
- optional idempotent PR comment
- least privilege
- action tests

Run all checks.

Commit and push.

## Milestone 10: Agent Templates

Deliver:

- AGENTS.md template
- Codex instructions
- Claude Code template
- Cursor template
- demo

Run all checks.

Commit and push.

---

# 47. Completion Report After Every Milestone

After each milestone, write a concise development report containing:

```text
Milestone:
Status:

Research/decisions:
Files changed:
Features added:
Tests added:
Commands run:
Lint:
Typecheck:
Tests:
Coverage:
Build:
Security checks:
Commit:
Push:
Remaining limitations:
Next milestone:
```

Do not claim a test passed unless it was actually executed successfully.

---

# 48. Failure Protocol

If something fails:

1. identify the root cause
2. do not weaken requirements reflexively
3. add or update a regression test when appropriate
4. fix the issue
5. rerun the focused test
6. rerun the full quality gate before pushing

If a provider assumption is wrong, update research and architecture documentation.

If a security requirement conflicts with usability, document the tradeoff before changing behavior.

---

# 49. Refactoring Rules

Refactor when:

- duplication becomes meaningful
- security behavior is hard to reason about
- tests reveal architecture friction
- provider abstractions leak
- responsibilities become unclear

Do not refactor simply to create abstraction layers.

Prefer readable code over design-pattern ceremony.

---

# 50. Code Review Checklist

Before every milestone commit review your own diff as if reviewing another engineer.

Check:

- Does this solve the milestone?
- Is scope contained?
- Are inputs validated?
- Are external responses validated?
- Could hostile strings reach terminal or Markdown output?
- Could secrets be logged?
- Could a shell be invoked?
- Could package code execute?
- Could provider failure accidentally become allow?
- Are error paths tested?
- Are approvals handled safely?
- Are docs accurate?
- Are test fixtures realistic?
- Did we add unnecessary dependencies?
- Did we change public behavior unintentionally?

---

# 51. Definition of Done for First Public Alpha

The first alpha is ready only when:

- npm package check works
- package/version existence is checked
- package age is checked
- release age is checked
- deprecation is checked
- repository metadata is checked
- lifecycle scripts are checked
- OSV vulnerability checks work
- known malicious-package records can block
- provider failure never silently allows
- approval files work
- known-malicious block cannot be normally overridden
- strict mode uses documented exit codes
- terminal output is readable
- JSON output is stable and validated
- tests run offline
- security regression tests pass
- core policy/rule coverage is at least 90%
- README is complete
- threat model exists
- SECURITY.md exists
- CONTRIBUTING.md exists
- license exists
- CI is green
- no telemetry exists
- no package code is executed during checks

---

# 52. Product Language

Use precise security language.

Good:

```text
risk signal
policy finding
known advisory
known malicious-package record
requires review
policy blocked
evidence unavailable
no matching record found
```

Avoid:

```text
safe package
malware-free
100% secure
verified benign
guaranteed protection
AI knows this is malicious
```

---

# 53. Branding

Project name:

```text
AgentHawk
```

Primary positioning:

> **The security layer between AI coding agents and your codebase.**

Initial product description:

> AgentHawk is a local-first, deterministic security gate that checks dependencies proposed by AI coding agents before they enter a repository.

Suggested short tagline:

> **Watch what your AI installs.**

The product should feel:

- technical
- trustworthy
- fast
- security-focused
- transparent
- developer-friendly

Avoid gimmicky AI language.

---

# 54. First-Run Experience

The ideal initial experience should eventually be close to:

```bash
pnpm add -D agenthawk
npx agenthawk init
npx agenthawk check npm example-package
```

Example result:

```text
AgentHawk

Target: npm:example-package@1.0.0
Verdict: REVIEW

PG002 REVIEW  Package first published 4 days ago.
PG007 REVIEW  postinstall script detected.
PG006 WARN    Repository metadata missing.

No package was installed.

Review the findings or add an explicit approval.
```

The user should understand AgentHawk without reading a long manual.

---

# 55. Critical Instructions to Codex

Do not:

- skip research
- start with a huge implementation
- copy a competitor
- use an LLM for security decisions
- add telemetry
- create cloud infrastructure
- create accounts
- add a database
- execute package code
- run install commands as part of dependency evaluation
- use `shell: true`
- add a force bypass
- suppress provider failures
- weaken tests to make them pass
- push failing code
- force push
- overwrite unrelated user work
- invent test results
- invent research citations
- claim guarantees AgentHawk cannot provide

Do:

- research deeply
- document evidence
- plan first
- implement incrementally
- test aggressively
- keep security decisions deterministic
- preserve privacy
- keep outputs explainable
- commit in small meaningful units
- push each completed green milestone
- verify every push
- keep docs synchronized
- maintain a clean repository
- think like an attacker before considering a milestone finished

---

# 56. Start Now

Begin with this sequence.

## Step 1: Inspect repository state

Run:

```bash
pwd
git status
git branch --show-current
git remote -v
git log -10 --oneline
find . -maxdepth 3 -type f | sort
```

Do not modify files yet.

## Step 2: Read existing project material

Read all existing:

- README files
- package manifests
- lockfiles
- architecture docs
- issue notes
- security docs
- CI configuration
- agent instructions

## Step 3: Perform mandatory research

Use current authoritative sources.

Create the research documents described above.

## Step 4: Create the implementation plan

Create:

```text
docs/implementation-plan.md
```

Do not implement core features until the research and plan are complete.

## Step 5: Architecture review

Review the proposed architecture against:

- security
- privacy
- determinism
- testability
- maintainability
- competitor differentiation
- future AgentHawk expansion

## Step 6: Commit the research milestone

Run available docs/lint checks.

Review the diff.

Commit the research and plan.

Push the commit.

Verify the push.

## Step 7: Begin Milestone 1

For every milestone after this, follow:

```text
research if needed
→ plan
→ implement
→ focused tests
→ security review
→ full quality gate
→ docs update
→ git diff review
→ secret scan
→ commit
→ push
→ verify push
→ milestone report
```

Continue autonomously through the roadmap unless:

- credentials are required and unavailable
- repository permissions prevent progress
- a destructive action would be required
- a major product decision falls outside this guide
- research shows a foundational assumption is invalid
- an unexpected legal/licensing issue requires owner input

When blocked, provide the exact blocker, the safest alternatives, and the recommended next action.

AgentHawk should be built like a security product that other developers can trust, inspect, test, and challenge.
