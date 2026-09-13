import { Agent, request } from "node:https";
import { types } from "node:util";
import { verifyFixtureImageBase } from "./fixture-image-base.mjs";
import { fixtureImageLayerPlan, IMAGE_METADATA } from "./fixture-image-layer-policy.mjs";

const REGISTRY = "registry-1.docker.io";
const CDN = "production.cloudfront.docker.com";
const AUTH =
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull";
const HEADER_BYTES = 8192;
const CLOSE_MS = 5000;
const TOKEN_BYTES = 16384;
const CHUNK_BYTES = 65536;
// biome-ignore lint/suspicious/noControlCharactersInRegex: HTTP field control rejection.
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
const aborted = /** @type {(this: AbortSignal) => boolean} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")
  ).get
);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = /** @type {(this: Uint8Array) => ArrayBuffer} */ (
  /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(typedArray, "buffer")).get
);
const lengthOf = /** @type {(this: Uint8Array) => number} */ (
  /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(typedArray, "byteLength")).get
);
const elementType = /** @type {(this: Uint8Array) => string | undefined} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)
  ).get
);
const bufferLength = /** @type {(this: ArrayBuffer) => number} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")
  ).get
);
const copy = Uint8Array.prototype.set;

/** @param {string} [code] */
function error(code = "download_failed") {
  return new Error(code);
}

/** @param {unknown} value @returns {Buffer} */
function snapshotChunk(value) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Buffer.prototype)
    throw error();
  const bytes = /** @type {Buffer} */ (value);
  const length = lengthOf.call(bytes);
  if (elementType.call(bytes) !== "Uint8Array" || length < 1 || length > CHUNK_BYTES) throw error();
  bufferLength.call(bufferOf.call(bytes));
  const result = Buffer.alloc(length);
  copy.call(result, bytes);
  return result;
}

/** Flat, closed token grammar: no duplicate/escaped keys or general JSON parser.
 * @param {Buffer} bytes @returns {string} */
function tokenFrom(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const body = /^[ \t\r\n]*\{([\s\S]*)\}[ \t\r\n]*$/.exec(text)?.[1];
  if (body === undefined) throw error();
  const field =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strict JSON string control rejection.
    /[ \t\r\n]*"(token|access_token|expires_in|issued_at)"[ \t\r\n]*:[ \t\r\n]*("[^"\\\x00-\x1f]*"|0|[1-9][0-9]*)[ \t\r\n]*/y;
  /** @type {Map<string, string | number>} */
  const fields = new Map();
  let offset = 0;
  while (offset < body.length) {
    field.lastIndex = offset;
    const match = field.exec(body);
    if (!match || fields.has(match[1])) throw error();
    const literal = match[2];
    fields.set(match[1], literal.startsWith('"') ? literal.slice(1, -1) : Number(literal));
    offset = field.lastIndex;
    if (offset === body.length) break;
    if (body[offset] !== "," || offset + 1 === body.length) throw error();
    offset++;
  }
  const token = fields.get("token") ?? fields.get("access_token");
  if (
    typeof token !== "string" ||
    token.length < 1 ||
    token.length > 4096 ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token)
  )
    throw error();
  for (const key of ["token", "access_token"])
    if (fields.has(key) && fields.get(key) !== token) throw error();
  const expires = fields.get("expires_in");
  if (
    expires !== undefined &&
    (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires < 1)
  )
    throw error();
  const issued = fields.get("issued_at");
  if (
    issued !== undefined &&
    (typeof issued !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(issued) ||
      !Number.isFinite(Date.parse(issued)))
  )
    throw error();
  return token;
}

/** @param {string} location @param {string} digest */
function redirectTarget(location, digest) {
  const hex = digest.slice(7);
  const prefix = `https://${CDN}/registry-v2/docker/registry/v2/blobs/sha256/${hex.slice(0, 2)}/${hex}/data?`;
  if (
    location.length > 2048 ||
    !location.startsWith(prefix) ||
    /[^\x21-\x7e]/.test(location) ||
    /[\\#]/.test(location)
  )
    throw error();
  const parts = location.slice(prefix.length).split("&");
  const keys = new Set();
  if (parts.length !== 3) throw error();
  for (const part of parts) {
    const match = /^(Expires|Signature|Key-Pair-Id)=([A-Za-z0-9_~.%-]+)$/.exec(part);
    if (!match || keys.has(match[1]) || /%(?![0-9A-Fa-f]{2})/.test(match[2])) throw error();
    const value = decodeURIComponent(match[2]);
    if (!/^[A-Za-z0-9_~.+/=-]+$/.test(value)) throw error();
    if (match[1] === "Expires" && !/^[1-9][0-9]{0,11}$/.test(value)) throw error();
    keys.add(match[1]);
  }
  return location;
}

/** @typedef {{size: number, exact: boolean, chunks: number, redirectDigest?: string}} BodyPolicy */
/** @param {import("node:http").IncomingMessage} response @param {BodyPolicy} policy */
function headersFor(response, policy) {
  const raw = response.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 || raw.length > 64) throw error();
  const headers = new Map();
  let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index],
      value = raw[index + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      CONTROL.test(value)
    )
      throw error();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > HEADER_BYTES) throw error();
    const key = name.toLowerCase();
    if (key === "set-cookie" || key === "x-goog-hash") continue;
    if (headers.has(key)) throw error();
    headers.set(key, value);
  }
  const length = headers.get("content-length"),
    transfer = headers.get("transfer-encoding"),
    encoding = headers.get("content-encoding");
  const redirect = response.statusCode === 307;
  if (response.statusCode !== 200 && !redirect) throw error();
  if (
    length !== undefined &&
    (!/^(0|[1-9][0-9]{0,8})$/.test(length) ||
      Number(length) > (redirect ? TOKEN_BYTES : policy.size) ||
      (!redirect && policy.exact && Number(length) !== policy.size))
  )
    throw error();
  if (
    (transfer !== undefined && transfer !== "chunked") ||
    (length !== undefined && transfer !== undefined) ||
    (encoding !== undefined && encoding !== "identity") ||
    headers.has("content-range") ||
    headers.has("trailer")
  )
    throw error();
  if (redirect) {
    if (!policy.redirectDigest || typeof headers.get("location") !== "string") throw error();
    return redirectTarget(headers.get("location"), policy.redirectDigest);
  }
  if (headers.has("location")) throw error();
  return undefined;
}

/** @typedef {(chunk: Buffer) => void | Promise<void>} Sink */
/** Trusted Node request seam; never a public endpoint/TLS/pin override.
 * @param {typeof request} requestFunction */
export function createImageDownloader(requestFunction) {
  if (typeof requestFunction !== "function") throw error("download_invalid_input");

  /** @param {string} address @param {BodyPolicy} policy @param {Sink} sink @param {AbortSignal} signal @param {string | undefined} bearer @param {() => string} cancellationCode */
  function exchange(address, policy, sink, signal, bearer, cancellationCode) {
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxFreeSockets: 1,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
      proxyEnv: {},
    });
    /** @returns {Promise<string | undefined>} */
    return new Promise((resolve, reject) => {
      /** @type {import("node:http").ClientRequest | undefined} */ let req;
      /** @type {import("node:http").IncomingMessage | undefined} */ let response;
      /** @type {import("node:net").Socket | undefined} */ let socket;
      let requestClosed = false,
        responseClosed = false,
        socketClosed = false;
      let ended = false,
        writing = false,
        settled = false,
        creating = true,
        closeExpired = false;
      let total = 0,
        chunks = 0;
      /** @type {string | undefined} */ let failure;
      /** @type {string | undefined} */ let redirect;
      /** @type {ReturnType<typeof setTimeout> | undefined} */ let closeTimer;
      const networkClosed = () =>
        (!req || requestClosed) && (!response || responseClosed) && (!socket || socketClosed);
      function finish() {
        if (
          settled ||
          creating ||
          (writing && !closeExpired) ||
          (!failure && !ended) ||
          (!networkClosed() && !closeExpired)
        )
          return;
        settled = true;
        clearTimeout(closeTimer);
        EventTarget.prototype.removeEventListener.call(signal, "abort", cancelled);
        if (closeExpired) {
          failure = "download_cleanup_unconfirmed";
          reject(error(failure));
        } else if (failure) reject(error(failure));
        else resolve(redirect);
      }
      function stop() {
        closeTimer ??= setTimeout(() => {
          // A retained callback may still be running: this is an explicit
          // unconfirmed-settlement failure, never a claim that its I/O stopped.
          closeExpired = !networkClosed() || writing;
          finish();
        }, CLOSE_MS);
        req?.destroy();
        response?.destroy();
        socket?.destroy();
        agent.destroy();
        finish();
      }
      /** @param {string} [code] */
      function fail(code = "download_failed") {
        if (!settled) {
          if (code === "download_cleanup_unconfirmed") failure = code;
          else failure ??= code;
          stop();
        }
      }
      function cancelled() {
        fail(cancellationCode());
      }
      EventTarget.prototype.addEventListener.call(signal, "abort", cancelled, { once: true });
      try {
        if (aborted.call(signal)) {
          creating = false;
          cancelled();
          return;
        }
        const url = new URL(address);
        req = requestFunction({
          protocol: "https:",
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: "GET",
          agent,
          rejectUnauthorized: true,
          maxHeaderSize: HEADER_BYTES,
          insecureHTTPParser: false,
          joinDuplicateHeaders: false,
          headers: {
            accept:
              url.hostname === "auth.docker.io"
                ? "application/json"
                : url.pathname.includes("/manifests/")
                  ? "application/vnd.oci.image.manifest.v1+json"
                  : "application/octet-stream",
            "accept-encoding": "identity",
            "user-agent": "AgentHawk-image-layer-verification/1",
            connection: "close",
            ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          },
        });
        req.maxHeadersCount = 0;
        req.on("error", () => fail());
        req.on("close", () => {
          requestClosed = true;
          if (!ended && !response?.complete && !failure) fail();
          finish();
        });
        req.on("socket", (assigned) => {
          socket = assigned;
          socket.on("error", () => fail());
          socket.on("close", () => {
            socketClosed = true;
            if (!ended && !response?.complete && !failure) fail();
            finish();
          });
          if (failure) stop();
        });
        req.on("information", () => fail());
        req.on("upgrade", (_message, upgraded) => {
          upgraded.destroy();
          fail();
        });
        req.on("response", (incoming) => {
          response = incoming;
          response.on("error", () => fail());
          response.on("aborted", () => fail());
          response.on("close", () => {
            responseClosed = true;
            if (!ended && !failure) fail();
            finish();
          });
          try {
            if (failure) throw error();
            redirect = headersFor(response, policy);
          } catch {
            fail();
            return;
          }
          response.on("data", (value) => {
            response?.pause();
            if (failure || settled) return;
            /** @type {Buffer} */ let chunk;
            try {
              chunk = snapshotChunk(value);
              if (
                ++chunks > (redirect ? 1024 : policy.chunks) ||
                chunk.length > (redirect ? TOKEN_BYTES : policy.size) - total ||
                writing
              )
                throw error();
            } catch {
              fail();
              return;
            }
            total += chunk.length;
            writing = true;
            Promise.resolve()
              .then(() => {
                if (!failure && !settled && !redirect) return sink(chunk);
              })
              .catch((caught) =>
                fail(
                  caught instanceof Error && caught.message === "closure_unconfirmed"
                    ? "download_cleanup_unconfirmed"
                    : "download_failed",
                ),
              )
              .finally(() => {
                writing = false;
                if (!failure && !settled) response?.resume();
                finish();
              });
          });
          response.on("end", () => {
            ended = true;
            if (
              (!redirect && policy.exact && total !== policy.size) ||
              response?.complete !== true ||
              response.aborted ||
              !Array.isArray(response.rawTrailers) ||
              response.rawTrailers.length !== 0
            )
              fail();
            else stop();
          });
        });
        creating = false;
        if (aborted.call(signal)) cancelled();
        else req.end();
      } catch {
        creating = false;
        fail();
      }
    });
  }

  /** @param {{digest: string, size: number}} descriptor @param {boolean} manifest @param {Sink} sink @param {AbortSignal} signal @param {boolean} large */
  async function resource(descriptor, manifest, sink, signal, large) {
    try {
      if (types.isProxy(signal)) throw error("download_invalid_input");
      if (aborted.call(signal)) throw error("download_cancelled");
    } catch (caught) {
      if (caught instanceof Error && caught.message === "download_cancelled") throw caught;
      throw error("download_invalid_input");
    }
    const controller = new AbortController();
    let code = "download_cancelled";
    const cancel = () => controller.abort();
    EventTarget.prototype.addEventListener.call(signal, "abort", cancel, { once: true });
    const timer = setTimeout(
      () => {
        if (!controller.signal.aborted) {
          code = "download_timeout";
          controller.abort();
        }
      },
      large ? 180000 : 20000,
    );
    const authTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        code = "download_timeout";
        controller.abort();
      }
    }, 20000);
    try {
      if (aborted.call(signal)) cancel();
      /** @type {Buffer[]} */ const pieces = [];
      await exchange(
        AUTH,
        { size: TOKEN_BYTES, exact: false, chunks: 1024 },
        (chunk) => {
          pieces.push(chunk);
        },
        controller.signal,
        undefined,
        () => code,
      );
      clearTimeout(authTimer);
      const token = tokenFrom(Buffer.concat(pieces));
      const url = `https://${REGISTRY}/v2/library/node/${manifest ? "manifests" : "blobs"}/${descriptor.digest}`;
      const policy = { size: descriptor.size, exact: true, chunks: large ? 65536 : 1024 };
      const next = await exchange(
        url,
        { ...policy, ...(!manifest ? { redirectDigest: descriptor.digest } : {}) },
        sink,
        controller.signal,
        token,
        () => code,
      );
      if (next) await exchange(next, policy, sink, controller.signal, undefined, () => code);
    } catch (caught) {
      if (
        caught instanceof Error &&
        ["download_cancelled", "download_timeout", "download_cleanup_unconfirmed"].includes(
          caught.message,
        )
      )
        throw caught;
      throw error();
    } finally {
      clearTimeout(timer);
      clearTimeout(authTimer);
      EventTarget.prototype.removeEventListener.call(signal, "abort", cancel);
    }
  }

  return Object.freeze({
    /** @param {AbortSignal} signal */
    async metadata(signal) {
      /** @type {Buffer[]} */ const manifest = [];
      /** @type {Buffer[]} */ const config = [];
      await resource(
        IMAGE_METADATA.manifest,
        true,
        (chunk) => {
          manifest.push(chunk);
        },
        signal,
        false,
      );
      await resource(
        IMAGE_METADATA.config,
        false,
        (chunk) => {
          config.push(chunk);
        },
        signal,
        false,
      );
      const result = verifyFixtureImageBase(Buffer.concat(manifest), Buffer.concat(config));
      if (result.status !== "matched_metadata") throw error();
      return result;
    },
    /** @param {unknown} baseResult @param {number} index @param {Sink} onChunk @param {AbortSignal} signal */
    async layer(baseResult, index, onChunk, signal) {
      const plan = fixtureImageLayerPlan(baseResult);
      if (
        !plan ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= plan.length ||
        typeof onChunk !== "function"
      )
        throw error("download_invalid_input");
      await resource(plan[index], false, onChunk, signal, true);
    },
  });
}

export const imageDownloader = createImageDownloader(request);
