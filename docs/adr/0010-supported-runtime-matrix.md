# ADR 0010: Supported runtime matrix

Status: accepted

## Context

AgentHawk advertised Node.js 20 or newer and ran its quality workflow only on Ubuntu with Node 20. The Node.js project marks Node 20 end-of-life as of 2026-03-24 and states that production applications should use Active or Maintenance LTS releases. At the 2026-08-21 review date, Node 22 and Node 24 are LTS; Node 26 is Current rather than LTS.

A security control must distinguish a runtime that happens to execute the code from one that the project deliberately supports and tests. A broad lower bound such as `>=20` would also accept end-of-life odd releases and untested future majors.

## Decision

The development and next-release package engine range is `^22.0.0 || ^24.0.0`. Quality CI runs the complete gate on Node 22 and Node 24 across GitHub-hosted Ubuntu, Windows, and macOS runners. The dependency-diff workflow runs on Node 24, and release jobs use an exact reviewed Node 24 patch.

AgentHawk documents three distinct properties:

- **declared compatible** — the runtime satisfies the package engine range;
- **upstream supported** — the bundled, dated support matrix identifies the major as an upstream LTS line;
- **CI tested** — the repository runs its documented gate for that Node/runner combination.

Current, end-of-life, and future Node majors do not become supported merely because they can execute AgentHawk. The matrix is reviewed before each release because upstream lifecycle status changes over time.

## Alternatives

- Keep `>=20`: rejected because it includes an end-of-life baseline, odd-numbered EOL releases, and untested future majors.
- Require only Node 24: simpler, but unnecessarily excludes the still-supported Node 22 LTS line.
- Include Node 26 Current immediately: rejected until the project deliberately qualifies it and decides whether non-LTS runtimes belong in the support policy.

## Security implications

Dropping Node 20 avoids claiming support for a runtime that no longer receives upstream security fixes. A CI pass is compatibility evidence, not proof that the runner, runtime, dependencies, or AgentHawk are vulnerability-free. GitHub-hosted runner labels are external moving environments, so the workflow records its exact run evidence while documentation avoids claiming a fixed operating-system build or architecture.

## Consequences

Users on Node 20 must upgrade to Node 22 or 24 before installing a future AgentHawk release. CI cost increases because the full gate runs across six combinations. The forthcoming `doctor` command can use this versioned matrix without performing a network lifecycle lookup or overstating Current/future-runtime support.

## Sources

- [Node.js release schedule](https://nodejs.org/en/about/previous-releases), accessed 2026-08-21.
- [Node.js end-of-life policy](https://nodejs.org/en/about/eol), accessed 2026-08-21.
