# Codex `PreToolUse` fixture provenance

These sanitized fixtures model the POSIX `Bash` command-hook subset reviewed on 2026-08-23.

- Codex release: [`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0)
- Commit: `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`
- Input schema blob: `48dd4c571010a664e40cb174123c3bc746f12e34`
- Output schema blob: `6730b27fd4fc80f8075d64346a554a1cfc94470a`
- Runtime semantics: [`pre_tool_use.rs`](https://github.com/openai/codex/blob/rust-v0.149.0/codex-rs/hooks/src/events/pre_tool_use.rs)

They are derived minimal fixtures, not copied runtime captures. Passing them does not prove compatibility with an installed Codex host. No session, transcript, user, repository, or credential data is present.
