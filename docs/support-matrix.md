# Support matrix

Support snapshot: 2026-08-24 UTC

AgentHawk separates declared compatibility, upstream lifecycle status, and direct CI evidence. A compatible or tested environment is not a claim that the host or a dependency is secure.

## Runtime and operating systems

| Node.js major | Upstream state at snapshot | Declared compatible | Quality CI |
| --- | --- | --- | --- |
| 20 | End-of-life | No | No |
| 22 | LTS | Yes | Ubuntu, Windows, macOS GitHub-hosted runners |
| 24 | LTS | Yes | Ubuntu, Windows, macOS GitHub-hosted runners |
| 26 | Current | No | No |
| Other or future majors | Unknown or unsupported by this snapshot | No | No |

The package engine range is `^22.0.0 || ^24.0.0`. CI runner labels are moving external environments; this matrix does not promise a particular distribution build, Windows edition, macOS release, CPU architecture, or self-hosted-runner configuration. Exact workflow runs are the evidence for a commit.

## Package managers and dependency files

pnpm 10 is the development package manager. AgentHawk evaluates npm registry dependencies and recognizes root `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, and `bun.lockb` for change correlation. Recognition does not mean the corresponding package manager is installed, executed, or fully supported for native interception.

## Agent and CI integrations

| Integration | Current status |
| --- | --- |
| Codex | Advisory repository instruction template; `0.149.0` `PreToolUse` compatibility candidate implemented with exact local Windows CLI and app-server evidence; project-hook ownership design, root-bound artifact format, and read-only fixed-target status are implemented, but installer, recovery, activation, and removal remain unavailable and unsupported |
| Claude Code | Advisory project instruction template |
| Cursor | Advisory project rule template |
| Generic coding agent | Advisory instruction template |
| GitHub pull requests | Read-only dependency evaluation with isolated opt-in diagnostic commenter |
| Native pre-action hooks | Codex candidate and isolated host harnesses implemented; exact 0.149.0 local Windows CLI and local app-server stdio `shell_command` neutral/deny paths pass under the unelevated sandbox. Linux Docker evidence failed closed when the native sandbox namespace was unavailable; IDE, desktop, Remote, cloud, managed requirements, other operating systems and versions remain unproven. Root-bound project artifacts and read-only ownership status are implemented but no installer or activation test exists, so no native adapter is supported |

Advisory files do not prove that a host loaded or obeyed them. Protected CI remains the final repository gate.

`agenthawk init` is exercised by the same Ubuntu, Windows, and macOS Node 22/24 quality matrix. It targets local filesystems; Windows UNC roots are rejected, and portable no-replace guarantees are not claimed for network filesystems. File modes are best-effort and do not establish Windows ACL policy.

`agenthawk integrations codex status` is also exercised on the six-job Node 22/24 matrix. Its Git-layout fixtures cover ordinary roots, linked worktrees, submodules, and main worktrees with a separate Git directory. It is a point-in-time read-only observation and does not claim atomic exclusion of every reparse type, bind mount, same-account race, or hostile/network filesystem behavior.

## Lifecycle policy

The matrix is reviewed before each release against the official [Node.js release schedule](https://nodejs.org/en/about/previous-releases). AgentHawk does not perform a live lifecycle lookup during local checks or diagnostics. An older installed version therefore cannot know about lifecycle changes published after its bundled support snapshot.
