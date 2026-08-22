import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SafeHttpClient, SafeHttpError } from "../src/http/safe-http-client.js";
import { OperationCancelledError } from "../src/operation.js";

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

  it("times out when a response body stalls after headers", async () => {
    const url = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.write('{"partial":');
    });

    const error = await new SafeHttpClient({ maxRetries: 0, timeoutMs: 20 })
      .getJson(url)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ kind: "timeout", message: "Provider request timed out." });
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

  it("starts no fetch for a pre-cancelled operation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("untrusted reason"));
    let fetched = false;
    const fetch: typeof globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}");
    };

    await expect(
      new SafeHttpClient({ fetch }).getJson(new URL("https://example.test"), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(OperationCancelledError);
    expect(fetched).toBe(false);
  });

  it("cancels a retry delay without starting another attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      throw new TypeError("network failure");
    };
    const pending = new SafeHttpClient({ fetch, maxRetries: 2, retryDelayMs: 10_000 }).getJson(
      new URL("https://example.test"),
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
    expect(attempts).toBe(1);
  });

  it("preserves caller cancellation while a response body is pending", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        bodyCancelled = true;
      },
      start: (stream) => stream.enqueue(new TextEncoder().encode('{"partial":')),
    });
    const fetch: typeof globalThis.fetch = async () =>
      new Response(body, { headers: { "content-type": "application/json" } });
    const pending = new SafeHttpClient({ fetch, maxRetries: 1, timeoutMs: 10_000 }).getJson(
      new URL("https://example.test"),
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error("untrusted"));

    await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
    expect(bodyCancelled).toBe(true);
  });

  it("preserves the first abort cause when local timeout wins", async () => {
    const controller = new AbortController();
    const fetch: typeof globalThis.fetch = async (_url, options) =>
      await new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => setTimeout(() => reject(new Error("delayed abort")), 20),
          { once: true },
        );
      });
    const pending = new SafeHttpClient({ fetch, maxRetries: 0, timeoutMs: 10 }).getJson(
      new URL("https://example.test"),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });

  it.each([
    { headers: {}, status: 302 },
    { headers: { "content-length": "100" }, status: 200 },
  ])("cancels rejected response bodies", async ({ headers, status }) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
      start: (stream) => stream.enqueue(new TextEncoder().encode("content")),
    });
    const fetch: typeof globalThis.fetch = async () => new Response(body, { headers, status });
    await expect(
      new SafeHttpClient({ fetch, maxBodyBytes: 8, maxRedirects: 1 }).getJson(
        new URL("https://example.test"),
      ),
    ).rejects.toBeInstanceOf(SafeHttpError);
    expect(cancelled).toBe(true);
  });

  it("never sends authorization headers", async () => {
    let headers: Headers | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    await new SafeHttpClient({ fetch }).getJson(new URL("https://registry.example.test/data"));

    expect(headers?.has("authorization")).toBe(false);
    expect(headers?.get("user-agent")).toBe("AgentHawk/0.1.0-alpha.1");
  });

  it("posts bounded JSON without following redirects", async () => {
    const url = await listen((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "/next");
      response.end();
    });
    await expect(
      new SafeHttpClient().postJson(url, { package: { name: "example" } }),
    ).rejects.toMatchObject({
      kind: "provider_error",
      message: "Provider POST must not redirect.",
    });
  });

  it("rejects oversized JSON request bodies before sending", async () => {
    let sent = false;
    const fetch: typeof globalThis.fetch = async () => {
      sent = true;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    };
    await expect(
      new SafeHttpClient({ fetch, maxRequestBytes: 8 }).postJson(
        new URL("https://api.example.test"),
        {
          payload: "oversized-request",
        },
      ),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Request body exceeded the size limit.",
    });
    expect(sent).toBe(false);
  });

  it("posts JSON with content-type and without authorization", async () => {
    let method: string | undefined;
    let headers: Headers | undefined;
    let body: string | undefined;
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      method = init?.method;
      headers = new Headers(init?.headers);
      body = String(init?.body);
      return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
    };
    await expect(
      new SafeHttpClient({ fetch }).postJson(new URL("https://api.example.test/v1/query"), {
        version: "1.0.0",
      }),
    ).resolves.toEqual({ ok: true });
    expect(method).toBe("POST");
    expect(headers?.get("content-type")).toBe("application/json");
    expect(headers?.has("authorization")).toBe(false);
    expect(body).toBe('{"version":"1.0.0"}');
  });

  it("rejects request bodies that cannot be encoded as JSON", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      new SafeHttpClient().postJson(new URL("https://api.example.test"), circular),
    ).rejects.toMatchObject({
      kind: "invalid_response",
      message: "Request body could not be encoded as JSON.",
    });
  });
});
