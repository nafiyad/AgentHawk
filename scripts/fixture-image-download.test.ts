import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions, request } from "node:https";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyFixtureImageBase } from "./fixture-image-base.mjs";
import { createImageDownloader, imageDownloader } from "./fixture-image-download.mjs";
import { fixtureImageLayerPlan, IMAGE_METADATA } from "./fixture-image-layer-policy.mjs";
import { imageBaseMetadataFixture } from "./fixtures/image-base-metadata.mjs";

const TOKEN = "fixture-token-not-a-credential";
const PRIVATE = "fixture-private-error-not-for-output";
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const base = () => {
  const { manifestBytes, configBytes } = imageBaseMetadataFixture();
  return verifyFixtureImageBase(manifestBytes, configBytes);
};
const descriptor = (index = 7) => {
  const result = fixtureImageLayerPlan(base())?.[index];
  if (!result) throw new Error("fixture_missing");
  return result;
};
const auth = (
  value: unknown = {
    token: TOKEN,
    access_token: TOKEN,
    expires_in: 300,
    issued_at: "2026-09-12T17:00:00Z",
  },
) => Buffer.from(JSON.stringify(value));
const location = (digest = descriptor().digest) => {
  const hex = digest.slice(7);
  return `https://production.cloudfront.docker.com/registry-v2/docker/registry/v2/blobs/sha256/${hex.slice(0, 2)}/${hex}/data?Expires=1799999999&Signature=fixture-signature&Key-Pair-Id=fixture-key`;
};

class Socket extends EventEmitter {
  closed = false;
  closeEnabled = true;
  destroy = vi.fn(() => {
    if (!this.closed && this.closeEnabled) {
      this.closed = true;
      queueMicrotask(() => this.emit("close"));
    }
    return this;
  });
}
class Response extends PassThrough {
  statusCode: number | undefined = 200;
  rawHeaders: string[] = [];
  rawTrailers: string[] = [];
  complete = false;
  aborted = false;
}
type Network = {
  req: EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    maxHeadersCount?: number;
  };
  response: Response;
  socket: Socket;
  closeRequest: boolean;
  deliver: () => void;
};
type Spec = {
  status?: number;
  headers?: string[];
  body?: Buffer;
  start?: (network: Network) => void;
};
function harness(specs: Spec[] = []) {
  const calls: RequestOptions[] = [];
  const networks: Network[] = [];
  const requestFunction = vi.fn((options: RequestOptions) => {
    calls.push(options);
    const spec = specs[calls.length - 1] ?? {};
    const metadata = imageBaseMetadataFixture();
    const fallback =
      options.hostname === "auth.docker.io"
        ? auth()
        : String(options.path).includes("/manifests/")
          ? metadata.manifestBytes
          : String(options.path).includes(IMAGE_METADATA.config.digest.slice(7))
            ? metadata.configBytes
            : Buffer.alloc(descriptor().size, 7);
    const body = spec.body ?? fallback;
    const response = new Response();
    response.statusCode = spec.status ?? 200;
    response.rawHeaders = spec.headers ?? ["Content-Length", String(body.length)];
    const socket = new Socket();
    const req = new EventEmitter() as Network["req"];
    let destroyed = false;
    const network: Network = {
      req,
      response,
      socket,
      closeRequest: true,
      deliver() {
        req.emit("response", response);
        response.complete = true;
        response.end(body);
      },
    };
    req.destroy = vi.fn(() => {
      if (!destroyed) {
        destroyed = true;
        if (network.closeRequest) queueMicrotask(() => req.emit("close"));
      }
      return req;
    });
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        req.emit("socket", socket);
        if (spec.start) spec.start(network);
        else network.deliver();
      });
      return req;
    });
    networks.push(network);
    return req as unknown as ClientRequest;
  });
  const downloader = createImageDownloader(requestFunction as unknown as typeof request);
  return { calls, networks, request: requestFunction, downloader };
}
async function fails(promise: Promise<unknown>, code = "download_failed") {
  const value: unknown = await promise.then(
    () => undefined,
    (caught) => caught,
  );
  expect(value).toBeInstanceOf(Error);
  expect((value as Error).message).toBe(code);
  expect((value as Error).cause).toBeUndefined();
  expect(String(value)).not.toContain(PRIVATE);
}
afterEach(() => vi.useRealTimers());

describe("fixed image metadata and layer transport", () => {
  it("exports frozen inert production/seam instances", () => {
    const f = harness();
    expect(Object.isFrozen(imageDownloader)).toBe(true);
    expect(Object.isFrozen(f.downloader)).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(() => createImageDownloader(undefined as unknown as typeof request)).toThrow(
      "download_invalid_input",
    );
  });
  it("reacquires a scoped token for each exact metadata resource and verifies copied bytes", async () => {
    const f = harness();
    const result = await f.downloader.metadata(signal());
    expect(result).toMatchObject({
      status: "matched_metadata",
      layersVerified: false,
      executed: false,
    });
    expect(f.calls.map((x) => x.hostname)).toEqual([
      "auth.docker.io",
      "registry-1.docker.io",
      "auth.docker.io",
      "registry-1.docker.io",
    ]);
    for (const [index, call] of f.calls.entries()) {
      expect(call).toMatchObject({
        protocol: "https:",
        port: 443,
        method: "GET",
        rejectUnauthorized: true,
        insecureHTTPParser: false,
        joinDuplicateHeaders: false,
        maxHeaderSize: 8192,
      });
      expect(call.headers).toMatchObject({ "accept-encoding": "identity", connection: "close" });
      expect(call.headers).not.toHaveProperty("cookie");
      expect(call.headers).not.toHaveProperty("referer");
      expect(call.headers).toHaveProperty(
        "accept",
        index % 2 === 0
          ? "application/json"
          : index === 1
            ? "application/vnd.oci.image.manifest.v1+json"
            : "application/octet-stream",
      );
      if (index % 2 === 0) expect(call.headers).not.toHaveProperty("authorization");
      else expect(call.headers).toHaveProperty("authorization", `Bearer ${TOKEN}`);
      expect(f.networks[index].socket.closed).toBe(true);
      expect(f.networks[index].response.closed).toBe(true);
      expect(f.networks[index].req.maxHeadersCount).toBe(0);
      expect((call.agent as unknown as { options: Record<string, unknown> }).options).toMatchObject(
        {
          keepAlive: false,
          maxSockets: 1,
          maxTotalSockets: 1,
          maxCachedSessions: 0,
          proxyEnv: {},
          rejectUnauthorized: true,
        },
      );
    }
  });
  it("permits one fixed config redirect while stripping the registry token", async () => {
    const f = harness([
      {},
      {},
      {},
      {
        status: 307,
        body: Buffer.alloc(0),
        headers: ["Location", location(IMAGE_METADATA.config.digest), "Content-Length", "0"],
      },
    ]);
    expect(await f.downloader.metadata(signal())).toHaveProperty("status", "matched_metadata");
    expect(f.calls[4].hostname).toBe("production.cloudfront.docker.com");
    expect(f.calls[4].headers).not.toHaveProperty("authorization");
  });
  it("streams one fixed layer, waits for its sink, and copies before asynchronous use", async () => {
    const bytes = Buffer.alloc(descriptor().size, 7);
    const f = harness([
      {},
      {
        start(n) {
          n.req.emit("response", n.response);
          n.response.emit("data", bytes);
          bytes.fill(9);
          n.response.complete = true;
          n.response.end();
        },
      },
    ]);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = vi.fn(async (chunk: Buffer) => {
      expect(chunk).toEqual(Buffer.alloc(descriptor().size, 7));
      await pending;
    });
    let done = false;
    const run = f.downloader.layer(base(), 7, sink, signal()).then(() => {
      done = true;
    });
    await tick();
    expect(sink).toHaveBeenCalledOnce();
    expect(done).toBe(false);
    release();
    await run;
  });
  it("uses only a descriptor-bound CDN path and never forwards any credentials", async () => {
    const f = harness([
      {},
      {
        status: 307,
        body: Buffer.from("redirect"),
        headers: ["Location", location(), "Content-Length", "8"],
      },
    ]);
    const sink = vi.fn();
    await f.downloader.layer(base(), 7, sink, signal());
    expect(f.calls).toHaveLength(3);
    expect(f.calls[1].path).toBe(`/v2/library/node/blobs/${descriptor().digest}`);
    expect(f.calls[2].hostname).toBe("production.cloudfront.docker.com");
    expect(f.calls[2].headers).not.toHaveProperty("authorization");
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0][0]).toHaveLength(descriptor().size);
  });
  it.each([
    undefined,
    null,
    {},
    { status: "matched_metadata" },
    { ...base() },
    JSON.parse(JSON.stringify(base())),
    new Proxy(base(), {}),
  ])("rejects a forged metadata capability %# before I/O", async (input) => {
    const f = harness();
    await fails(f.downloader.layer(input, 7, vi.fn(), signal()), "download_invalid_input");
    expect(f.calls).toHaveLength(0);
  });
  it.each([-1, 8, 0.5, Number.NaN, Infinity, "7", {}, null])(
    "rejects invalid layer index %# before I/O",
    async (index) => {
      const f = harness();
      await fails(
        f.downloader.layer(base(), index as number, vi.fn(), signal()),
        "download_invalid_input",
      );
      expect(f.calls).toHaveLength(0);
    },
  );
  it.each([undefined, {}, new Proxy(signal(), {})])(
    "rejects invalid signals %# before network work",
    async (input) => {
      const f = harness();
      await fails(f.downloader.metadata(input as AbortSignal), "download_invalid_input");
      expect(f.calls).toHaveLength(0);
    },
  );
  it("rejects a pre-cancelled signal and invalid sink without starting requests", async () => {
    const f = harness();
    const controller = new AbortController();
    controller.abort(PRIVATE);
    await fails(f.downloader.metadata(controller.signal), "download_cancelled");
    await fails(
      f.downloader.layer(base(), 7, undefined as never, signal()),
      "download_invalid_input",
    );
    expect(f.calls).toHaveLength(0);
  });
  it("rejects changed same-size metadata bytes through the production verifier", async () => {
    const bytes = imageBaseMetadataFixture().configBytes;
    bytes[12] ^= 1;
    const f = harness([{}, {}, {}, { body: bytes }]);
    await fails(f.downloader.metadata(signal()));
  });
});

describe("closed anonymous token parsing", () => {
  it.each([
    { token: TOKEN },
    { access_token: TOKEN },
    {
      issued_at: "2026-09-12T17:00:00.123456789Z",
      expires_in: 300,
      access_token: TOKEN,
      token: TOKEN,
    },
  ])("accepts compatible closed token fields %#", async (shape) => {
    const f = harness([{ body: auth(shape) }]);
    await f.downloader.layer(base(), 7, vi.fn(), signal());
  });
  it.each([
    "",
    "{}",
    "[]",
    "null",
    "[]\n",
    '\uFEFF{"token":"fixture"}',
    '{"token":"a","token":"a"}',
    '{"to\\u006ben":"a"}',
    '{"token":"a",}',
    '{"token":"a", }',
    '{"token":"a"}x',
    '{"token":"a","unknown":true}',
    '{"token":"a","expires_in":00300}',
    ...[
      { token: 1 },
      { token: "" },
      { token: "x".repeat(4097) },
      { token: "unsafe\nvalue" },
      { token: "bad value" },
      { token: "é" },
      { token: "a", access_token: "b" },
      { token: "a", expires_in: 0 },
      { token: "a", expires_in: -1 },
      { token: "a", expires_in: 1.5 },
      { token: "a", expires_in: "300" },
      { token: "a", expires_in: 1e20 },
      { token: "a", issued_at: "invalid" },
      { token: "a", issued_at: 1 },
      { token: "a", refresh_token: "never" },
    ].map((x) => JSON.stringify(x)),
  ])("rejects malformed, duplicate, unknown or unsafe token data %#", async (body) => {
    const f = harness([{ body: Buffer.from(body) }]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    expect(f.calls).toHaveLength(1);
  });
  it("rejects invalid UTF-8 and over-bound token bodies", async () => {
    for (const body of [Buffer.from([0xff]), Buffer.alloc(16385)]) {
      const f = harness([{ body }]);
      await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    }
  });
});

describe("strict redirects, headers and framing", () => {
  it.each([
    (x: string) => x.replace("https:", "http:"),
    (x: string) =>
      x.replace(
        "production.cloudfront.docker.com",
        "production.cloudfront.docker.com.evil.invalid",
      ),
    (x: string) => x.replace("https://", "https://fixture@"),
    (x: string) => x.replace(".com/", ".com:443/"),
    (x: string) => `${x}#fragment`,
    (x: string) => `${x}&extra=a`,
    (x: string) => `${x}&Expires=1`,
    (x: string) => x.replace("Signature=fixture-signature", "Expires=1"),
    (x: string) => x.replace("Signature=fixture-signature", "Signature="),
    (x: string) => x.replace("Signature=fixture-signature", "Signature=%0a"),
    (x: string) => x.replace("Signature=fixture-signature", "Signature=%GG"),
    (x: string) => x.replace("Signature=fixture-signature", "Signature=%"),
    (x: string) => x.replace("Signature=fixture-signature", `Signature=${"a".repeat(2048)}`),
    (x: string) => x.replace("/data?", "/x/../data?"),
    (x: string) => x.replace("/data?", "/%64ata?"),
    (x: string) => x.replace("/data?", "\\data?"),
    (x: string) => x.replace("Expires=1799999999", "Expires=not-time"),
    (x: string) => x.replace(descriptor().digest.slice(7), "0".repeat(64)),
    (x: string) => ` ${x}`,
    (x: string) => x.replace("&Signature", "\t&Signature"),
  ])("rejects redirect authority/path/query confusion %#", async (mutate) => {
    const f = harness([
      {},
      { status: 307, body: Buffer.alloc(0), headers: ["Location", mutate(location())] },
    ]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    expect(f.calls).toHaveLength(2);
  });
  it.each([301, 302, 303, 308, 401, 403, 404, 429, 500, 206, 204])(
    "rejects status %s without retries",
    async (status) => {
      const f = harness([{}, { status }]);
      await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
      expect(f.calls).toHaveLength(2);
    },
  );
  it("rejects token, manifest and second-hop redirects", async () => {
    for (const specs of [
      [{ status: 307, headers: ["Location", location()] }],
      [{}, { status: 307, headers: ["Location", location()] }],
    ]) {
      const f = harness(specs);
      await fails(f.downloader.metadata(signal()));
    }
    const redirect = { status: 307, body: Buffer.alloc(0), headers: ["Location", location()] };
    const f = harness([{}, redirect, redirect]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    expect(f.calls).toHaveLength(3);
  });
  it.each(
    [
      ["Content-Length", "446"],
      ["Content-Length", "0447"],
      ["Content-Length", "447", "content-length", "447"],
      ["Content-Length", "447", "Transfer-Encoding", "chunked"],
      ["Transfer-Encoding", "gzip"],
      ["Content-Encoding", "gzip"],
      ["Content-Encoding", "br"],
      ["Content-Encoding", "identity, gzip"],
      ["Content-Range", "bytes 0-446/447"],
      ["Trailer", "x-test"],
      ["Location", location()],
      ["bad name", "x"],
      ["x-test", "bad\nvalue"],
      ["x-test", "x".repeat(8193)],
      Array.from({ length: 33 }, (_, i) => [`x-${i}`, "x"]).flat(),
      ["cookie", "a", "Cookie", "b"],
      ["Set-Cookie", "a\r\nb"],
    ].map((headers) => ({ headers })),
  )("rejects ambiguous/oversized/hostile raw headers %#", async ({ headers }) => {
    const f = harness([{}, { headers }]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
  });
  it.each(
    [
      [],
      ["Transfer-Encoding", "chunked"],
      ["Content-Length", "447", "Content-Encoding", "identity"],
      [
        "Set-Cookie",
        "fixture=a",
        "set-cookie",
        "fixture=b",
        "x-goog-hash",
        "a",
        "X-Goog-Hash",
        "b",
      ],
    ].map((headers) => ({ headers })),
  )(
    "accepts bounded unambiguous framing while ignoring non-authority headers %#",
    async ({ headers }) => {
      const f = harness([{}, { headers }]);
      await f.downloader.layer(base(), 7, vi.fn(), signal());
    },
  );
  it("rejects odd/non-array headers, missing location, unconfirmed completion and trailers", async () => {
    for (const change of [
      (n: Network) => {
        n.response.rawHeaders = ["x"];
      },
      (n: Network) => {
        n.response.rawHeaders = null as unknown as string[];
      },
      (n: Network) => {
        n.response.statusCode = 307;
        n.response.rawHeaders = [];
      },
      (n: Network) => {
        n.response.rawTrailers = ["x", "y"];
      },
      (n: Network) => {
        n.response.aborted = true;
      },
    ]) {
      const f = harness([
        {},
        {
          start(n) {
            change(n);
            n.deliver();
          },
        },
      ]);
      await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    }
    const f = harness([
      {},
      {
        start(n) {
          n.req.emit("response", n.response);
          n.response.end(Buffer.alloc(447));
        },
      },
    ]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
  });
  it("rejects short, long and over-bound chunks before accepting the resource", async () => {
    for (const body of [Buffer.alloc(446), Buffer.alloc(448), Buffer.alloc(65537)]) {
      const f = harness([{}, { headers: [], body }]);
      await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    }
  });
  it("rejects empty, forged and shared-memory chunks", async () => {
    const shared = Buffer.from(new SharedArrayBuffer(447));
    const disguised = Buffer.from(new SharedArrayBuffer(447));
    Object.setPrototypeOf(disguised.buffer, ArrayBuffer.prototype);
    const grafted = new Uint16Array(223);
    Object.setPrototypeOf(grafted, Buffer.prototype);
    const view = new DataView(new ArrayBuffer(447));
    Object.setPrototypeOf(view, Buffer.prototype);
    const detached = Buffer.alloc(447);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    const cases: unknown[] = [
      Buffer.alloc(0),
      new Uint8Array(447),
      new Proxy(Buffer.alloc(447), {}),
      shared,
      disguised,
      grafted,
      view,
      detached,
      "fixture",
    ];
    for (const chunk of cases) {
      const f = harness([
        {},
        {
          start(n) {
            n.req.emit("response", n.response);
            n.response.emit("data", chunk);
          },
        },
      ]);
      await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
    }
  });
  it("admits 64 KiB chunks with backpressure and exact final byte count", async () => {
    const size = descriptor(6).size;
    let pumped: Promise<void> | undefined;
    const f = harness([
      {},
      {
        headers: ["Content-Length", String(size)],
        start(n) {
          n.req.emit("response", n.response);
          pumped = (async () => {
            for (let remaining = size; remaining > 0; remaining -= Math.min(remaining, 65536)) {
              n.response.emit("data", Buffer.alloc(Math.min(remaining, 65536)));
              await tick();
            }
            n.response.complete = true;
            n.response.end();
          })();
        },
      },
    ]);
    const sink = vi.fn();
    await f.downloader.layer(base(), 6, sink, signal());
    await pumped;
    expect(sink.mock.calls[0][0]).toHaveLength(65536);
    expect(sink.mock.calls.reduce((sum, [chunk]) => sum + chunk.length, 0)).toBe(size);
  });
  it("rejects one-byte-progress exhaustion for small responses and layers", async () => {
    for (const small of [true, false]) {
      let pumped: Promise<void> | undefined;
      const spec: Spec = {
        headers: [],
        start(n) {
          n.req.emit("response", n.response);
          pumped = (async () => {
            for (let count = 0; count < (small ? 1025 : 65537) && !n.response.destroyed; count++) {
              n.response.emit("data", Buffer.from("a"));
              await tick();
            }
          })();
        },
      };
      const f = harness(small ? [spec] : [{}, spec]);
      const sink = vi.fn();
      await fails(f.downloader.layer(base(), 0, sink, signal()));
      await pumped;
      expect(f.calls).toHaveLength(small ? 1 : 2);
      expect(sink).toHaveBeenCalledTimes(small ? 0 : 65536);
    }
  }, 20000);
  it("rejects overlapping callback delivery without invoking a second sink", async () => {
    const f = harness([
      {},
      {
        headers: [],
        start(n) {
          n.req.emit("response", n.response);
          n.response.emit("data", Buffer.from("a"));
          n.response.emit("data", Buffer.from("b"));
        },
      },
    ]);
    const sink = vi.fn();
    await fails(f.downloader.layer(base(), 7, sink, signal()));
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("bounded cancellation and confirmed closure", () => {
  it("never starts a new hop until the previous request and socket close", async () => {
    let held: Network | undefined;
    const f = harness([
      {
        start(n) {
          held = n;
          n.closeRequest = false;
          n.socket.closeEnabled = false;
          n.deliver();
        },
      },
    ]);
    const run = f.downloader.layer(base(), 7, vi.fn(), signal());
    await tick();
    expect(f.calls).toHaveLength(1);
    held?.req.emit("close");
    await tick();
    expect(f.calls).toHaveLength(1);
    held?.socket.emit("close");
    await run;
    expect(f.calls).toHaveLength(2);
  });
  it("returns cleanup-unconfirmed ahead of timeout/cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const f = harness([
      {
        start(n) {
          n.closeRequest = false;
          n.socket.closeEnabled = false;
          controller.abort(PRIVATE);
        },
      },
    ]);
    const checked = fails(
      f.downloader.layer(base(), 7, vi.fn(), controller.signal),
      "download_cleanup_unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await checked;
    expect(f.calls).toHaveLength(1);
  });
  it("bounds auth at 20 seconds and the complete layer operation at 180 seconds", async () => {
    vi.useFakeTimers();
    for (const [specs, duration] of [
      [[{ start() {} }], 20000],
      [[{}, { start() {} }], 180000],
    ] as const) {
      const f = harness([...specs]);
      const checked = fails(f.downloader.layer(base(), 7, vi.fn(), signal()), "download_timeout");
      await vi.advanceTimersByTimeAsync(duration + 1);
      await checked;
    }
  });
  it("bounds small metadata including its auth at 20 seconds", async () => {
    vi.useFakeTimers();
    const f = harness([{}, { start() {} }]);
    const checked = fails(f.downloader.metadata(signal()), "download_timeout");
    await vi.advanceTimersByTimeAsync(20001);
    await checked;
  });
  it("does not abandon a started sink when cancellation closes the network", async () => {
    const controller = new AbortController();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = harness();
    let done = false;
    const checked = fails(
      f.downloader.layer(
        base(),
        7,
        async () => {
          controller.abort(PRIVATE);
          await pending;
        },
        controller.signal,
      ),
      "download_cancelled",
    ).then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    release();
    await checked;
    expect(f.calls).toHaveLength(2);
  });
  it("bounds an unconfirmed sink while retaining its completion handlers and denying new work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sink = vi.fn(async () => {
      controller.abort();
      await pending;
    });
    const f = harness();
    const checked = fails(
      f.downloader.layer(base(), 7, sink, controller.signal),
      "download_cleanup_unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await checked;
    expect(sink).toHaveBeenCalledOnce();
    expect(f.calls).toHaveLength(2);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
  });
  it("retains explicit storage closure uncertainty after a settled callback", async () => {
    await fails(
      harness().downloader.layer(
        base(),
        7,
        async () => {
          throw new Error("closure_unconfirmed");
        },
        signal(),
      ),
      "download_cleanup_unconfirmed",
    );
    const controller = new AbortController();
    await fails(
      harness().downloader.layer(
        base(),
        7,
        async () => {
          controller.abort();
          throw new Error("closure_unconfirmed");
        },
        controller.signal,
      ),
      "download_cleanup_unconfirmed",
    );
  });
  it("denies late data after sink settlement becomes explicitly unconfirmed", async () => {
    vi.useFakeTimers();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = harness([
      {},
      {
        start(n) {
          n.req.emit("response", n.response);
          n.response.emit("data", Buffer.alloc(447));
          n.response.complete = true;
          n.response.end();
        },
      },
    ]);
    const sink = vi.fn(async () => pending);
    const checked = fails(
      f.downloader.layer(base(), 7, sink, signal()),
      "download_cleanup_unconfirmed",
    );
    await vi.advanceTimersByTimeAsync(5001);
    await checked;
    f.networks[1].response.emit("data", Buffer.from("late"));
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(sink).toHaveBeenCalledOnce();
    expect(f.calls).toHaveLength(2);
  });
  it("redacts request/sink failures and ignores late cancellation after a network failure", async () => {
    const controller = new AbortController();
    const f = harness([
      {},
      {
        start(n) {
          n.req.emit("error", new Error(PRIVATE));
          controller.abort(PRIVATE);
        },
      },
    ]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), controller.signal));
    await fails(
      harness().downloader.layer(
        base(),
        7,
        async () => {
          throw new Error(PRIVATE);
        },
        signal(),
      ),
    );
    const throwing = createImageDownloader((() => {
      throw new Error(PRIVATE);
    }) as unknown as typeof request);
    await fails(throwing.metadata(signal()));
  });
  it.each([
    "information",
    "upgrade",
    "socket-error",
    "premature-close",
    "response-error",
    "aborted",
  ])("rejects unexpected protocol or closure event %s", async (kind) => {
    const f = harness([
      {},
      {
        start(n) {
          if (kind === "upgrade") n.req.emit("upgrade", {} as IncomingMessage, n.socket);
          else if (kind === "socket-error") n.socket.emit("error", new Error(PRIVATE));
          else if (kind === "premature-close") n.req.emit("close");
          else if (kind === "response-error" || kind === "aborted") {
            n.req.emit("response", n.response);
            n.response.emit(kind === "aborted" ? "aborted" : "error", new Error(PRIVATE));
          } else n.req.emit(kind, {});
        },
      },
    ]);
    await fails(f.downloader.layer(base(), 7, vi.fn(), signal()));
  });
});
