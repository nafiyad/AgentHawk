# ADR 0007: Calibrate package- and release-age defaults

Status: accepted
Date: 2026-08-19

## Context

AgentHawk has two independent age heuristics:

- PG002 considers the age of the package identity, measured from the registry's package creation timestamp.
- PG003 considers the age of the selected version, measured from that version's publication timestamp.

They address different risks. A newly created name can be a typo, a registered package hallucination, or an intentionally new legitimate project. A fresh version of an established package can contain a mistake or a compromised release. Neither age signal proves that a package is benign or malicious, so both defaults produce review findings rather than blocks.

The initial policy used 30 days for PG002 and 72 hours for PG003. Before publication, those values required an explicit rationale and a false-positive calibration against real dependency manifests.

## Evidence

The npm registry's full package metadata exposes a package `created` timestamp and version publication timestamps in its `time` object. The registry documentation also warns that much package metadata is publisher-controlled, so AgentHawk uses the registry timestamps as bounded heuristic inputs rather than package-quality claims.

npm permits a newly created package to be unpublished during its first 72 hours when no other public-registry package depends on it. Renovate's npm security preset also uses a three-day minimum release age, citing both time for possible ecosystem detection and npm's unpublish window. npm and pnpm expose configurable minimum-release-age controls, which confirms the value of a cooldown but not a universal guarantee or one correct duration.

Package identity age is a separate control. USENIX Security 2025 research documents package hallucinations in generated code and the attack in which an adversary registers a hallucinated name. OpenSSF's malicious-package scope includes typosquatting, dependency confusion, account takeover, and malicious install behavior. A 30-day package-name review window provides time to notice an unfamiliar identity, but it cannot determine intent and does not replace PG005, PG007, PG010, or PG011.

Authoritative sources, accessed 2026-08-19:

- [npm registry package metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
- [npm `min-release-age` configuration](https://docs.npmjs.com/cli/using-npm/config/#min-release-age)
- [pnpm `minimumReleaseAge` setting](https://pnpm.io/settings#minimumreleaseage)
- [Renovate minimum release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)
- [Renovate npm best-practice preset](https://docs.renovatebot.com/presets-config/#configbest-practices)
- [We Have a Package for You!](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen), USENIX Security 2025
- [OpenSSF malicious-packages repository](https://github.com/ossf/malicious-packages)

## Calibration

The calibration corpus used the direct dependency manifests from five real JavaScript/TypeScript projects at fixed revisions:

| Source | Manifest revision | Direct dependency entries |
| --- | --- | ---: |
| AgentHawk | [`4b18d85`](https://github.com/nafiyad/AgentHawk/tree/4b18d85deae7d36260ecc2470d15db93b74bd26f) | 11 |
| Express | [`a371447`](https://github.com/expressjs/express/blob/a3714473feb3d2908add734d340e7755fd85e0a3/package.json) | 28 |
| Fastify | [`dbebe73`](https://github.com/fastify/fastify/blob/dbebe73c421597da96c3154c1036377f4e8e5117/package.json) | 15 |
| Vite | [`bdfadef`](https://github.com/vitejs/vite/blob/bdfadefb207039bdb06d547da67dc81a92fe8750/packages/vite/package.json) | 5 |
| ESLint | [`9ef407a`](https://github.com/eslint/eslint/blob/9ef407a3b051e74f50dc7fb8914e2bd89b3e5e53/package.json) | 30 |

The external-project counts use each selected package manifest's `dependencies`. AgentHawk's count also includes its direct development tooling because those dependencies execute in the project's development and CI trust boundary.

The 89 dependency entries represented 87 unique npm package names. At `2026-08-19T23:53:36.155Z`, the calibration retrieved full public registry metadata only. It did not download tarballs, install packages, or execute package code.

For release-age sensitivity, each unique package was observed once per day over the preceding 90 days. At each observation point, the analysis selected the highest currently visible stable SemVer published by that time. Prereleases, malformed versions, and versions no longer present in the current packument were excluded. This produced 7,917 package-day observations:

| Candidate release window | Observations below window | Share |
| --- | ---: | ---: |
| 24 hours | 94 / 7,917 | 1.19% |
| 48 hours | 182 / 7,917 | 2.30% |
| 72 hours | 268 / 7,917 | 3.39% |
| 7 days | 587 / 7,917 | 7.41% |

As a separate current-manifest check, resolving the 89 recorded dependency specifications at the calibration time produced four releases younger than 72 hours. None of the 87 package identities was younger than 7, 14, 30, or 60 days.

This is a deterministic sensitivity sample, not a population estimate. It favors mature open-source projects, does not reconstruct historical dist-tag changes or historical manifest revisions, and cannot measure how quickly malicious releases are detected. Its purpose is to compare review noise across candidate windows and verify that the defaults behave reasonably on established projects.

## Decision

Retain the secure defaults:

```yaml
rules:
  packageAge:
    minDays: 30
    action: review
  releaseAge:
    minHours: 72
    action: review
```

The exact threshold boundary is mature: a package or release whose age equals the configured threshold does not receive the age finding. A younger value does.

The 72-hour release default aligns with npm's exceptional unpublish window and an established Renovate npm security preset. In the calibration it created materially less review volume than seven days while preserving more observation time than 24 or 48 hours.

The 30-day package default is intentionally more conservative because a new identity has no established name history. It remains review-only, is configurable per repository, and must never be presented as a claim that an older package is trustworthy. The mature-project corpus produced no PG002 findings, which is expected and indicates low friction for established dependency names.

## Alternatives considered

- **No age checks:** rejected because it removes a deterministic signal for newly created identities and fresh releases.
- **A 24- or 48-hour release window:** lower friction, but it ends before npm's 72-hour exceptional unpublish window.
- **A 7- or 14-day release window:** provides more observation time, but the calibration shows that seven days more than doubles the findings produced by 72 hours and can delay urgent fixes.
- **A 7- or 14-day package window:** lower friction for legitimate new projects, but provides little identity-history observation for hallucination registration or typosquatting review.
- **A 60- or 90-day package window:** more conservative, but imposes prolonged review on legitimate new projects without evidence that the extra duration is proportionate.
- **Popularity, download, or maintainer-count thresholds:** rejected for the default decision because popularity is manipulable, penalizes niche packages, and does not protect against compromise of established packages.

## Security implications

- Age is a heuristic and never a benign/malicious classifier.
- Mature packages and old versions can still be compromised; the remaining evidence and policy rules stay active.
- A cooldown can delay a security fix. Maintainers can use an exact, reasoned, expiring approval for approvable review findings after inspecting the release. Hard malicious-package blocks remain non-overridable.
- Missing or invalid publication timestamps continue to produce PG013 rather than silently bypassing the age rules.
- Repository policies can tune either threshold and action for their risk tolerance. AgentHawk does not add hidden exclusions.
- No telemetry is required. Future recalibration must use explicit, reviewable evidence rather than user data collection.

## Consequences

The runtime defaults do not change. Existing boundary and secure-default tests remain the executable contract. Documentation now records why the values were retained, the observed tradeoff, and the limits of the evidence.

Recalibration should occur after meaningful public-alpha feedback, a material npm policy change, or evidence that the defaults create excessive false positives or miss the intended observation window. Any change requires a reviewed policy-version decision and synchronized tests and documentation.
