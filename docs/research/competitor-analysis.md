# Competitor analysis

Accessed: 2026-08-19. Adoption/activity values are point-in-time GitHub observations and should be refreshed before public comparative claims.

## Comparison

| Project | License; adoption/activity | Purpose and ecosystems | Pre-install/agent/policy capabilities | Strengths | Gaps relative to AgentHawk v1 |
|---|---|---|---|---|---|
| [OSV-Scanner](https://github.com/google/osv-scanner) | Apache-2.0; ~10.9k stars; active Aug 2026 | Known-vulnerability scanning across ecosystems | CLI/CI; OSV-based; not primarily an agent admission workflow | Mature matching, lockfile/SBOM support, strong upstream | No agent-specific approval contract, npm age/script/name-confusion policy |
| [GuardDog](https://github.com/DataDog/guarddog) | Apache-2.0; ~1.2k stars; active Aug 2026 | Heuristic malicious-package analysis for npm/PyPI and more | Can inspect remote/local packages before install; rule findings | Package-content heuristics and install-script detection | Different goal; content analysis is heavier and heuristic, no repository-scoped deterministic admission/approval model |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | Apache-2.0; ~5.6k stars; active Aug 2026 | Upstream repository security-practice signals | CLI/Action; score/checks rather than package admission | Transparent checks and broad adoption | Repository hygiene is not package/version maliciousness; GitHub-centric |
| [Rampart](https://github.com/peg/rampart) | Apache-2.0; ~82 stars; active Aug 2026 | Local runtime firewall for coding agents | Command/tool interception, policies, audit and host adapters | Broad action coverage and fail-closed runtime posture | Broader runtime surface; not specialized evidence normalization for npm admission |
| [Prismor](https://github.com/PrismorSec/prismor) | Apache-2.0; ~295 stars; active Aug 2026 | Self-hosted runtime control plane for tool calls | Observe/approve/block across agent hosts | Human-in-loop runtime visibility | Dashboard/control-plane orientation and broader runtime scope; not focused npm evidence contract |
| [Agent Security Scanner MCP](https://github.com/sinewaveai/agent-security-scanner-mcp) | MIT; ~120 stars; active Aug 2026 | MCP security/code/package hallucination scanner | Agent-callable MCP and CLI, multi-rule scanning | Direct agent integration and wide scanner scope | MCP/vendor coupling and scanning breadth; decision explainability/approval semantics differ |
| [Depshield MCP](https://github.com/devanshkaria88/depshield-mcp) | MIT; ~4 stars; active Apr 2026 | npm/PyPI dependency existence and CVE checks for agents | MCP pre-install checks and OSV batch audit | Close problem framing and simple agent access | Early adoption; narrower policy, provider-failure, approval, report-schema, and CI model |
| [AgentShield](https://github.com/affaan-m/agentshield) | MIT; ~1.1k stars; active Jul 2026 | Agent configuration/MCP/tool-permission security scanning | CLI, Action, plugin/app; supply-chain configuration checks | Broad agent ecosystem coverage | Scans agent environments rather than deciding a proposed npm coordinate |

Commercial or partly closed services such as Socket, Snyk, and Aikido provide strong registry-scale intelligence and integrations. They are relevant complements, but a mandatory cloud account, proprietary detection engine, or opaque score would conflict with AgentHawk's baseline local-first and deterministic decision principles.

## Differentiation

AgentHawk should not compete on universal malware detection or breadth. Its defensible v1 position is the narrow conjunction of:

- pre-install evaluation of the exact npm request and resolved version;
- explicit evidence/policy/heuristic bases;
- deterministic `allow/warn/review/block/error` precedence;
- fail-closed provider semantics;
- exact, expiring, version-scoped approvals that cannot override known-malicious blocks;
- local operation with no account/telemetry and offline-testable fixtures;
- stable JSON/exit codes usable by multiple agents and CI.

This differentiation is a product hypothesis, not proof of superiority. It must be validated through usability, false-positive calibration, and public security review.

## Source limitations

Feature data comes from project READMEs and repositories; no competitor code is copied. Stars are weak adoption signals. Rapidly changing projects may make this table stale. Before marketing publication, verify licenses, releases, hosted requirements, and exact policy/approval features again.
