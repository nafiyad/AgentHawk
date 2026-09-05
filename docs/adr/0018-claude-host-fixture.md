# ADR 0018: Claude host-evidence fixture foundation

## Status

Accepted for development-only fixture implementation. Exact Claude `2.1.241`
wire exchange, host isolation, activation, and native support remain unproven.

## Context and primary evidence

The project-hook lifecycle is delivered. A repeatable host test needs deterministic
model-side stimuli without real credentials, paid inference, or package execution.
Public primary references, accessed 2026-09-05 UTC:

- Anthropic's [gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
  names the Messages endpoint, optional token counter, `?beta=true` query, and
  best-effort `HEAD /api/hello`. Some host traffic bypasses the gateway URL, so
  redirecting inference alone does not establish network isolation.
- Anthropic's [streaming protocol](https://platform.claude.com/docs/en/build-with-claude/streaming)
  defines message/content-block events, streamed tool input, stop reasons, and
  usage fields. The [Messages API](https://platform.claude.com/docs/en/api/messages/create)
  binds a later client `tool_result` to the issued `tool_use` identifier.
- Anthropic's [programmatic-mode guide](https://code.claude.com/docs/en/headless)
  distinguishes ordinary `-p`, which discovers project hooks without a trust
  dialog, from bare mode, which excludes discovered hooks. Neither behavior is
  evidence that this exact AgentHawk installation is activated.
- Node's [HTTP server documentation](https://nodejs.org/api/http.html)
  provides size/time controls and describes closing the listener before active
  connections. These are implementation primitives, not isolation guarantees.

Confidence is high for the published protocols, but documentation is not an
observation of the pinned executable. This fixture is deliberately narrower than
a general gateway and must never forward traffic upstream.

## Decision

Add a development-only module under `scripts/`, outside published package paths.
It binds only `127.0.0.1` on an ephemeral port, generates an in-memory fixture
capability, and accepts only bounded authenticated Messages/token-count requests
and a bounded connection probe. No caller-supplied executable or command is
accepted. The sole emitted command is a fixed harmless `echo` through `Bash`.

Exactly two inference requests are allowed: one initial user message produces a
fixed tool call; the next must repeat that initial message and contain the exact
assistant call immediately followed by one matching user result. A completed
exchange records only a client assertion, never execution, denial, or activation.
Token counting returns a fixed synthetic count and never advances this sequence.
Probe, token, inference, total-request, connection, body, header, and wall-clock
budgets are independent. The fixture rejects unexpected routes/queries, malformed
framing, unsupported encodings, inconsistent inventories, reordered or duplicate
tool IDs, concurrency, replay, and extra inference. A failure permanently prevents
a completed result. Closure is explicit and bounded, including partial requests.
The HTTP parser bounds header bytes; the handler enforces the header count without
native truncation hiding extra fields. Expectation, upgrade, parser-error, and
connection paths also produce sticky failure. The module participates in the
normal coverage gate without weakening its thresholds.

Reports retain only phase/error/result enums, counts, and closure state. Request
headers, system text, prompts, messages, tool results, and capability bytes are
not retained in reports or logs. There is no outgoing HTTP client, provider call,
filesystem mutation, process launch, package execution, or LLM security authority.
Ancillary request fields are transient bounded data, not interpreted instructions.

## Alternatives

- Real model calls were rejected for this deterministic prerequisite: they add
  credentials, cost, nondeterminism, and data disclosure.
- A general proxy or Anthropic SDK dependency was rejected: neither is needed to
  emit this fixed protocol exchange, and forwarding is explicitly forbidden.
- Treating a forged client result as execution evidence was rejected. The next
  driver requires independent filesystem execution/non-execution markers.

## Security implications and next gate

Loopback and a synthetic capability are not a sandbox. Do not point an ordinary
user session at this fixture. Before any real-host run, separately verify the
exact artifact/version, use disposable repository/configuration state, exclude
inherited credentials/hooks/plugins/MCP and managed-setting interference, and
establish the network boundary rather than relying only on an API base URL.
No user/global/managed trust or security setting is changed by this slice.

The driver must install/remove through the production transaction and distinguish
ordinary `-p` from interactive trust, bare/excluded settings, alternate shells,
timeouts, startup failures, artifact/settings mutation, and other clients. Every
support row stays unsupported until its full independently reviewed host matrix
passes. Existing host fail-open residuals and protected CI remain unchanged.

## Consequences

Run the fixture's offline tests with:

```sh
pnpm exec vitest run scripts/claude-messages-fixture.test.ts
```

This opens ephemeral loopback listeners only. It does not run Claude, install a
hook, contact Anthropic/npm/OSV, or change the host's environment or settings.

Offline fixture tests can establish only the fixture contract. A fresh exact-host
wire observation may require a reviewed contract amendment; it must not silently
relax existing tests or be represented as native support. No release or package
manifest change is required. Rollback is a new revert commit.
