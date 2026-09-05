import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const FIXTURE_MODEL = "claude-sonnet-4-6";
export const FIXTURE_COMMAND = "echo agenthawk-fixture-neutral";
export const FIXTURE_TOOL_ID = "toolu_agenthawk_fixture_1";

const LIMITS = Object.freeze({
  maxBodyBytes: 262_144,
  requestTimeoutMs: 5_000,
  lifetimeMs: 30_000,
});
const REJECTION =
  '{"error":{"type":"invalid_request_error","message":"AgentHawk fixture rejected request."}}';

class FixtureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function requireFixture(condition, code = "request_invalid") {
  if (!condition) throw new FixtureError(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    record(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function textContent(value) {
  if (typeof value === "string") return value.length <= 16_384;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(
      (block) =>
        record(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length <= 2_048,
    )
  );
}

function userMessage(value) {
  return record(value) && value.role === "user" && textContent(value.content);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateEnvelope(body, inference) {
  requireFixture(record(body) && body.model === FIXTURE_MODEL);
  requireFixture(
    Array.isArray(body.messages) && body.messages.length >= 1 && body.messages.length <= 3,
  );
  requireFixture(
    body.messages.every(
      (message) =>
        record(message) &&
        ["user", "assistant"].includes(message.role) &&
        (typeof message.content === "string" || Array.isArray(message.content)),
    ),
  );
  if (!inference) {
    requireFixture(userMessage(body.messages[0]), "initial_message_invalid");
    if (body.messages.length !== 1) validateResult(body.messages, digest(body.messages[0]));
    return;
  }
  requireFixture(
    body.stream === true &&
      Number.isSafeInteger(body.max_tokens) &&
      body.max_tokens > 0 &&
      body.max_tokens <= 1_000_000,
  );
  requireFixture(Array.isArray(body.tools) && body.tools.length === 1, "tool_inventory_invalid");
  const tool = body.tools[0];
  requireFixture(
    record(tool) &&
      tool.name === "Bash" &&
      record(tool.input_schema) &&
      tool.input_schema.type === "object" &&
      record(tool.input_schema.properties) &&
      record(tool.input_schema.properties.command) &&
      tool.input_schema.properties.command.type === "string",
    "tool_inventory_invalid",
  );
}

function validateResult(messages, initialDigest) {
  requireFixture(
    messages.length === 3 && digest(messages[0]) === initialDigest,
    "tool_result_invalid",
  );
  const assistant = messages[1];
  requireFixture(
    assistant.role === "assistant" &&
      Array.isArray(assistant.content) &&
      assistant.content.length === 1,
    "tool_result_invalid",
  );
  const call = assistant.content[0];
  requireFixture(
    exactKeys(call, ["type", "id", "name", "input"]) &&
      call.type === "tool_use" &&
      call.id === FIXTURE_TOOL_ID &&
      call.name === "Bash" &&
      exactKeys(call.input, ["command"]) &&
      call.input.command === FIXTURE_COMMAND,
    "tool_result_invalid",
  );
  const user = messages[2];
  requireFixture(
    user.role === "user" && Array.isArray(user.content) && user.content.length === 1,
    "tool_result_invalid",
  );
  const result = user.content[0];
  requireFixture(record(result), "tool_result_invalid");
  const keys = ["type", "tool_use_id", "content"];
  if (Object.hasOwn(result, "is_error")) keys.push("is_error");
  requireFixture(
    exactKeys(result, keys) &&
      result.type === "tool_result" &&
      result.tool_use_id === FIXTURE_TOOL_ID &&
      textContent(result.content) &&
      (result.is_error === undefined || typeof result.is_error === "boolean"),
    "tool_result_invalid",
  );
  return result.is_error === true ? "reported_error" : "reported_result";
}

function streamResponse(toolCall) {
  const block = toolCall
    ? { type: "tool_use", id: FIXTURE_TOOL_ID, name: "Bash", input: {} }
    : { type: "text", text: "" };
  const delta = toolCall
    ? { type: "input_json_delta", partial_json: JSON.stringify({ command: FIXTURE_COMMAND }) }
    : { type: "text_delta", text: "AgentHawk fixture exchange complete." };
  const events = [
    {
      type: "message_start",
      message: {
        id: toolCall ? "msg_agenthawk_fixture_1" : "msg_agenthawk_fixture_2",
        type: "message",
        role: "assistant",
        model: FIXTURE_MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function readBody(request, maximumBytes) {
  const length = request.headers["content-length"];
  requireFixture(
    length === undefined || (/^\d+$/u.test(length) && Number(length) <= maximumBytes),
    "body_limit",
  );
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    requireFixture(total <= maximumBytes, "body_limit");
    chunks.push(chunk);
  }
  requireFixture(request.rawTrailers.length === 0);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, total),
    );
    return JSON.parse(text);
  } catch {
    throw new FixtureError("body_invalid");
  }
}

/** Development fixture only: a completed exchange is not host or execution evidence. */
export async function startClaudeMessagesFixture(options = {}) {
  requireFixture(
    record(options) && Object.keys(options).every((key) => Object.hasOwn(LIMITS, key)),
    "options_invalid",
  );
  const limits = { ...LIMITS, ...options };
  requireFixture(
    Object.entries(limits).every(
      ([key, value]) => Number.isSafeInteger(value) && value >= 1 && value <= LIMITS[key],
    ),
    "options_invalid",
  );
  const capability = randomBytes(32).toString("hex");
  const counts = { requests: 0, inference: 0, countTokens: 0, probes: 0, connections: 0 };
  let state = "awaiting_request";
  let error = null;
  let result = "unobserved";
  let initialDigest;
  let busy = false;
  let closed = false;
  let closing;
  let lifetime;
  let origin;
  const sockets = new Set();
  const fail = (code) => {
    if (state !== "failed") error = code;
    state = "failed";
    result = "unobserved";
  };
  const increment = (key, maximum) => {
    counts[key] = Math.min(counts[key] + 1, maximum + 1);
    requireFixture(counts[key] <= maximum, "request_limit");
  };
  const server = createServer(
    {
      maxHeaderSize: 8_192,
      headersTimeout: limits.requestTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      connectionsCheckingInterval: 50,
    },
    (request, response) => {
      let inference = false;
      let reserved = false;
      const timer = setTimeout(() => {
        fail("request_timeout");
        request.destroy();
      }, limits.requestTimeoutMs);
      timer.unref();
      response.once("close", () => {
        clearTimeout(timer);
        if (!response.writableFinished && !closed) fail("transport_error");
      });
      response.once("error", () => fail("transport_error"));
      response.setHeader("connection", "close");
      response.setHeader("cache-control", "no-store");
      const handle = async () => {
        increment("requests", 8);
        requireFixture(state !== "failed" && state !== "complete", "phase_invalid");
        requireFixture(
          request.rawHeaders.length <= 64 &&
            Object.values(request.headersDistinct).every((values) => values.length === 1),
        );
        requireFixture(
          request.headers.host === origin.slice("http://".length) &&
            request.headers.origin === undefined &&
            request.headers.authorization === undefined &&
            request.headers["content-encoding"] === undefined &&
            request.headers.expect === undefined &&
            [undefined, "chunked"].includes(request.headers["transfer-encoding"]) &&
            request.headers.trailer === undefined,
        );
        if (request.method === "HEAD" && request.url === "/api/hello") {
          increment("probes", 2);
          requireFixture(
            request.headers["transfer-encoding"] === undefined &&
              [undefined, "0"].includes(request.headers["content-length"]),
          );
          requireFixture(
            request.headers["x-api-key"] === undefined ||
              request.headers["x-api-key"] === capability,
          );
          response.writeHead(200);
          response.end();
          return;
        }
        requireFixture(
          request.method === "POST" &&
            request.headers["x-api-key"] === capability &&
            request.headers["anthropic-version"] === "2023-06-01" &&
            request.headers["content-type"] === "application/json",
        );
        inference = ["/v1/messages", "/v1/messages?beta=true"].includes(request.url);
        const counting = [
          "/v1/messages/count_tokens",
          "/v1/messages/count_tokens?beta=true",
        ].includes(request.url);
        requireFixture(inference || counting);
        increment(inference ? "inference" : "countTokens", inference ? 2 : 4);
        if (inference) {
          requireFixture(!busy, "concurrent_inference");
          busy = true;
          reserved = true;
        }
        const body = await readBody(request, limits.maxBodyBytes);
        requireFixture(state !== "failed" && !closed, "phase_invalid");
        validateEnvelope(body, inference);
        if (counting) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"input_tokens":1}');
        } else {
          const first = state === "awaiting_request";
          if (first) {
            requireFixture(
              body.messages.length === 1 && userMessage(body.messages[0]),
              "initial_message_invalid",
            );
            initialDigest = digest(body.messages[0]);
            state = "awaiting_result";
          } else {
            requireFixture(state === "awaiting_result", "phase_invalid");
            result = validateResult(body.messages, initialDigest);
            state = "complete";
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(streamResponse(first));
        }
      };
      void handle()
        .catch((cause) => {
          fail(cause instanceof FixtureError ? cause.code : "transport_error");
          if (!response.destroyed && !response.headersSent) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(REJECTION);
            response.once("finish", () => request.destroy());
          }
        })
        .finally(() => {
          if (reserved) busy = false;
          clearTimeout(timer);
        });
    },
  );
  // Enforce the 32-header limit in the handler without native truncation/rejection
  // bypassing sticky failure. The parser still enforces the 8 KiB byte limit.
  server.maxHeadersCount = 0;
  const rejectExpectation = (request, response) => {
    counts.requests = Math.min(counts.requests + 1, 9);
    fail("request_invalid");
    response.on("error", () => fail("transport_error"));
    response.writeHead(400, { "content-type": "application/json", connection: "close" });
    response.once("finish", () => request.destroy());
    response.end(REJECTION);
  };
  server.on("checkContinue", rejectExpectation);
  server.on("checkExpectation", rejectExpectation);
  server.on("connection", (socket) => {
    counts.connections = Math.min(counts.connections + 1, 17);
    if (counts.connections > 16 || sockets.size >= 4) {
      fail("connection_limit");
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const timer = setTimeout(() => {
      fail("connection_timeout");
      socket.destroy();
    }, limits.requestTimeoutMs * 2);
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    socket.on("error", () => fail("transport_error"));
  });
  server.on("clientError", (_cause, socket) => {
    fail("transport_error");
    socket.destroy();
  });
  server.on("upgrade", (_request, socket) => {
    fail("request_invalid");
    socket.destroy();
  });
  server.on("connect", (_request, socket) => {
    fail("request_invalid");
    socket.destroy();
  });
  const close = () => {
    if (closing) return closing;
    if (state !== "complete" && state !== "failed") fail("closed_before_complete");
    clearTimeout(lifetime);
    closing = new Promise((resolveClose, rejectClose) => {
      const timer = setTimeout(() => {
        fail("close_timeout");
        rejectClose(new FixtureError("close_timeout"));
      }, 1_000);
      timer.unref();
      server.close((cause) => {
        clearTimeout(timer);
        if (cause) {
          fail("close_failed");
          rejectClose(new FixtureError("close_failed"));
        } else {
          closed = true;
          resolveClose();
        }
      });
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  };
  await new Promise((resolveListen, rejectListen) => {
    const onError = () => rejectListen(new FixtureError("listen_failed"));
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  server.on("error", () => {
    fail("server_error");
    void close().catch(() => {});
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  lifetime = setTimeout(() => {
    fail("lifetime_exceeded");
    void close().catch(() => {});
  }, limits.lifetimeMs);
  lifetime.unref();
  return Object.freeze({
    origin,
    headers: Object.freeze({ "x-api-key": capability, "anthropic-version": "2023-06-01" }),
    snapshot: () =>
      Object.freeze({ state, error, result, counts: Object.freeze({ ...counts }), closed }),
    close,
  });
}
