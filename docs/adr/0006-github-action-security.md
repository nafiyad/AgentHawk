# ADR 0006: Least-privilege GitHub Actions integration

Status: accepted

## Decision

The default AgentHawk workflow uses `pull_request`, never `pull_request_target`, and declares only `contents: read`. Fork pull requests receive no secrets or write token. Checkout disables persisted credentials. Third-party actions are pinned to immutable commit SHAs.

The pull-request checkout is untrusted and may execute during dependency installation, build, and AgentHawk evaluation. It therefore runs only on an ephemeral GitHub-hosted runner with a read-only token and no secrets. AgentHawk never promotes artifacts or data from this job into a privileged follow-up workflow.

The workflow writes a normalized JSON report to `.agenthawk/reports/`, uploads only that file with short retention, and writes a bounded escaped summary. Raw provider bodies and environment data are excluded. PR commenting is disabled unless a maintainer sets the repository variable `AGENTHAWK_PR_COMMENT` to `true`. The separate `workflow_run` commenter never checks out or executes pull-request content. It downloads only the normalized artifact, validates and bounds it as untrusted data, receives explicit `pull-requests: write`, and updates one bot-authored marker comment idempotently.

## Consequences

Fork checks can evaluate public providers but cannot comment. Maintainers can inspect the job summary and artifact without granting write access. Repositories that require private registries must design a separate trusted process and must not expose secrets while executing pull-request code.
