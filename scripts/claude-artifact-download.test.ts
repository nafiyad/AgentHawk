import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArtifactDownloader, downloadPinnedArtifact } from "./claude-artifact-download.mjs";

const MANIFEST = "https://downloads.claude.ai/claude-code-releases/2.1.241/manifest.json";
const BINARY = "https://downloads.claude.ai/claude-code-releases/2.1.241/linux-x64/claude";
const PRIVATE = "fixture-private-network-error-not-for-output";
const input = () => ({ url: MANIFEST, size: 3 });
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  closeEnabled = true;
  destroy = vi.fn(() => {
    if (!this.destroyed) {
      this.destroyed = true;
      if (this.closeEnabled) queueMicrotask(() => this.emit("close"));
    }
    return this;
  });
}

class FakeResponse extends PassThrough {
  statusCode: number | undefined = 200;
  rawHeaders: unknown = ["Content-Length", "3"];
  rawTrailers: unknown = [];
  complete = false;
  aborted = false;
}

function harness(start?: (fixture: ReturnType<typeof harness>) => void) {
  const socket = new FakeSocket();
  const response = new FakeResponse();
  const req = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    maxHeadersCount?: number;
  };
  let destroyed = false;
  let requestCloseEnabled = true;
  req.destroy = vi.fn(() => {
    if (!destroyed) {
      destroyed = true;
      if (requestCloseEnabled) queueMicrotask(() => req.emit("close"));
    }
    return req;
  });
  req.end = vi.fn(() => {
    queueMicrotask(() => {
      req.emit("socket", socket);
      if (start) start(fixture);
      else fixture.deliver();
    });
    return req;
  });
  const request = vi.fn((_options: RequestOptions) => req);
  const fixture = {
    socket,
    response,
    req,
    request,
    download: createArtifactDownloader(request),
    noRequestClose() {
      requestCloseEnabled = false;
    },
    deliver(bytes: Buffer = Buffer.from("abc")) {
      req.emit("response", response);
      response.complete = true;
      response.end(bytes);
    },
  };
  return fixture;
}

async function expectFailure(run: Promise<unknown>, code = "download_failed") {
  const error = await run.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(code);
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(PRIVATE);
}

afterEach(() => vi.useRealTimers());

describe("fixed Claude artifact HTTPS streaming", () => {
  it("exports the production downloader without creating a network request at import", () => {
    expect(typeof downloadPinnedArtifact).toBe("function");
  });

  it("streams bytes and confirms every assigned network object closed before success", async () => {
    const fixture = harness();
    const sink = vi.fn();
    await fixture.download(input(), sink, signal());
    expect(sink).toHaveBeenCalledExactlyOnceWith(Buffer.from("abc"));
    expect(fixture.req.destroy).toHaveBeenCalled();
    expect(fixture.socket.destroy).toHaveBeenCalled();
    expect(fixture.response.closed).toBe(true);
    expect(fixture.req.maxHeadersCount).toBe(0);
    const options = fixture.request.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "downloads.claude.ai",
      port: 443,
      path: "/claude-code-releases/2.1.241/manifest.json",
      method: "GET",
      rejectUnauthorized: true,
      maxHeaderSize: 8192,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      headers: {
        "accept-encoding": "identity",
        "user-agent": "AgentHawk-artifact-preparation/1",
        connection: "close",
      },
    });
    const agent = options?.agent as unknown as {
      options: Record<string, unknown>;
      maxSockets: number;
      maxTotalSockets: number;
    };
    expect(agent.options).toMatchObject({
      keepAlive: false,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
      proxyEnv: {},
    });
    expect(agent.maxSockets).toBe(1);
    expect(agent.maxTotalSockets).toBe(1);
    expect(Object.keys(options ?? {}).sort()).toEqual([
      "agent",
      "headers",
      "hostname",
      "insecureHTTPParser",
      "joinDuplicateHeaders",
      "maxHeaderSize",
      "method",
      "path",
      "port",
      "protocol",
      "rejectUnauthorized",
    ]);
  });

  it.each([
    "https://downloads.claude.ai/keys/claude-code.asc",
    MANIFEST,
    "https://downloads.claude.ai/claude-code-releases/2.1.241/manifest.json.sig",
    BINARY,
  ])("accepts only the fixed official path: %s", async (url) => {
    await harness().download({ url, size: 3 }, vi.fn(), signal());
  });

  it.each([
    undefined,
    null,
    false,
    3,
    "input",
    {},
    { url: MANIFEST },
    { url: MANIFEST, size: 0 },
    { url: MANIFEST, size: -1 },
    { url: MANIFEST, size: -0 },
    { url: MANIFEST, size: 1.5 },
    { url: MANIFEST, size: "3" },
    { url: MANIFEST, size: Number.NaN },
    { url: MANIFEST, size: Number.POSITIVE_INFINITY },
    { url: MANIFEST, size: 1924 },
    { url: BINARY, size: 342636849 },
    { url: MANIFEST, size: 3n },
  ])("rejects malformed policy without opening a request: %s", async (value) => {
    const fixture = harness();
    await expectFailure(fixture.download(value, vi.fn(), signal()), "download_invalid_input");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([
    MANIFEST.replace("https:", "http:"),
    MANIFEST.replace("downloads.claude.ai", "evil.test"),
    MANIFEST.replace("downloads.claude.ai", "downloads.claude.ai.evil.test"),
    MANIFEST.replace("downloads.claude.ai", "user:password@downloads.claude.ai"),
    MANIFEST.replace("downloads.claude.ai", "downloads.claude.ai:443"),
    `${MANIFEST}?download=true`,
    `${MANIFEST}#fragment`,
    `${MANIFEST}/`,
    MANIFEST.replace("2.1.241", "latest"),
    MANIFEST.replace("manifest.json", "../manifest.json"),
    MANIFEST.replace("manifest.json", "%6danifest.json"),
    new URL(MANIFEST),
  ])("rejects URL aliases or overrides: %s", async (url) => {
    const fixture = harness();
    await expectFailure(
      fixture.download({ url, size: 3 }, vi.fn(), signal()),
      "download_invalid_input",
    );
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("does not invoke getters and redacts hostile reflection failures", async () => {
    const getter = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    const fixture = harness();
    await expectFailure(
      fixture.download(
        {
          get url() {
            return getter();
          },
          size: 3,
        },
        vi.fn(),
        signal(),
      ),
      "download_invalid_input",
    );
    expect(getter).not.toHaveBeenCalled();
    const hostile = new Proxy({}, { getOwnPropertyDescriptor: getter });
    await expectFailure(fixture.download(hostile, vi.fn(), signal()), "download_invalid_input");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("detaches the trusted URL and size before asynchronous consumption", async () => {
    const value = input();
    const fixture = harness();
    const run = fixture.download(value, vi.fn(), signal());
    value.url = "https://evil.test/private";
    value.size = 99999;
    await run;
    expect(fixture.request.mock.calls[0]?.[0].path).toBe(
      "/claude-code-releases/2.1.241/manifest.json",
    );
  });

  it.each([undefined, null, 1, "sink", {}])("requires a callable sink: %j", async (sink) => {
    const fixture = harness();
    await expectFailure(fixture.download(input(), sink, signal()), "download_invalid_input");
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, { aborted: false }])(
    "requires an AbortSignal: %j",
    async (value) => {
      const fixture = harness();
      await expectFailure(fixture.download(input(), vi.fn(), value), "download_invalid_input");
      expect(fixture.request).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid trusted request seam", () => {
    expect(() => createArtifactDownloader(null)).toThrow("download_invalid_input");
  });

  it("redacts synchronous request creation errors", async () => {
    await expectFailure(
      createArtifactDownloader(() => {
        throw new Error(PRIVATE);
      })(input(), vi.fn(), signal()),
    );
  });

  it("handles a request.end failure without reporting closure prematurely", async () => {
    const fixture = harness();
    fixture.req.end.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    await expectFailure(fixture.download(input(), vi.fn(), signal()));
    expect(fixture.req.destroy).toHaveBeenCalled();
  });

  it("rejects already-aborted input before any request", async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE));
    const fixture = harness();
    await expectFailure(
      fixture.download(input(), vi.fn(), controller.signal),
      "download_cancelled",
    );
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("detects cancellation during trusted request construction before req.end", async () => {
    const controller = new AbortController();
    const fixture = harness();
    const request = (options: RequestOptions) => {
      controller.abort();
      return fixture.request(options);
    };
    await expectFailure(
      createArtifactDownloader(request)(input(), vi.fn(), controller.signal),
      "download_cancelled",
    );
    expect(fixture.req.end).not.toHaveBeenCalled();
  });

  it.each([100, 101, 204, 206, 301, 302, 304, 307, 308, 400, 404, 429, 500, undefined])(
    "rejects status %s without delivering body or following redirects",
    async (status) => {
      const fixture = harness();
      fixture.response.statusCode = status;
      const sink = vi.fn();
      await expectFailure(fixture.download(input(), sink, signal()));
      expect(sink).not.toHaveBeenCalled();
      expect(fixture.request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    [
      [],
      ["Content-Length", "3"],
      ["Content-Encoding", "identity"],
      ["Transfer-Encoding", "chunked"],
      ["X-Information", "value\twith-tab"],
    ].map((headers) => ({ headers })),
  )("accepts bounded unambiguous response framing: $headers", async ({ headers }) => {
    const fixture = harness();
    fixture.response.rawHeaders = headers;
    await fixture.download(input(), vi.fn(), signal());
  });

  it.each(
    [
      null,
      {},
      ["Content-Length"],
      ["Content-Length", 3],
      [3, "value"],
      ["Invalid Name", "value"],
      ["X", "value\nInjected:yes"],
      ["X", "\0"],
      ["X", "\x7f"],
      ["X", "x".repeat(8192)],
      ["Content-Length", "03"],
      ["Content-Length", "+3"],
      ["Content-Length", "3 "],
      ["Content-Length", " 3"],
      ["Content-Length", "3.0"],
      ["Content-Length", "3e0"],
      ["Content-Length", "0"],
      ["Content-Length", "2"],
      ["Content-Length", "4"],
      ["Content-Length", "999999999999999999999"],
      ["Content-Length", "3, 3"],
      ["Content-Length", "3", "content-length", "3"],
      ["Content-Encoding", "identity", "content-encoding", "identity"],
      ["Transfer-Encoding", "chunked", "transfer-encoding", "chunked"],
      ["Content-Encoding", "gzip"],
      ["Content-Encoding", "br"],
      ["Content-Encoding", "identity, gzip"],
      ["Transfer-Encoding", "gzip, chunked"],
      ["Transfer-Encoding", "identity"],
      ["Transfer-Encoding", "chunked", "Content-Length", "3"],
      ["Content-Range", "bytes 0-2/3"],
      ["Location", "https://evil.test/private"],
      ["Trailer", "Digest"],
      Array.from({ length: 33 }, (_, index) => [`X-${index}`, "x"]).flat(),
    ].map((headers) => ({ headers })),
  )("rejects hostile headers before sink admission: $headers", async ({ headers }) => {
    const fixture = harness();
    fixture.response.rawHeaders = headers;
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(sink).not.toHaveBeenCalled();
  });

  it("accepts the exact 32-header count boundary", async () => {
    const fixture = harness();
    fixture.response.rawHeaders = Array.from({ length: 32 }, (_, index) => [
      `X-${index}`,
      "x",
    ]).flat();
    await fixture.download(input(), vi.fn(), signal());
  });

  it.each(["", "ab", "abcd"])("measures actual body length independently: %j", async (body) => {
    const fixture = harness((current) => current.deliver(Buffer.from(body)));
    fixture.response.rawHeaders = [];
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    if (body.length > 3) expect(sink).not.toHaveBeenCalled();
  });

  it("pauses delivery until the previous sink settles and preserves byte order", async () => {
    const first = deferred();
    const seen: string[] = [];
    const fixture = harness((current) => {
      current.req.emit("response", current.response);
      current.response.write(Buffer.from("a"));
    });
    const sink = vi.fn(async (chunk: Buffer) => {
      seen.push(chunk.toString());
      if (seen.length === 1) await first.promise;
    });
    const run = fixture.download(input(), sink, signal());
    await tick();
    fixture.response.write(Buffer.from("b"));
    fixture.response.complete = true;
    fixture.response.end(Buffer.from("c"));
    await tick();
    expect(seen).toEqual(["a"]);
    first.resolve();
    await run;
    expect(seen.join("")).toBe("abc");
  });

  it("allows ordinary socket closure after complete framing while a sink is pending", async () => {
    const pending = deferred();
    const fixture = harness();
    const run = fixture.download(input(), () => pending.promise, signal());
    await tick();
    fixture.socket.emit("close");
    fixture.req.emit("close");
    pending.resolve();
    await run;
  });

  it.each(["throw", "reject"])("redacts a sink %s and closes the network", async (mode) => {
    const fixture = harness();
    const sink = () => {
      if (mode === "throw") throw new Error(PRIVATE);
      return Promise.reject(new Error(PRIVATE));
    };
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(fixture.socket.destroy).toHaveBeenCalled();
  });

  it("settles an admitted sink on cancellation, but admits no subsequent chunks", async () => {
    const pending = deferred();
    const controller = new AbortController();
    const fixture = harness();
    const sink = vi.fn(() => pending.promise);
    let finished = false;
    const checked = expectFailure(
      fixture.download(input(), sink, controller.signal),
      "download_cancelled",
    ).then(() => {
      finished = true;
    });
    await tick();
    controller.abort(new Error(PRIVATE));
    await tick();
    expect(finished).toBe(false);
    expect(fixture.socket.destroy).toHaveBeenCalled();
    pending.resolve();
    await checked;
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("suppresses a queued sink when cancellation precedes its microtask", async () => {
    const controller = new AbortController();
    const fixture = harness((current) => {
      current.req.emit("response", current.response);
      current.response.emit("data", Buffer.from("abc"));
      controller.abort();
    });
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, controller.signal), "download_cancelled");
    expect(sink).not.toHaveBeenCalled();
  });

  it("suppresses late data after a sticky transport failure", async () => {
    const fixture = harness((current) => {
      current.req.emit("response", current.response);
      current.req.emit("error", new Error(PRIVATE));
      current.response.emit("data", Buffer.from("abc"));
    });
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses a decoded string in the byte-only response stream", async () => {
    const fixture = harness((current) => {
      current.req.emit("response", current.response);
      current.response.emit("data", "abc");
    });
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(sink).not.toHaveBeenCalled();
  });

  it("fails closed if a trusted stream violates pause and emits overlapping chunks", async () => {
    const fixture = harness((current) => {
      current.req.emit("response", current.response);
      current.response.emit("data", Buffer.from("a"));
      current.response.emit("data", Buffer.from("bc"));
    });
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(sink).not.toHaveBeenCalled();
  });

  it("continues awaiting the admitted sink after network closure, without misreporting that closure", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const controller = new AbortController();
    const fixture = harness();
    let finished = false;
    const checked = expectFailure(
      fixture.download(input(), () => pending.promise, controller.signal),
      "download_cancelled",
    ).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toBe(false);
    pending.resolve();
    await checked;
  });

  it.each([
    "request",
    "socket",
    "response",
    "aborted",
    "premature-response-close",
    "premature-request-close",
    "premature-socket-close",
  ])("rejects %s failures with fixed output", async (kind) => {
    const fixture = harness((current) => {
      if (
        kind !== "request" &&
        kind !== "socket" &&
        kind !== "premature-request-close" &&
        kind !== "premature-socket-close"
      ) {
        current.req.emit("response", current.response);
      }
      if (kind === "request") current.req.emit("error", new Error(PRIVATE));
      if (kind === "socket") current.socket.emit("error", new Error(PRIVATE));
      if (kind === "response") current.response.emit("error", new Error(PRIVATE));
      if (kind === "aborted") current.response.emit("aborted");
      if (kind === "premature-response-close") current.response.emit("close");
      if (kind === "premature-request-close") current.req.emit("close");
      if (kind === "premature-socket-close") current.socket.emit("close");
    });
    await expectFailure(fixture.download(input(), vi.fn(), signal()));
  });

  it.each(["incomplete", "aborted", "trailers", "malformed-trailers"])(
    "rejects %s at the end of exact bytes",
    async (kind) => {
      const fixture = harness((current) => {
        current.deliver();
        if (kind === "incomplete") current.response.complete = false;
        if (kind === "aborted") current.response.aborted = true;
        if (kind === "trailers") current.response.rawTrailers = ["Digest", PRIVATE];
        if (kind === "malformed-trailers") current.response.rawTrailers = null;
      });
      await expectFailure(fixture.download(input(), vi.fn(), signal()));
    },
  );

  it.each(["information", "upgrade"])("rejects unexpected %s protocol", async (kind) => {
    const fixture = harness((current) => {
      current.req.emit(kind, {}, current.socket);
    });
    await expectFailure(fixture.download(input(), vi.fn(), signal()));
    expect(fixture.socket.destroy).toHaveBeenCalled();
  });

  it("closes a late response after request failure without admitting it", async () => {
    const fixture = harness((current) => {
      current.req.emit("error", new Error(PRIVATE));
      current.req.emit("response", current.response);
    });
    const sink = vi.fn();
    await expectFailure(fixture.download(input(), sink, signal()));
    expect(fixture.response.closed).toBe(true);
    expect(sink).not.toHaveBeenCalled();
  });

  it("closes a late-assigned socket after cancellation", async () => {
    const controller = new AbortController();
    const fixture = harness();
    fixture.req.end.mockImplementation(() => {
      queueMicrotask(() => {
        controller.abort();
        fixture.req.emit("socket", fixture.socket);
      });
      return fixture.req;
    });
    await expectFailure(
      fixture.download(input(), vi.fn(), controller.signal),
      "download_cancelled",
    );
    expect(fixture.socket.destroy).toHaveBeenCalled();
  });

  it.each([
    [MANIFEST, 20000],
    [BINARY, 120000],
  ])("enforces the fixed total request deadline for %s", async (url, duration) => {
    vi.useFakeTimers();
    const fixture = harness(() => {});
    const checked = expectFailure(
      fixture.download({ url, size: 3 }, vi.fn(), signal()),
      "download_timeout",
    );
    await vi.advanceTimersByTimeAsync(Number(duration) - 1);
    expect(fixture.req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await checked;
  });

  it("does not reset the fixed deadline when data trickles", async () => {
    vi.useFakeTimers();
    const fixture = harness((current) => current.req.emit("response", current.response));
    const checked = expectFailure(fixture.download(input(), vi.fn(), signal()), "download_timeout");
    await vi.advanceTimersByTimeAsync(10000);
    fixture.response.write(Buffer.from("a"));
    await vi.advanceTimersByTimeAsync(9999);
    expect(fixture.req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await checked;
  });

  it.each(["request", "socket"])(
    "reports unconfirmed %s closure after a bounded grace period",
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const fixture = harness(() => {});
      if (kind === "request") fixture.noRequestClose();
      else fixture.socket.closeEnabled = false;
      const checked = expectFailure(
        fixture.download(input(), vi.fn(), controller.signal),
        "download_cleanup_unconfirmed",
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(5000);
      await checked;
      fixture.req.emit("error", new Error(PRIVATE));
    },
  );

  it("never reports success if normal completion cannot confirm socket closure", async () => {
    vi.useFakeTimers();
    const fixture = harness();
    fixture.socket.closeEnabled = false;
    const checked = expectFailure(
      fixture.download(input(), vi.fn(), signal()),
      "download_cleanup_unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(5000);
    await checked;
  });
});
