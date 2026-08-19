import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SafeHttpClient, SafeHttpError } from "../src/http/safe-http-client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return new URL(`http://127.0.0.1:${address.port}/`);
}

describe("SafeHttpClient", () => {
  it("returns parsed JSON from a loopback fixture server", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });

    await expect(new SafeHttpClient().getJson(url)).resolves.toEqual({ ok: true });
  });

  it("follows bounded redirects", async () => {
    const url = await listen((request, response) => {
      if (request.url === "/") {
        response.statusCode = 302;
        response.setHeader("location", "/data");
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end('{"redirected":true}');
    });

    await expect(new SafeHttpClient({ maxRedirects: 1 }).getJson(url)).resolves.toEqual({
      redirected: true,
    });
  });

  it("rejects redirects that exceed the configured bound", async () => {
    const url = await listen((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "/again");
      response.end();
    });
    await expect(new SafeHttpClient({ maxRedirects: 0 }).getJson(url)).rejects.toMatchObject({
      kind: "provider_error",
      message: "Provider exceeded the redirect limit.",
    });
  });

  it("rejects a redirect without a location", async () => {
    const url = await listen((_request, response) => {
      response.statusCode = 302;
      response.end();
    });
    await expect(new SafeHttpClient().getJson(url)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ] as const)("maps HTTP %s to %s", async (status, kind) => {
    const url = await listen((_request, response) => {
      response.statusCode = status;
      response.end();
    });
    const error = await new SafeHttpClient({ maxRetries: 0 })
      .getJson(url)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SafeHttpError);
    expect((error as SafeHttpError).kind).toBe(kind);
  });

  it("rejects malformed JSON without exposing the response", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"token":"secret",');
    });
    await expect(new SafeHttpClient().getJson(url)).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Provider returned malformed JSON.",
    });
  });

  it("rejects a non-JSON content type", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("{}");
    });
    await expect(new SafeHttpClient().getJson(url)).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Provider did not return JSON content.",
    });
  });

  it("rejects a declared oversized response before reading it", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('{"ok":true}', {
        headers: { "content-length": "1000", "content-type": "application/json" },
      });
    await expect(
      new SafeHttpClient({ fetch, maxBodyBytes: 32 }).getJson(new URL("https://example.test")),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects an empty response body", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { headers: { "content-type": "application/json" } });
    await expect(
      new SafeHttpClient({ fetch }).getJson(new URL("https://example.test")),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects invalid UTF-8", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      });
    await expect(
      new SafeHttpClient({ fetch }).getJson(new URL("https://example.test")),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Provider response was not valid UTF-8.",
    });
  });

  it("rejects oversized streaming responses", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: "x".repeat(128) }));
    });
    await expect(new SafeHttpClient({ maxBodyBytes: 32 }).getJson(url)).rejects.toMatchObject({
      kind: "invalid_response",
    });
  });

  it("times out without including the URL in diagnostics", async () => {
    const url = await listen(() => undefined);
    const error = await new SafeHttpClient({ maxRetries: 0, timeoutMs: 10 })
      .getJson(url)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ kind: "timeout", message: "Provider request timed out." });
    expect((error as Error).message).not.toContain(url.toString());
  });

  it.each([
    "http://example.com/data",
    "ftp://example.com/data",
    "https://user:pass@example.com/data",
  ])("rejects unsafe provider URL %s", async (value) => {
    await expect(new SafeHttpClient().getJson(new URL(value))).rejects.toMatchObject({
      kind: "provider_error",
    });
  });

  it("validates numeric safety bounds", () => {
    expect(() => new SafeHttpClient({ timeoutMs: -1 })).toThrow(TypeError);
  });

  it("retries a transient network failure within the configured bound", async () => {
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("sensitive network details");
      return new Response('{"recovered":true}', {
        headers: { "content-type": "application/json" },
      });
    };
    const result = await new SafeHttpClient({ fetch, maxRetries: 1, retryDelayMs: 0 }).getJson(
      new URL("https://registry.example.test/data"),
    );

    expect(result).toEqual({ recovered: true });
    expect(attempts).toBe(2);
  });

  it("never sends authorization headers", async () => {
    let headers: Headers | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    await new SafeHttpClient({ fetch }).getJson(new URL("https://registry.example.test/data"));

    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.get("user-agent")).toBe("AgentHawk/0.0.0");
  });
});
