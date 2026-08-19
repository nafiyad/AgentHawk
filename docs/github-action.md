# GitHub Actions integration

The repository includes a least-privilege AgentHawk pull-request workflow. It compares direct dependency changes with the pull request's exact base commit, writes a bounded job summary, and uploads the normalized JSON report for seven days.

The evaluation job declares only `contents: read`, persists no checkout credential, receives no project secrets, and never uses `pull_request_target`. This makes public-fork execution suitable for an ephemeral GitHub-hosted runner, while the checked-out pull-request code remains untrusted.

## Optional pull request comment

Comments are disabled by default. A maintainer may create the repository Actions variable `AGENTHAWK_PR_COMMENT` with the exact value `true`. The separate `workflow_run` job then receives `pull-requests: write`, downloads the normalized report as untrusted data, labels it as a pull-request-controlled diagnostic rather than an independently verified verdict, and updates one comment containing the marker `agenthawk-dependency-diff:v1` from `github-actions[bot]`.

The privileged commenter does not check out, build, import, or execute pull-request content. Do not combine it with a pull-request checkout or add secrets to the evaluation workflow.
