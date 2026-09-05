import { Agent, request } from "node:https";
import { CLAUDE_ARTIFACT_POLICY } from "./claude-artifact-policy.mjs";

const HEADER_BYTES = 8192;
const HEADER_COUNT = 32;
const CLOSE_TIMEOUT_MS = 5000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject HTTP header injection controls, preserving the permitted horizontal tab.
const INVALID_HEADER_VALUE = /[\x00-\x08\x0a-\x1f\x7f]/;
const ARTIFACTS = [
  CLAUDE_ARTIFACT_POLICY.key,
  CLAUDE_ARTIFACT_POLICY.manifest,
  CLAUDE_ARTIFACT_POLICY.signature,
  CLAUDE_ARTIFACT_POLICY.binary,
];

function fixedError(code) {
  return new Error(code);
}

// The public command supplies immutable policy, not caller-selected URLs/sizes.
// The smaller positive sizes admitted here support independent offline transport
// tests; authentication and the exact production pins belong to the caller.
function snapshotArtifact(artifact) {
  const url = Object.getOwnPropertyDescriptor(artifact, "url")?.value;
  const size = Object.getOwnPropertyDescriptor(artifact, "size")?.value;
  const policy = ARTIFACTS.find((entry) => entry.url === url);
  if (!policy || !Number.isSafeInteger(size) || size < 1 || size > policy.size) return undefined;
  return { url, size, timeoutMs: policy === CLAUDE_ARTIFACT_POLICY.binary ? 120000 : 20000 };
}

function validHeaders(response, size) {
  const raw = response.rawHeaders;
  if (!Array.isArray(raw) || raw.length % 2 !== 0 || raw.length > HEADER_COUNT * 2) return false;
  const headers = new Map();
  let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      INVALID_HEADER_VALUE.test(value)
    )
      return false;
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (bytes > HEADER_BYTES) return false;
    const key = name.toLowerCase();
    if (headers.has(key)) return false;
    headers.set(key, value);
  }
  const length = headers.get("content-length");
  const transfer = headers.get("transfer-encoding");
  const encoding = headers.get("content-encoding");
  return (
    (length === undefined || (/^[1-9][0-9]{0,8}$/.test(length) && Number(length) === size)) &&
    (transfer === undefined || transfer === "chunked") &&
    !(transfer !== undefined && length !== undefined) &&
    (encoding === undefined || encoding === "identity") &&
    !headers.has("content-range") &&
    !headers.has("location") &&
    !headers.has("trailer")
  );
}

/**
 * Trusted test seam with Node https.request(options) semantics. It is not a CLI
 * transport, URL, TLS, or pin override. The sink must settle each returned promise;
 * cancellation never abandons an already-started sink operation.
 */
export function createArtifactDownloader(requestFunction) {
  if (typeof requestFunction !== "function") throw fixedError("download_invalid_input");
  return async function download(artifact, onChunk, signal) {
    let input;
    try {
      input = snapshotArtifact(artifact);
      if (!input || typeof onChunk !== "function" || !(signal instanceof AbortSignal)) {
        throw fixedError("download_invalid_input");
      }
    } catch {
      throw fixedError("download_invalid_input");
    }
    if (signal.aborted) throw fixedError("download_cancelled");

    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxFreeSockets: 1,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
      proxyEnv: {},
    });
    return new Promise((resolve, reject) => {
      let req;
      let response;
      let socket;
      let requestClosed = false;
      let responseClosed = false;
      let socketClosed = false;
      let ended = false;
      let writing = false;
      let total = 0;
      let failure;
      let settled = false;
      let creating = true;
      let closeExpired = false;
      let closeTimer;

      function networkClosed() {
        return (
          (!req || requestClosed) && (!response || responseClosed) && (!socket || socketClosed)
        );
      }

      function finish() {
        if (settled || creating || writing || (!failure && !ended)) return;
        if (!networkClosed() && !closeExpired) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(closeTimer);
        signal.removeEventListener("abort", cancelled);
        if (closeExpired) reject(fixedError("download_cleanup_unconfirmed"));
        else if (failure) reject(fixedError(failure));
        else resolve();
      }

      function stop() {
        if (closeTimer === undefined) {
          closeTimer = setTimeout(() => {
            closeExpired = !networkClosed();
            finish();
          }, CLOSE_TIMEOUT_MS);
        }
        req?.destroy();
        response?.destroy();
        socket?.destroy();
        agent.destroy();
        finish();
      }

      function fail(code = "download_failed") {
        if (settled) return;
        failure ??= code;
        stop();
      }

      function cancelled() {
        fail("download_cancelled");
      }

      const timer = setTimeout(() => fail("download_timeout"), input.timeoutMs);
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        const url = new URL(input.url);
        req = requestFunction({
          protocol: "https:",
          hostname: "downloads.claude.ai",
          port: 443,
          path: url.pathname,
          method: "GET",
          agent,
          rejectUnauthorized: true,
          maxHeaderSize: HEADER_BYTES,
          insecureHTTPParser: false,
          joinDuplicateHeaders: false,
          headers: {
            "accept-encoding": "identity",
            "user-agent": "AgentHawk-artifact-preparation/1",
            connection: "close",
          },
        });
        // Keep every bounded raw header for our count/duplicate checks. A parser
        // count limit would silently truncate the evidence instead of rejecting it.
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
          // Native requests emit socket before upgrade; never leave even an
          // unexpected upgrade socket running after rejecting the protocol.
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
          if (failure || response.statusCode !== 200 || !validHeaders(response, input.size)) {
            fail();
            return;
          }
          response.on("data", (chunk) => {
            response.pause();
            if (failure) return;
            if (!Buffer.isBuffer(chunk) || chunk.length > input.size - total || writing) {
              fail();
              return;
            }
            total += chunk.length;
            writing = true;
            Promise.resolve()
              .then(() => {
                if (!failure) return onChunk(chunk);
              })
              .catch(() => fail())
              .finally(() => {
                writing = false;
                if (!failure) response.resume();
                finish();
              });
          });
          response.on("end", () => {
            ended = true;
            if (
              total !== input.size ||
              response.complete !== true ||
              response.aborted ||
              !Array.isArray(response.rawTrailers) ||
              response.rawTrailers.length !== 0
            )
              fail();
            else stop();
          });
        });
        creating = false;
        if (signal.aborted) cancelled();
        else req.end();
      } catch {
        creating = false;
        fail();
      }
    });
  };
}

export const downloadPinnedArtifact = createArtifactDownloader(request);
