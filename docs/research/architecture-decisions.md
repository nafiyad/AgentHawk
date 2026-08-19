# Research architecture decisions

Accessed/reviewed: 2026-08-19

## 1. Exact first problem

Decide, before installation, whether a newly proposed npm registry dependency/version may enter a repository under explicit local policy, using bounded public evidence and without executing package code.

## 2. Overlapping tools

OSV-Scanner covers known vulnerabilities; GuardDog covers package-code heuristics; Scorecard covers upstream hygiene; Rampart/Prismor cover runtime agent actions; MCP scanners expose security checks to agents; commercial platforms add proprietary registry intelligence. None eliminates the need for a narrow, transparent repository admission contract, but AgentHawk must interoperate rather than claim replacement.

## 3. Defensible differentiation

Deterministic pre-install decisions, explicit basis per finding, fail-closed evidence acquisition, exact approvals, no account/telemetry, offline deterministic tests, and a vendor-neutral JSON/exit-code contract.

## 4. V1 providers

Use the npm registry for resolution/metadata and OSV for known vulnerability and malicious-package records. Defer deps.dev to optional enrichment. Provider identity, timestamps, status, and normalized evidence are reported.

## 5. Direct evidence

Exact registry existence/version, declared lifecycle scripts, deprecation/repository metadata, publication times, exact OSV matches, and verified provenance facts. Direct evidence proves only the stated fact.

## 6. Heuristics

Package age, selected-release freshness, missing repository metadata, and conservative similarity to an existing direct dependency. They default to warn/review, never a maliciousness claim.

## 7. Signals not used as verdict authorities

Downloads, stars, maintainer count, LLM judgment, opaque numeric risk scores, repository popularity, unverified provenance badges, and absence of advisories. Future signals require an ADR and calibration data.

## 8. False-positive risks

New legitimate projects/releases, intentional forks, metadata omissions, naming conventions, private registries, and prereleases. Mitigate with structured explanation and scoped approval, not a force bypass.

## 9. False-negative risks

Mature compromise, malicious code without lifecycle scripts, provider lag/outage, falsified metadata, semantically confusing names, and provenance of malicious source. Provider failure never silently allows, but no combination certifies benignness.

## 10. Claims to avoid

Do not say safe, malware-free, verified benign, guaranteed secure, or complete detection. Say what evidence was checked, what matched, and what remained unavailable.

## 11. Smallest strong alpha

`agenthawk check npm <spec>` with strict parsing, npm metadata, OSV queries, PG001/2/3/4/5/6/7/10/11/13/15, strict policy validation, exact approvals, terminal/JSON output, stable exit codes, and offline unit/integration/security tests. Cache, scan/diff, Action, and templates follow only after check correctness.

## 12. Architecture

A TypeScript monorepo with a pure core domain/policy engine and thin CLI adapter. Provider interfaces normalize hostile responses through a shared safe HTTP client. Rules consume normalized evidence and return structured findings; precedence and approval application are separate pure stages. Renderers escape untrusted strings. This leaves room for later action kinds without prematurely generalizing v1.

## Decision records

- ADR-0001 will define deterministic policy and verdict precedence.
- ADR-0002 will define provider and safe-HTTP boundaries.
- ADR-0003 will define approval semantics.
- Cache and GitHub Action decisions wait for their milestones.

## Internal consistency review

The design preserves local-first behavior while acknowledging that fresh public evidence requires network access. It separates direct evidence from heuristics, makes unavailable required evidence visible, never executes package code, and constrains v1 to npm. No researched provider offers a benignness guarantee, so the report language and verdict model remain policy decisions rather than safety certification.
