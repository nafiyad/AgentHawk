# Architecture

## Current boundary

AgentHawk currently provides a reusable core for parsing npm dependency requests and gathering normalized npm registry metadata. It does not yet make policy decisions or expose `agenthawk check`.

```text
untrusted package spec
        |
        v
conservative parser ----> non-registry classification
        |
        v
package coordinate
        |
        v
npm provider ----> bounded HTTP client ----> configured registry
        |
        v
normalized metadata (no raw response)
```

## Input model

Registry inputs are separated from aliases, Git references, URLs, file/directory paths, and workspace references before network access. Registry names use a conservative lowercase npm grammar. Selectors are classified with the canonical `semver` implementation as exact versions, ranges, tags, or the default wildcard.

Non-registry inputs are not fetched by the npm provider. A later policy rule will report them as explicit review findings.

## HTTP safety boundary

All provider traffic uses `SafeHttpClient`. Remote URLs require HTTPS; HTTP is permitted only for loopback fixture servers. Credentials in URLs are rejected. Requests use explicit time, body, redirect, and retry bounds. Redirects are handled manually and revalidated. Responses must be successful JSON with valid UTF-8 and fit within the byte limit.

Errors are normalized to `timeout`, `rate_limited`, `invalid_response`, `not_found`, `network_error`, or `provider_error`. Diagnostics exclude request URLs, response bodies, headers, and caught exception details so tokens or hostile metadata are not reflected.

## npm provider

The provider retrieves one package document, validates only the required shape, resolves exact versions/tags/ranges, and returns selected fields:

- resolved version;
- first-publication and selected-release timestamps;
- deprecation text;
- repository URL;
- names of security-relevant lifecycle scripts;
- tarball URL and integrity metadata.

It does not retain arbitrary scripts, maintainers, README content, or the raw registry response. It never downloads a tarball, invokes a package manager, imports package code, or executes lifecycle scripts.

## Planned next boundary

The policy milestone will consume normalized metadata through structured rules. Provider availability will remain separate from findings so unavailable evidence cannot silently result in `allow`.
