# Security policy

## Supported versions

AgentHawk has published prerelease npm packages, but it has not published a stable supported release. Security fixes target `main` and are delivered through a reviewed new prerelease; published npm versions are immutable and are never rewritten.

| Version | Security fixes |
| --- | --- |
| `main` | Yes |
| Latest `0.x` prerelease | Reproduced fixes are released in a new prerelease when warranted |
| Older prereleases | No; upgrade to the newest available prerelease |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** feature in the Security tab of this repository. Include affected revision, impact, reproduction steps, and any proposed mitigation. Do not include real credentials or private repository content.

We aim to acknowledge a complete report within five business days. Timelines for validation, remediation, and coordinated disclosure depend on severity and complexity. We will credit reporters who request attribution and follow coordinated disclosure.

## Scope notes

AgentHawk remains prerelease software and must not be treated as a complete security boundary. A lack of findings or an `ALLOW` verdict does not mean a dependency is benign. Current capability and limitation details are maintained in [alpha acceptance status](docs/alpha-acceptance.md), and proposed future boundaries are separated in the [product roadmap](docs/roadmap.md).
