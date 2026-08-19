# ADR 0004: Public metadata cache location and trust boundary

Status: accepted

## Decision

AgentHawk caches only normalized public npm and OSV provider results. It never caches request headers, URLs containing credentials, environment variables, registry tokens, policy files, approval files, repository content, or raw provider bodies.

The default root follows the operating system cache convention:

- Windows: `%LOCALAPPDATA%/AgentHawk/Cache`, falling back to the user cache directory;
- macOS: `~/Library/Caches/AgentHawk`;
- Linux and other Unix: `$XDG_CACHE_HOME/agenthawk` or `~/.cache/agenthawk`.

Entries use a schema version and a SHA-256 filename derived from the provider identifier and canonical query key. User-controlled package names never become path components. Reads require a regular file, valid UTF-8, strict bounded JSON, the expected provider/key digest, and valid timestamps.

Fresh entries may satisfy evaluation. Stale or corrupt entries never silently become clean evidence. Offline stale/missing evidence produces visible provider status and PG013. `--no-cache` bypasses both reads and writes. `--offline` and `--no-cache` are mutually exclusive.

## Consequences

The cache improves availability without becoming an authority. Deleting it only removes reusable public evidence. Cache poisoning is constrained by schema, key, size, and timestamp checks, while users with write access to the local account can still tamper with local state; corrupted or mismatched entries therefore fail closed.
