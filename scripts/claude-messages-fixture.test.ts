import { request } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_COMMAND,
  FIXTURE_MARKER_COMMAND,
  FIXTURE_MODEL,
  FIXTURE_TOOL_ID,
  startClaudeMessagesFixture,
} from "./claude-messages-fixture.mjs";

const httpFault = vi.hoisted(() => ({
  mode: "none" as "none" | "listen_error" | "close_error" | "close_timeout",
  server: undefined as import("node:http").Server | undefined,
}));

// Keep real loopback transport; intercept only otherwise rare Node failure callbacks.
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      httpFault.server = server;
      if (httpFault.mode === "listen_error") {
        server.listen = () => {
          queueMicrotask(() => server.emit("error", new Error(PRIVATE_TEXT)));
          return server;
        };
      }
      if (httpFault.mode === "close_error" || httpFault.mode === "close_timeout") {
        const mode = httpFault.mode;
        const originalClose = server.close.bind(server);
        server.close = (callback) =>
          originalClose((cause) => {
            if (mode === "close_error") callback?.(cause ?? new Error(PRIVATE_TEXT));
          });
      }
      return server;
    },
  };
});

type Fixture = Awaited<ReturnType<typeof startClaudeMessagesFixture>>;
type Response =
  | { status: number; contentType: string | undefined; body: string }
  | { transportError: true };

const fixtures: Fixture[] = [];
const sockets: Socket[] = [];
const PRIVATE_TEXT = "fixture-private-sentinel-do-not-retain";

async function fixture(options: Parameters<typeof startClaudeMessagesFixture>[0] = {}) {
  const instance = await startClaudeMessagesFixture(options);
  fixtures.push(instance);
  return instance;
}

function firstRequest() {
  return {
    model: FIXTURE_MODEL,
    max_tokens: 128,
    stream: true,
    tools: [
      {
        name: "Bash",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    messages: [{ role: "user", content: PRIVATE_TEXT }],
  };
}

function secondRequest(isError?: boolean) {
  const initial = firstRequest();
  return {
    ...initial,
    messages: [
      ...initial.messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: FIXTURE_TOOL_ID,
            name: "Bash",
            input: { command: FIXTURE_COMMAND },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: FIXTURE_TOOL_ID,
            content: PRIVATE_TEXT,
            ...(isError === undefined ? {} : { is_error: isError }),
          },
        ],
      },
    ],
  };
}

async function send(
  instance: Fixture,
  body: unknown = firstRequest(),
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string | string[] | undefined>;
    raw?: Buffer | string;
    trailers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const encoded = options.raw ?? JSON.stringify(body);
  const headers = Object.fromEntries(
    Object.entries({
      ...instance.headers,
      "content-type": "application/json",
      ...options.headers,
    }).filter(([, value]) => value !== undefined),
  );
  return new Promise((resolve) => {
    const outgoing = request(
      new URL(options.path ?? "/v1/messages", instance.origin),
      { method: options.method ?? "POST", headers, agent: false },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("error", () => resolve({ transportError: true }));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode ?? 0,
            contentType: incoming.headers["content-type"],
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", () => resolve({ transportError: true }));
    outgoing.setTimeout(2_000, () => outgoing.destroy());
    if (options.trailers) outgoing.addTrailers(options.trailers);
    outgoing.end(encoded);
  });
}

function successful(response: Response) {
  expect(response).not.toHaveProperty("transportError");
  if ("transportError" in response) throw new Error("Fixture response was unavailable");
  expect(response.status).toBe(200);
  return response;
}

function events(response: Response) {
  const received = successful(response);
  expect(received.contentType).toContain("text/event-stream");
  expect(received.body).not.toContain(PRIVATE_TEXT);
  return received.body
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^event: [a-z_]+$/u);
      expect(lines[1]).toMatch(/^data: /u);
      const event = lines[0].slice("event: ".length);
      const data = JSON.parse(lines[1].slice("data: ".length));
      expect(data.type).toBe(event);
      return { event, data };
    });
}

function rejected(instance: Fixture, response: Response) {
  if (!("transportError" in response)) {
    expect(response.status).toBe(400);
    expect(response.body).not.toContain(PRIVATE_TEXT);
    expect(response.body).not.toContain(instance.headers["x-api-key"]);
    expect(response.body.length).toBeLessThan(256);
  }
  const snapshot = instance.snapshot();
  expect(snapshot.state).toBe("failed");
  expect(snapshot.error).toMatch(/^[a-z][a-z_]+$/u);
  expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_TEXT);
  expect(JSON.stringify(snapshot)).not.toContain(instance.headers["x-api-key"]);
}

async function socket(instance: Fixture) {
  const target = new URL(instance.origin);
  const connection = connect({ host: target.hostname, port: Number(target.port) });
  sockets.push(connection);
  connection.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    connection.once("connect", resolve);
    connection.once("error", reject);
  });
  return connection;
}

function incompletePost(instance: Fixture) {
  const target = new URL(instance.origin);
  return (
    "POST /v1/messages HTTP/1.1\r\n" +
    `Host: ${target.host}\r\n` +
    `x-api-key: ${instance.headers["x-api-key"]}\r\n` +
    "anthropic-version: 2023-06-01\r\n" +
    "Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"
  );
}

afterEach(async () => {
  httpFault.mode = "none";
  for (const connection of sockets.splice(0)) connection.destroy();
  await Promise.all(fixtures.splice(0).map((instance) => instance.close()));
  httpFault.server = undefined;
});

describe("Claude Messages fixture fixed protocol", () => {
  it("exposes an ephemeral IPv4 loopback origin and unique transient capabilities", async () => {
    const left = await fixture();
    const right = await fixture();
    expect(FIXTURE_MODEL).toBe("claude-sonnet-4-6");
    expect(FIXTURE_COMMAND).toBe("echo agenthawk-fixture-neutral");
    expect(FIXTURE_TOOL_ID).toBe("toolu_agenthawk_fixture_1");
    expect(left.origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    expect(left.origin).not.toBe(right.origin);
    expect(left.headers["anthropic-version"]).toBe("2023-06-01");
    expect(left.headers["x-api-key"]).not.toBe(right.headers["x-api-key"]);
    expect(left.headers["x-api-key"].length).toBeGreaterThanOrEqual(32);
    expect(Object.keys(left).sort()).toEqual(["close", "headers", "origin", "snapshot"]);
    expect(left.snapshot()).toEqual({
      state: "awaiting_request",
      error: null,
      result: "unobserved",
      counts: { requests: 0, inference: 0, countTokens: 0, probes: 0, connections: 0 },
      closed: false,
    });
  });

  it.each([undefined, false, true])(
    "completes two strictly ordered requests with client is_error=%s, not execution evidence",
    async (isError) => {
      const instance = await fixture();
      const initialEvents = events(await send(instance));
      expect(initialEvents.map(({ event }) => event)).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(initialEvents[0].data.message).toMatchObject({
        type: "message",
        role: "assistant",
        model: FIXTURE_MODEL,
        content: [],
        stop_reason: null,
      });
      expect(initialEvents[1].data).toMatchObject({
        index: 0,
        content_block: { type: "tool_use", id: FIXTURE_TOOL_ID, name: "Bash", input: {} },
      });
      expect(initialEvents[2].data.index).toBe(0);
      expect(initialEvents[2].data.delta.type).toBe("input_json_delta");
      expect(JSON.parse(initialEvents[2].data.delta.partial_json)).toEqual({
        command: "echo agenthawk-fixture-neutral",
      });
      expect(initialEvents[3].data.index).toBe(0);
      expect(initialEvents[4].data.delta).toMatchObject({ stop_reason: "tool_use" });
      expect(instance.snapshot()).toMatchObject({
        state: "awaiting_result",
        result: "unobserved",
        error: null,
        counts: { inference: 1 },
      });

      const finalEvents = events(await send(instance, secondRequest(isError)));
      expect(finalEvents.map(({ event }) => event)).toEqual(
        initialEvents.map(({ event }) => event),
      );
      expect(finalEvents[1].data).toMatchObject({ index: 0, content_block: { type: "text" } });
      expect(finalEvents[2].data).toMatchObject({ index: 0, delta: { type: "text_delta" } });
      expect(finalEvents[4].data.delta).toMatchObject({ stop_reason: "end_turn" });
      expect(JSON.stringify(finalEvents)).not.toMatch(
        /executed|activated|approved|denied|protected/iu,
      );
      const complete = instance.snapshot();
      expect(complete).toMatchObject({
        state: "complete",
        error: null,
        result: isError ? "reported_error" : "reported_result",
        counts: { requests: 2, inference: 2, countTokens: 0, probes: 0 },
        closed: false,
      });
      expect(JSON.stringify(complete)).not.toContain(PRIVATE_TEXT);
      expect(JSON.stringify(complete)).not.toContain(instance.headers["x-api-key"]);
      await instance.close();
      await instance.close();
      expect(instance.snapshot()).toEqual({ ...complete, closed: true });
    },
  );

  it("accepts text-block user inputs and result text blocks when their initial framing is unchanged", async () => {
    const instance = await fixture();
    const first = {
      ...firstRequest(),
      messages: [{ role: "user", content: [{ type: "text", text: PRIVATE_TEXT }] }],
    };
    const second = secondRequest();
    second.messages[0] = first.messages[0];
    second.messages[2].content[0].content = [{ type: "text", text: PRIVATE_TEXT }];
    successful(await send(instance, first));
    successful(await send(instance, second));
    expect(instance.snapshot().state).toBe("complete");
  });

  it("allows only the documented beta query on both POST endpoints", async () => {
    const instance = await fixture();
    successful(
      await send(instance, firstRequest(), { path: "/v1/messages/count_tokens?beta=true" }),
    );
    events(await send(instance, firstRequest(), { path: "/v1/messages?beta=true" }));
    events(await send(instance, secondRequest(), { path: "/v1/messages?beta=true" }));
    expect(instance.snapshot()).toMatchObject({
      state: "complete",
      counts: { inference: 2, countTokens: 1 },
    });
  });

  it("counts tokens synthetically without requiring inference fields or advancing the sequence", async () => {
    const instance = await fixture();
    const body = { model: FIXTURE_MODEL, messages: firstRequest().messages };
    const first = successful(await send(instance, body, { path: "/v1/messages/count_tokens" }));
    expect(JSON.parse(first.body)).toEqual({ input_tokens: expect.any(Number) });
    expect(JSON.parse(first.body).input_tokens).toBeGreaterThanOrEqual(0);
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { inference: 0, countTokens: 1 },
    });
    successful(await send(instance));
    const second = successful(await send(instance, body, { path: "/v1/messages/count_tokens" }));
    expect(second.body).toBe(first.body);
    expect(instance.snapshot().state).toBe("awaiting_result");
    successful(await send(instance, secondRequest()));
    expect(instance.snapshot().state).toBe("complete");
  });

  it("counts a structurally valid result transcript without advancing inference or interpreting extra fields", async () => {
    const instance = await fixture();
    const body = { ...secondRequest(), stream: false, max_tokens: 0, tools: "not interpreted" };
    successful(await send(instance, body, { path: "/v1/messages/count_tokens" }));
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      result: "unobserved",
      counts: { inference: 0, countTokens: 1 },
    });
    successful(await send(instance));
    successful(await send(instance, body, { path: "/v1/messages/count_tokens" }));
    expect(instance.snapshot()).toMatchObject({ state: "awaiting_result", result: "unobserved" });
  });

  it("provides an empty bounded HEAD probe without advancing inference", async () => {
    const instance = await fixture();
    const response = successful(
      await send(instance, undefined, { path: "/api/hello", method: "HEAD", raw: "" }),
    );
    expect(response.body).toBe("");
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { inference: 0, probes: 1 },
    });
  });

  it("allows the credential-free HEAD probe but never a body", async () => {
    const instance = await fixture();
    successful(
      await send(instance, undefined, {
        path: "/api/hello",
        method: "HEAD",
        raw: "",
        headers: { "x-api-key": undefined, "anthropic-version": undefined },
      }),
    );
    rejected(
      instance,
      await send(instance, undefined, {
        path: "/api/hello",
        method: "HEAD",
        raw: "x",
        headers: { "content-length": "1" },
      }),
    );
  });

  it("does not expose mutable internal snapshot state", async () => {
    const instance = await fixture();
    const snapshot = instance.snapshot();
    expect(() => {
      snapshot.state = "complete";
    }).toThrow(TypeError);
    expect(() => {
      snapshot.counts.inference = 99;
    }).toThrow(TypeError);
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { inference: 0 },
    });
  });
});

describe("Claude Messages fixture hostile request boundary", () => {
  it.each([
    ["different model", { model: "not-the-fixture-model" }],
    ["non-streaming", { stream: false }],
    ["omitted streaming", { stream: undefined }],
    ["zero token budget", { max_tokens: 0 }],
    ["fractional token budget", { max_tokens: 1.5 }],
    ["excessive token budget", { max_tokens: 1_000_001 }],
    ["string token budget", { max_tokens: "128" }],
    ["missing tools", { tools: undefined }],
    ["empty inventory", { tools: [] }],
    ["extra tool", { tools: [...firstRequest().tools, ...firstRequest().tools] }],
    ["different tool", { tools: [{ ...firstRequest().tools[0], name: "Execute" }] }],
    ["array input schema", { tools: [{ name: "Bash", input_schema: { type: "array" } }] }],
    [
      "non-string command schema",
      {
        tools: [
          {
            name: "Bash",
            input_schema: { type: "object", properties: { command: { type: "number" } } },
          },
        ],
      },
    ],
    ["no messages", { messages: [] }],
    ["assistant first", { messages: [{ role: "assistant", content: PRIVATE_TEXT }] }],
    [
      "extra initial message",
      { messages: [...firstRequest().messages, ...firstRequest().messages] },
    ],
    ["initial result", { messages: [secondRequest().messages[2]] }],
    [
      "non-text user block",
      { messages: [{ role: "user", content: [{ type: "image", source: PRIVATE_TEXT }] }] },
    ],
  ])("rejects %s and cannot recover to a successful exchange", async (_name, mutation) => {
    const instance = await fixture();
    rejected(instance, await send(instance, { ...firstRequest(), ...mutation }));
    const failure = instance.snapshot().error;
    rejected(instance, await send(instance));
    expect(instance.snapshot().error).toBe(failure);
  });

  it.each([
    "/other",
    "/v1/messages?beta=false",
    "/v1/messages?beta=true&beta=true",
    "/v1/messages?unexpected=true",
    "/v1/messages/",
    "/v1/messages/count_tokens?beta=false",
    "/api/hello?beta=true",
  ])("rejects unexpected route/query %s", async (path) => {
    const instance = await fixture();
    rejected(instance, await send(instance, firstRequest(), { path }));
  });

  it.each(["GET", "PUT", "OPTIONS", "PATCH"])("rejects unexpected method %s", async (method) => {
    const instance = await fixture();
    rejected(instance, await send(instance, firstRequest(), { method }));
  });

  it.each([
    ["missing capability", { "x-api-key": undefined }],
    ["wrong capability", { "x-api-key": "fixture-wrong-capability" }],
    [
      "duplicate capability",
      { "x-api-key": ["fixture-wrong-capability", "fixture-wrong-capability"] },
    ],
    ["missing version", { "anthropic-version": undefined }],
    ["wrong version", { "anthropic-version": "1999-01-01" }],
    ["authorization", { authorization: "Bearer fixture-not-a-credential" }],
    ["browser origin", { origin: "https://fixture.invalid" }],
    ["gzip encoding", { "content-encoding": "gzip" }],
    ["identity encoding", { "content-encoding": "identity" }],
    ["wrong content type", { "content-type": "text/plain" }],
    ["missing content type", { "content-type": undefined }],
    ["foreign host", { host: "fixture.invalid" }],
    ["continue expectation", { expect: "100-continue" }],
    ["unknown expectation", { expect: "other-expectation" }],
    ["compressed transfer coding", { "transfer-encoding": "gzip, chunked" }],
    ["declared trailers", { trailer: "x-fixture-extra" }],
  ])("rejects %s without echoing credentials or input", async (_name, headers) => {
    const instance = await fixture();
    const response = await send(instance, firstRequest(), { headers });
    rejected(instance, response);
  });

  it.each(["", "{", "null", "[]", "true", '{"messages":'])(
    "rejects malformed or non-object JSON %s",
    async (raw) => {
      const instance = await fixture();
      rejected(instance, await send(instance, undefined, { raw }));
    },
  );

  it("rejects malformed UTF-8 rather than accepting replacement characters", async () => {
    const instance = await fixture();
    const valid = JSON.stringify(firstRequest());
    const [prefix, suffix] = valid.split(PRIVATE_TEXT);
    const raw = Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xc3, 0x28]),
      Buffer.from(suffix),
    ]);
    rejected(instance, await send(instance, undefined, { raw }));
  });

  it("rejects a UTF-8 byte-order mark instead of silently stripping it", async () => {
    const instance = await fixture();
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(firstRequest())),
    ]);
    rejected(instance, await send(instance, undefined, { raw }));
  });

  it("accepts ordinary chunked request framing", async () => {
    const instance = await fixture();
    successful(
      await send(instance, firstRequest(), { headers: { "transfer-encoding": "chunked" } }),
    );
    expect(instance.snapshot().state).toBe("awaiting_result");
  });

  it("rejects oversized chunked input even without a declared length", async () => {
    const instance = await fixture({ maxBodyBytes: 64 });
    rejected(
      instance,
      await send(instance, firstRequest(), { headers: { "transfer-encoding": "chunked" } }),
    );
  });

  it("rejects actual chunked trailers even without a Trailer declaration", async () => {
    const instance = await fixture();
    rejected(
      instance,
      await send(instance, firstRequest(), {
        headers: { "transfer-encoding": "chunked" },
        trailers: { "x-fixture-trailer": PRIVATE_TEXT },
      }),
    );
  });

  it("rejects excessive individual header bytes before processing any message", async () => {
    const instance = await fixture();
    rejected(
      instance,
      await send(instance, firstRequest(), { headers: { "x-fixture-padding": "x".repeat(8_193) } }),
    );
  });

  it("rejects excess header count instead of validating a silently truncated inventory", async () => {
    const instance = await fixture();
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`x-fixture-${index}`, "x"]),
    );
    const response = await send(instance, firstRequest(), { headers });
    rejected(instance, response);
  });

  it("rejects bodies above the configured byte budget", async () => {
    const instance = await fixture({ maxBodyBytes: 64 });
    rejected(instance, await send(instance));
  });

  it("accepts an exact body-size boundary", async () => {
    const raw = JSON.stringify(firstRequest());
    const instance = await fixture({ maxBodyBytes: Buffer.byteLength(raw) });
    successful(await send(instance, undefined, { raw }));
    expect(instance.snapshot().state).toBe("awaiting_result");
  });

  it("does not retain or echo bounded ancillary request fields", async () => {
    const instance = await fixture();
    const body = { ...firstRequest(), system: PRIVATE_TEXT, metadata: { user_id: PRIVATE_TEXT } };
    const response = successful(await send(instance, body));
    expect(response.body).not.toContain(PRIVATE_TEXT);
    expect(JSON.stringify(instance.snapshot())).not.toContain(PRIVATE_TEXT);
  });

  it.each([
    ["oversized string", "x".repeat(16_385)],
    ["too many blocks", Array.from({ length: 9 }, () => ({ type: "text", text: "x" }))],
    ["oversized block", [{ type: "text", text: "x".repeat(2_049) }]],
    ["empty blocks", []],
  ])("rejects %s in initial user content", async (_name, content) => {
    const instance = await fixture();
    rejected(
      instance,
      await send(instance, { ...firstRequest(), messages: [{ role: "user", content }] }),
    );
  });

  it.each([
    "x".repeat(16_384),
    Array.from({ length: 8 }, () => ({ type: "text", text: "x".repeat(2_048) })),
  ])("accepts the exact documented initial text-content boundary", async (content) => {
    const instance = await fixture();
    successful(await send(instance, { ...firstRequest(), messages: [{ role: "user", content }] }));
    expect(instance.snapshot().state).toBe("awaiting_result");
  });
});

describe("Claude Messages fixture conversation binding", () => {
  it("rejects a result before issuing its fixed tool call", async () => {
    const instance = await fixture();
    rejected(instance, await send(instance, secondRequest()));
  });

  it.each([
    [
      "replayed initial",
      (body) => {
        body.messages = firstRequest().messages;
      },
    ],
    [
      "changed initial",
      (body) => {
        body.messages[0].content = "different initial message";
      },
    ],
    [
      "missing assistant",
      (body) => {
        body.messages.splice(1, 1);
      },
    ],
    [
      "reordered assistant and result",
      (body) => {
        body.messages.reverse();
      },
    ],
    [
      "extra turn",
      (body) => {
        body.messages.push(firstRequest().messages[0]);
      },
    ],
    [
      "different call id",
      (body) => {
        body.messages[1].content[0].id = "toolu_other";
      },
    ],
    [
      "different result id",
      (body) => {
        body.messages[2].content[0].tool_use_id = "toolu_other";
      },
    ],
    [
      "different command",
      (body) => {
        body.messages[1].content[0].input.command = "echo changed";
      },
    ],
    [
      "extra call input",
      (body) => {
        body.messages[1].content[0].input.extra = "unexpected";
      },
    ],
    [
      "different tool name",
      (body) => {
        body.messages[1].content[0].name = "Execute";
      },
    ],
    [
      "duplicate tool call",
      (body) => {
        body.messages[1].content.push(body.messages[1].content[0]);
      },
    ],
    [
      "duplicate result",
      (body) => {
        body.messages[2].content.push(body.messages[2].content[0]);
      },
    ],
    [
      "result boolean as string",
      (body) => {
        body.messages[2].content[0].is_error = "false";
      },
    ],
    [
      "non-text result",
      (body) => {
        body.messages[2].content[0].content = [{ type: "image", source: PRIVATE_TEXT }];
      },
    ],
  ])("rejects %s after a valid first request", async (_name, mutate) => {
    const instance = await fixture();
    successful(await send(instance));
    const body = secondRequest();
    mutate(body);
    rejected(instance, await send(instance, body));
    expect(instance.snapshot().result).toBe("unobserved");
  });

  it("invalidates a completed exchange when extra inference arrives", async () => {
    const instance = await fixture();
    successful(await send(instance));
    successful(await send(instance, secondRequest()));
    rejected(instance, await send(instance, secondRequest()));
    const failed = instance.snapshot();
    await instance.close();
    expect(instance.snapshot()).toEqual({ ...failed, closed: true });
  });

  it("validates token-request model and message framing", async () => {
    const instance = await fixture();
    rejected(
      instance,
      await send(
        instance,
        { model: FIXTURE_MODEL, messages: secondRequest().messages.slice(1) },
        { path: "/v1/messages/count_tokens" },
      ),
    );
  });
});

describe("Claude Messages fixture resource and lifecycle budgets", () => {
  it.each([
    { maxBodyBytes: 0 },
    { maxBodyBytes: 262_145 },
    { maxBodyBytes: 1.5 },
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 5_001 },
    { lifetimeMs: 0 },
    { lifetimeMs: 30_001 },
    { lifetimeMs: Number.NaN },
    { unknownOption: true },
  ])("rejects invalid fixture options %j before opening a listener", async (options) => {
    await expect(startClaudeMessagesFixture(options)).rejects.toThrow();
  });

  it("rejects the fifth token count independently of inference", async () => {
    const instance = await fixture();
    for (let count = 0; count < 4; count += 1) {
      successful(await send(instance, firstRequest(), { path: "/v1/messages/count_tokens" }));
    }
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { countTokens: 4, inference: 0 },
    });
    rejected(instance, await send(instance, firstRequest(), { path: "/v1/messages/count_tokens" }));
  });

  it("rejects the third probe independently of inference", async () => {
    const instance = await fixture();
    for (let count = 0; count < 2; count += 1) {
      successful(await send(instance, undefined, { method: "HEAD", path: "/api/hello", raw: "" }));
    }
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { probes: 2, inference: 0 },
    });
    rejected(
      instance,
      await send(instance, undefined, { method: "HEAD", path: "/api/hello", raw: "" }),
    );
  });

  it("supports exactly the total eight-request budget and rejects a ninth request", async () => {
    const instance = await fixture();
    for (let count = 0; count < 2; count += 1) {
      successful(await send(instance, undefined, { method: "HEAD", path: "/api/hello", raw: "" }));
    }
    for (let count = 0; count < 4; count += 1) {
      successful(await send(instance, firstRequest(), { path: "/v1/messages/count_tokens" }));
    }
    successful(await send(instance));
    successful(await send(instance, secondRequest()));
    expect(instance.snapshot()).toMatchObject({ state: "complete", counts: { requests: 8 } });
    rejected(instance, await send(instance, firstRequest(), { path: "/v1/messages/count_tokens" }));
  });

  it("fails boundedly on a stalled request body", async () => {
    const instance = await fixture({ requestTimeoutMs: 100 });
    const connection = await socket(instance);
    connection.write(incompletePost(instance));
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"), { timeout: 2_000 });
    expect(instance.snapshot().error).toMatch(/timeout|transport_error/u);
    expect(instance.snapshot().result).toBe("unobserved");
  });

  it("fails when a partially transmitted body disconnects", async () => {
    const instance = await fixture();
    const connection = await socket(instance);
    connection.write(incompletePost(instance));
    await vi.waitFor(() => expect(instance.snapshot().counts.requests).toBe(1));
    connection.destroy();
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"));
    expect(instance.snapshot().result).toBe("unobserved");
  });

  it("cannot advance while another request is incomplete", async () => {
    const instance = await fixture();
    const connection = await socket(instance);
    connection.write(incompletePost(instance));
    await vi.waitFor(() => expect(instance.snapshot().counts.requests).toBe(1));
    rejected(instance, await send(instance));
    connection.destroy();
    expect(instance.snapshot().state).toBe("failed");
  });

  it("bounds simultaneous connections even before a complete HTTP header arrives", async () => {
    const instance = await fixture();
    for (let count = 0; count < 4; count += 1) await socket(instance);
    await vi.waitFor(() => expect(instance.snapshot().counts.connections).toBe(4));
    expect(instance.snapshot().state).toBe("awaiting_request");
    await socket(instance);
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"));
  });

  it("expires connections that never provide a complete HTTP request", async () => {
    const instance = await fixture({ requestTimeoutMs: 100 });
    await socket(instance);
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"), { timeout: 2_000 });
    expect(instance.snapshot().error).toMatch(/timeout|transport_error/u);
    expect(instance.snapshot().counts.requests).toBe(0);
  });

  it.each([
    ["HTTP upgrade", "GET /v1/messages HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"],
    ["CONNECT tunnel", "CONNECT fixture.invalid:443 HTTP/1.1\r\n"],
    ["malformed headers", "POST /v1/messages HTTP/1.1\r\ninvalid header\r\n"],
  ])("rejects %s at the transport boundary", async (_name, prefix) => {
    const instance = await fixture();
    const connection = await socket(instance);
    connection.write(`${prefix}Host: ${new URL(instance.origin).host}\r\n\r\n`);
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"));
    expect(instance.snapshot().result).toBe("unobserved");
    rejected(instance, await send(instance));
  });

  it("bounds cumulative connections independently of concurrent and request budgets", async () => {
    const instance = await fixture();
    for (let count = 0; count < 16; count += 1) {
      const connection = await socket(instance);
      await vi.waitFor(() => expect(instance.snapshot().counts.connections).toBe(count + 1));
      const closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
      connection.end();
      await closed;
    }
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { requests: 0, connections: 16 },
    });
    await socket(instance);
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"));
  });

  it("expires idle fixtures rather than leaving an unbounded listener", async () => {
    const instance = await fixture({ lifetimeMs: 100 });
    await vi.waitFor(() => expect(instance.snapshot().closed).toBe(true), { timeout: 2_000 });
    expect(instance.snapshot()).toMatchObject({ state: "failed", result: "unobserved" });
    expect(instance.snapshot().error).toMatch(/lifetime|timeout/u);
  });

  it.each([false, true])(
    "closes a pending exchange with partialBody=%s and retains the reason",
    async (partialBody) => {
      const instance = await fixture();
      if (partialBody) {
        const connection = await socket(instance);
        connection.write(incompletePost(instance));
        await vi.waitFor(() => expect(instance.snapshot().counts.requests).toBe(1));
      } else {
        successful(await send(instance));
      }
      await instance.close();
      expect(instance.snapshot()).toMatchObject({
        state: "failed",
        error: "closed_before_complete",
        closed: true,
      });
      const snapshot = instance.snapshot();
      await instance.close();
      expect(instance.snapshot()).toEqual(snapshot);
    },
  );
});

describe("Claude Messages fixture Node failure containment", () => {
  it("redacts listener startup errors before any fixture is returned", async () => {
    httpFault.mode = "listen_error";
    await expect(startClaudeMessagesFixture()).rejects.toThrow(/^listen_failed$/u);
    expect(httpFault.server?.listening).toBe(false);
  });

  it("closes the actual listener after a post-listen server error without retaining its details", async () => {
    const instance = await fixture();
    httpFault.server?.emit("error", new Error(PRIVATE_TEXT));
    await vi.waitFor(() => expect(instance.snapshot().closed).toBe(true));
    expect(instance.snapshot()).toMatchObject({ state: "failed", error: "server_error" });
    expect(JSON.stringify(instance.snapshot())).not.toContain(PRIVATE_TEXT);
    expect(httpFault.server?.listening).toBe(false);
  });

  it("fails closed on a response transport error while a real request is pending", async () => {
    const instance = await fixture();
    httpFault.server?.once("request", (_incoming, response) =>
      response.emit("error", new Error(PRIVATE_TEXT)),
    );
    rejected(instance, await send(instance));
    expect(instance.snapshot().error).toBe("transport_error");
  });

  it("fails closed on an accepted socket error without including diagnostic details", async () => {
    const instance = await fixture();
    httpFault.server?.once("connection", (connection) =>
      connection.emit("error", new Error(PRIVATE_TEXT)),
    );
    await socket(instance);
    await vi.waitFor(() => expect(instance.snapshot().state).toBe("failed"));
    expect(instance.snapshot().error).toBe("transport_error");
    expect(JSON.stringify(instance.snapshot())).not.toContain(PRIVATE_TEXT);
  });

  it.each([
    ["close_error", "close_failed"],
    ["close_timeout", "close_timeout"],
  ] as const)("reports %s rather than claiming unconfirmed closure", async (mode, error) => {
    httpFault.mode = mode;
    const instance = await fixture();
    // The wrapper still closes the real listener; only its confirmation is failed or withheld.
    fixtures.splice(fixtures.indexOf(instance), 1);
    successful(await send(instance));
    successful(await send(instance, secondRequest()));
    await expect(instance.close()).rejects.toThrow(new RegExp(`^${error}$`, "u"));
    expect(instance.snapshot()).toMatchObject({
      state: "failed",
      error,
      closed: false,
      result: "unobserved",
    });
    expect(httpFault.server?.listening).toBe(false);
    await expect(instance.close()).rejects.toThrow(new RegExp(`^${error}$`, "u"));
    expect(JSON.stringify(instance.snapshot())).not.toContain(PRIVATE_TEXT);
  });
});

describe("Claude Messages fixture closed marker scenario", () => {
  function markerResult(isError?: boolean) {
    const body = secondRequest(isError);
    body.messages[1].content[0].input.command = FIXTURE_MARKER_COMMAND;
    return body;
  }

  it.each([
    { scenario: undefined },
    { scenario: null },
    { scenario: true },
    { scenario: 0 },
    { scenario: "" },
    { scenario: "Marker" },
    { scenario: "MARKER" },
    { scenario: "echo " },
    { scenario: " marker" },
    { scenario: "marker\n" },
    { scenario: "/opt/agenthawk/fixture-marker" },
    { scenario: ["marker"] },
    { scenario: { command: FIXTURE_MARKER_COMMAND } },
    { scenario: "marker", command: FIXTURE_COMMAND },
    { scenario: "marker", path: "/other/fixture-marker" },
    { scenario: "marker", executable: "/other/fixture-marker" },
  ])(
    "rejects non-enum scenarios and caller command/path options %j before listening",
    async (options) => {
      await expect(startClaudeMessagesFixture(options)).rejects.toThrow(/^options_invalid$/u);
      expect(httpFault.server).toBeUndefined();
    },
  );

  it("keeps the explicit echo scenario byte-identical to the omitted default", async () => {
    const omitted = await fixture();
    const explicit = await fixture({ scenario: "echo" });
    const omittedFirst = successful(await send(omitted));
    const explicitFirst = successful(await send(explicit));
    expect(explicitFirst).toEqual(omittedFirst);
    expect(successful(await send(explicit, secondRequest()))).toEqual(
      successful(await send(omitted, secondRequest())),
    );
    expect(explicit.snapshot()).toEqual(omitted.snapshot());
  });

  it("does not accept inherited scenario selection", async () => {
    const instance = await fixture(Object.create({ scenario: "marker" }));
    const initialEvents = events(await send(instance));
    expect(JSON.parse(initialEvents[2].data.delta.partial_json)).toEqual({
      command: FIXTURE_COMMAND,
    });
    successful(await send(instance, secondRequest()));
    expect(instance.snapshot().state).toBe("complete");
  });

  it.each([undefined, false, true])(
    "emits only the fixed marker helper and records is_error=%s as a client assertion",
    async (isError) => {
      const instance = await fixture({ scenario: "marker" });
      expect(FIXTURE_MARKER_COMMAND).toBe("/opt/agenthawk/fixture-marker");
      const initialEvents = events(await send(instance));
      expect(initialEvents.map(({ event }) => event)).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(initialEvents[1].data).toMatchObject({
        index: 0,
        content_block: { type: "tool_use", id: FIXTURE_TOOL_ID, name: "Bash", input: {} },
      });
      expect(initialEvents[2].data).toMatchObject({
        index: 0,
        delta: { type: "input_json_delta" },
      });
      expect(JSON.parse(initialEvents[2].data.delta.partial_json)).toEqual({
        command: FIXTURE_MARKER_COMMAND,
      });
      expect(JSON.stringify(initialEvents)).not.toContain(FIXTURE_COMMAND);
      const finalEvents = events(await send(instance, markerResult(isError)));
      expect(finalEvents[4].data.delta).toMatchObject({ stop_reason: "end_turn" });
      expect(JSON.stringify(finalEvents)).not.toMatch(
        /executed|activated|approved|denied|protected/iu,
      );
      expect(instance.snapshot()).toMatchObject({
        state: "complete",
        error: null,
        result: isError ? "reported_error" : "reported_result",
        counts: { requests: 2, inference: 2, countTokens: 0, probes: 0 },
      });
      expect(JSON.stringify(instance.snapshot())).not.toContain(FIXTURE_MARKER_COMMAND);
      await instance.close();
      expect(instance.snapshot()).toMatchObject({ state: "complete", closed: true });
    },
  );

  it("does not let request fields override the selected fixed scenario", async () => {
    const instance = await fixture({ scenario: "marker" });
    const initialEvents = events(
      await send(instance, {
        ...firstRequest(),
        scenario: "echo",
        command: "echo different",
        path: "/other/fixture-marker",
      }),
    );
    expect(JSON.parse(initialEvents[2].data.delta.partial_json)).toEqual({
      command: FIXTURE_MARKER_COMMAND,
    });
    successful(await send(instance, markerResult()));
    expect(instance.snapshot().state).toBe("complete");
  });

  it("validates matching marker token transcripts before and after issuing the fixed call without advancing", async () => {
    const instance = await fixture({ scenario: "marker" });
    const path = "/v1/messages/count_tokens?beta=true";
    successful(await send(instance, firstRequest(), { path }));
    const before = successful(await send(instance, markerResult(), { path }));
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_request",
      counts: { inference: 0, countTokens: 2 },
    });
    successful(await send(instance));
    const after = successful(await send(instance, markerResult(true), { path }));
    expect(after).toEqual(before);
    expect(instance.snapshot()).toMatchObject({
      state: "awaiting_result",
      result: "unobserved",
      counts: { inference: 1, countTokens: 3 },
    });
    successful(await send(instance, markerResult()));
    expect(instance.snapshot()).toMatchObject({ state: "complete", result: "reported_result" });
  });

  it.each([
    ["echo", "/v1/messages", true],
    ["marker", "/v1/messages", true],
    ["echo", "/v1/messages/count_tokens", false],
    ["marker", "/v1/messages/count_tokens", false],
    ["echo", "/v1/messages/count_tokens?beta=true", true],
    ["marker", "/v1/messages/count_tokens?beta=true", true],
  ] as const)(
    "rejects cross-scenario transcript for %s at %s with issuedCall=%s",
    async (scenario, path, issuedCall) => {
      const instance = await fixture({ scenario });
      if (issuedCall) successful(await send(instance));
      const mismatch = scenario === "marker" ? secondRequest() : markerResult();
      rejected(instance, await send(instance, mismatch, { path }));
      expect(instance.snapshot().result).toBe("unobserved");
      const correct = scenario === "marker" ? markerResult() : secondRequest();
      rejected(instance, await send(instance, correct));
    },
  );

  it.each([
    "/opt/agenthawk/fixture-marker ",
    "/opt/agenthawk/fixture-marker extra",
    "/opt/agenthawk/fixture-marker\n",
    "/opt/agenthawk/./fixture-marker",
    "fixture-marker",
  ])(
    "rejects marker command mutation %j instead of normalizing or executing it",
    async (command) => {
      const instance = await fixture({ scenario: "marker" });
      successful(await send(instance));
      const body = markerResult();
      body.messages[1].content[0].input.command = command;
      rejected(instance, await send(instance, body));
    },
  );

  it("retains the existing strict body budget for marker scenarios", async () => {
    const instance = await fixture({ scenario: "marker", maxBodyBytes: 64 });
    rejected(instance, await send(instance));
    expect(instance.snapshot().error).toBe("body_limit");
  });

  it("retains strict two-inference completion and replay limits for marker scenarios", async () => {
    const instance = await fixture({ scenario: "marker" });
    successful(await send(instance));
    successful(await send(instance, markerResult()));
    rejected(instance, await send(instance, markerResult()));
    expect(instance.snapshot().result).toBe("unobserved");
  });
});
