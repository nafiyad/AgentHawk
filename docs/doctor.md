# Doctor command

`agenthawk doctor [--format terminal|json]` performs bounded local readiness checks. It is a diagnostic, not a claim that the host, repository, runtime, Git executable, dependency, or integration is secure.

## Checks

- Node satisfies the bundled `^22.0.0 || ^24.0.0` declaration and dated upstream-LTS snapshot.
- Independently compiled CLI and core versions match.
- Every observed cache-root path component must be a real directory rather than a symbolic link or junction; the root then accepts one exclusive sentinel create, bounded write, sync, close, and delete. No provider-shaped cache record is created.
- `git --version` returns bounded valid UTF-8 through AgentHawk's sanitized, no-shell Git runner.
- `.agenthawk.yml` and `.agenthawk/approvals.yml`, when present, pass the production bounded readers and strict schemas.
- Fixed Codex, Claude Code, Cursor, and GitHub workflow paths are absent, regular files, or invalid. Regular files are reported only as `present_unverified`.

Doctor does not recursively search, run npm/pnpm/Yarn/Bun/Corepack, import repository code, contact npm/OSV/GitHub, read credential stores, print paths or file contents, repair configuration, or install anything. Its only intentional write is the cache sentinel, which is removed before a writable result is returned.

## Results

- Exit `0`: all required checks completed in the ready state.
- Exit `1`: a complete report requires attention. This is not a dependency verdict.
- Exit `2`: invalid CLI syntax or output format.
- Exit `4`: an unexpected failure prevented a schema-valid report.

Absent policy, approvals, and optional integration files do not cause exit `1`. Invalid or unsafe files do. Policy discovery does not prove that another command was invoked with that policy; callers must continue to pass `--policy .agenthawk.yml` where required.

The support snapshot is bundled and dated. Doctor does not make a live lifecycle query, so an older AgentHawk release cannot know about later upstream lifecycle changes.
