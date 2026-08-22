import {
  cancellationError,
  isOperationCancelled,
  type OperationContext,
  throwIfCancelled,
} from "../operation.js";
import { AGENTHAWK_VERSION } from "../version.js";

export type HttpErrorKind =
  | "invalid_response"
  | "network_error"
  | "not_found"
  | "provider_error"
  | "rate_limited"
  | "timeout";

export class SafeHttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeHttpError";
  }
}

export interface JsonHttpClient {
  getJson(url: URL, options?: HttpRequestOptions): Promise<unknown>;
}

export interface JsonRequestClient extends JsonHttpClient {
  postJson(url: URL, body: unknown, options?: HttpRequestOptions): Promise<unknown>;
}

export interface HttpRequestOptions extends OperationContext {}

export interface SafeHttpClientOptions {
  fetch?: typeof globalThis.fetch;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxRequestBytes?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const retryStatuses = new Set([502, 503, 504]);

export class SafeHttpClient implements JsonRequestClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxBodyBytes: number;
  readonly #maxRedirects: number;
  readonly #maxRequestBytes: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(options: SafeHttpClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.#maxRedirects = options.maxRedirects ?? 3;
    this.#maxRequestBytes = options.maxRequestBytes ?? 16_384;
    this.#maxRetries = options.maxRetries ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#userAgent = options.userAgent ?? `AgentHawk/${AGENTHAWK_VERSION}`;

    for (const [name, value] of [
      ["maxBodyBytes", this.#maxBodyBytes],
      ["maxRedirects", this.#maxRedirects],
      ["maxRequestBytes", this.#maxRequestBytes],
      ["maxRetries", this.#maxRetries],
      ["retryDelayMs", this.#retryDelayMs],
      ["timeoutMs", this.#timeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer.`);
      }
    }
  }

  async getJson(url: URL, options: HttpRequestOptions = {}): Promise<unknown> {
    return await this.#jsonWithRetry(url, { method: "GET" }, options.signal);
  }

  async postJson(url: URL, body: unknown, options: HttpRequestOptions = {}): Promise<unknown> {
    return await this.#jsonWithRetry(
      url,
      {
        body: encodeJsonBody(body, this.#maxRequestBytes),
        followRedirects: false,
        method: "POST",
      },
      options.signal,
    );
  }

  async #jsonWithRetry(
    url: URL,
    request: JsonRequest,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    assertAllowedUrl(url);
    throwIfCancelled({ signal: parentSignal });

    let lastError: SafeHttpError | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        return await this.#jsonOnce(url, request, parentSignal);
      } catch (error) {
        if (isOperationCancelled(error)) throw error;
        if (parentSignal?.aborted && !(error instanceof SafeHttpError && error.kind === "timeout"))
          throw cancellationError(parentSignal);
        const mapped = mapUnknownError(error);
        lastError = mapped;
        if (attempt === this.#maxRetries || !isRetryable(mapped)) {
          throw mapped;
        }
        try {
          await delay(this.#retryDelayMs * 2 ** attempt, parentSignal);
        } catch (error) {
          if (parentSignal?.aborted) throw cancellationError(parentSignal);
          throw error;
        }
      }
    }

    throw lastError ?? new SafeHttpError("network_error", "HTTP request failed.");
  }

  async #jsonOnce(
    initialUrl: URL,
    request: JsonRequest,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let abortCause: "parent" | "timeout" | undefined;
    const onParentAbort = () => {
      if (abortCause) return;
      abortCause = "parent";
      controller.abort();
    };
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      if (abortCause) return;
      abortCause = "timeout";
      controller.abort();
    }, this.#timeoutMs);
    let current = new URL(initialUrl);
    try {
      for (let redirects = 0; redirects <= this.#maxRedirects; redirects += 1) {
        const response = await this.#request(current, controller.signal, request);
        if (redirectStatuses.has(response.status)) {
          if (request.followRedirects === false) {
            await response.body?.cancel();
            throw new SafeHttpError("provider_error", "Provider POST must not redirect.");
          }
          if (redirects === this.#maxRedirects) {
            await response.body?.cancel();
            throw new SafeHttpError("provider_error", "Provider exceeded the redirect limit.");
          }
          const location = response.headers.get("location");
          if (!location) {
            await response.body?.cancel();
            throw new SafeHttpError("invalid_response", "Provider redirect omitted Location.");
          }
          await response.body?.cancel();
          current = new URL(location, current);
          assertAllowedUrl(current);
          continue;
        }

        if (response.status === 404) {
          await response.body?.cancel();
          throw new SafeHttpError("not_found", "Provider resource was not found.", 404);
        }
        if (response.status === 429) {
          await response.body?.cancel();
          throw new SafeHttpError("rate_limited", "Provider rate limit was reached.", 429);
        }
        if (!response.ok) {
          await response.body?.cancel();
          const message = `Provider returned HTTP ${response.status}.`;
          throw new SafeHttpError("provider_error", message, response.status);
        }

        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        if (!contentType.includes("application/json")) {
          await response.body?.cancel();
          throw new SafeHttpError("invalid_response", "Provider did not return JSON content.");
        }
        return parseJson(await readBoundedBody(response, this.#maxBodyBytes, controller.signal));
      }

      throw new SafeHttpError("provider_error", "Provider exceeded the redirect limit.");
    } catch (error) {
      if (abortCause === "parent" && parentSignal) throw cancellationError(parentSignal);
      if (abortCause === "timeout") {
        throw new SafeHttpError("timeout", "Provider request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  async #request(url: URL, signal: AbortSignal, request: JsonRequest): Promise<Response> {
    return await this.#fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": this.#userAgent,
        ...(request.body ? { "content-type": "application/json" } : {}),
      },
      method: request.method,
      redirect: "manual",
      signal,
      ...(request.body ? { body: request.body } : {}),
    });
  }
}

interface JsonRequest {
  body?: string;
  followRedirects?: boolean;
  method: "GET" | "POST";
}

function assertAllowedUrl(url: URL): void {
  if (url.username || url.password) {
    throw new SafeHttpError("provider_error", "Provider URL must not contain credentials.");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new SafeHttpError("provider_error", "Provider URL must use HTTPS.");
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximum) {
    await response.body?.cancel();
    throw new SafeHttpError("invalid_response", "Provider response exceeded the body limit.");
  }
  if (!response.body) {
    throw new SafeHttpError("invalid_response", "Provider response body was empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new SafeHttpError("invalid_response", "Provider response exceeded the body limit.");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) {
      throw new SafeHttpError("timeout", "Provider request timed out.");
    }
    if (error instanceof SafeHttpError) throw error;
    throw new SafeHttpError("invalid_response", "Provider response was not valid UTF-8.");
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal.aborted) throw signal.reason;

  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function encodeJsonBody(body: unknown, maximum: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new SafeHttpError("invalid_response", "Request body could not be encoded as JSON.");
  }
  if (typeof serialized !== "string") {
    throw new SafeHttpError("invalid_response", "Request body could not be encoded as JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > maximum) {
    throw new SafeHttpError("invalid_response", "Request body exceeded the size limit.");
  }
  return serialized;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SafeHttpError("invalid_response", "Provider returned malformed JSON.");
  }
}

function mapUnknownError(error: unknown): SafeHttpError {
  if (error instanceof SafeHttpError) return error;
  return new SafeHttpError("network_error", "Provider request failed.");
}

function isRetryable(error: SafeHttpError): boolean {
  return (
    error.kind === "network_error" ||
    error.kind === "timeout" ||
    retryStatuses.has(error.status ?? 0)
  );
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled({ signal });
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? cancellationError(signal) : new Error("Retry delay was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
