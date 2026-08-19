# Ecosystem landscape

Accessed: 2026-08-19

## Scope and method

AgentHawk v1 addresses one decision point: whether a newly proposed npm dependency may enter a repository. Research prioritizes specifications, registry/provider documentation, peer-reviewed work, and project repositories. Registry existence is necessary but not sufficient: a hallucinated name can be registered after it becomes predictable, and an established package can later be compromised.

## Threats

### Hallucinated dependencies and slopsquatting

Spracklen et al. measured package-name hallucinations in code-generating models and found both non-trivial rates and repeatability. A 2026 follow-up reports lower but persistent rates. The implication is not that every new package is malicious; it is that agents create a new path from plausible-looking names to unattended installation. Package existence detects only the pre-registration case. Age, release freshness, lifecycle scripts, provenance, known-malicious records, and repository context remain separate signals after registration.

### Typosquatting and name confusion

Similarity is heuristic. Edit distance, separator changes, scope changes, repeated characters, and prefix/suffix changes can surface review candidates, but popular naming conventions produce false positives. V1 compares a proposal only with the repository's direct dependencies and never labels similarity as maliciousness.

### Dependency confusion

npm selects registries by configuration and scope. Private unscoped names can collide with public packages; scoped packages may map to separate registries. AgentHawk must not read or report authentication material from `.npmrc`. V1 treats non-default/private registry resolution as an explicit policy boundary rather than pretending public-registry evidence covers private artifacts.

### Malicious or compromised packages

Known-malicious records are direct evidence when the ecosystem, name, and affected version match. Lifecycle scripts, missing repository metadata, package age, and release freshness are risk signals only. Absence of a record is not evidence that a package is benign. V1 does not execute or statically analyze package contents.

## What can be detected before installation

| Signal | Basis | Useful conclusion | Limitation |
|---|---|---|---|
| Package/version absent | Registry evidence | Requested registry coordinate cannot be resolved | Does not detect a name registered after hallucination |
| Known malicious OSV record | Evidence | Matching published record requires a hard block | Coverage and publication lag remain |
| Known vulnerability | Evidence | Resolved version matches an advisory | Severity may be absent; exploitability is contextual |
| Package/release age | Heuristic | Newly introduced artifact merits review | New legitimate projects/releases are common |
| Lifecycle scripts | Evidence plus policy | Code would run during common install flows | Presence does not prove harmful intent |
| Missing repository URL | Heuristic | Reduced inspectability | Metadata can be missing or falsified |
| Name similarity | Heuristic | Possible confusion with an existing dependency | Cannot infer author intent |
| Provenance | Evidence of build origin | Attestation can link an artifact to a workflow/source | Does not establish benign code or maintainer intent |

## Agent workflow implications

Codex supports repository instructions and composable CLI workflows; Claude Code exposes hooks that can run commands around tool use; Cursor exposes project rules and hooks; GitHub coding agents operate through repository workflows and pull requests. Vendor enforcement differs and can change, so v1 stabilizes a CLI/JSON contract first. Templates should instruct agents to call that contract and stop on `review`, `block`, or `error`; they are defense-in-depth, not an unbypassable sandbox.

## Sources

| Source | Organization/author | Finding | Confidence and limitation | AgentHawk implication |
|---|---|---|---|---|
| [We Have a Package for You](https://arxiv.org/abs/2406.10279) | Spracklen et al. | Package hallucinations are measurable and recurrent | Research dataset/model cohort; rates are not timeless | Treat agent proposals as untrusted inputs |
| [The Range Shrinks, the Threat Remains](https://arxiv.org/abs/2605.17062) | 2026 research preprint | Newer models still hallucinate package names | Preprint and cohort-specific | Do not assume model improvement removes the threat |
| [npm registry](https://docs.npmjs.com/misc/registry/) | npm | Registry selection depends on scope and configuration | Official behavior; compatible registries may differ | Model registry identity and avoid credential leakage |
| [npm package specifications](https://docs.npmjs.com/cli/v11/using-npm/package-spec) | npm | npm accepts names, aliases, folders, tarballs, URLs, and git specs | CLI grammar evolves | Explicitly classify non-registry specifiers |
| [npm package.json scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts) | npm | Lifecycle scripts can execute during install/publish flows | Exact lifecycle varies by command/version | Inspect metadata; never run package managers or package code |
| [OpenSSF Securing Software Repositories](https://repos.openssf.org/) | OpenSSF | Supply-chain controls require layered repository practices | General guidance, not package verdicts | Avoid a single opaque trust score |
| [Codex use cases](https://developers.openai.com/codex/use-cases) | OpenAI | Codex supports repository-oriented workflows and reusable skills/CLIs | Product behavior can evolve | Integrate through documented CLI instructions after schema stability |
| [Claude Code hooks](https://code.claude.com/docs/en/hooks) | Anthropic | Hooks can observe or gate tool lifecycle events | Hooks remain host configuration | Provide a template, not a vendor-specific core |
| [Cursor rules](https://docs.cursor.com/context/rules) | Cursor | Project rules provide persistent agent instructions | Rules guide rather than guarantee enforcement | Use CLI verdicts as the authoritative result |
