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
  getJson(url: URL): Promise<unknown>;
}

export interface SafeHttpClientOptions {
  fetch?: typeof globalThis.fetch;
  maxBodyBytes?: number;
  maxRedirects?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const retryStatuses = new Set([502, 503, 504]);

export class SafeHttpClient implements JsonHttpClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #maxBodyBytes: number;
  readonly #maxRedirects: number;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;

  constructor(options: SafeHttpClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    this.#maxRedirects = options.maxRedirects ?? 3;
    this.#maxRetries = options.maxRetries ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#userAgent = options.userAgent ?? "AgentHawk/0.0.0";

    for (const [name, value] of [
      ["maxBodyBytes", this.#maxBodyBytes],
      ["maxRedirects", this.#maxRedirects],
      ["maxRetries", this.#maxRetries],
      ["retryDelayMs", this.#retryDelayMs],
      ["timeoutMs", this.#timeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer.`);
      }
    }
  }

  async getJson(url: URL): Promise<unknown> {
    assertAllowedUrl(url);

    let lastError: SafeHttpError | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      try {
        return await this.#getJsonOnce(url);
      } catch (error) {
        const mapped = mapUnknownError(error);
        lastError = mapped;
        if (attempt === this.#maxRetries || !isRetryable(mapped)) {
          throw mapped;
        }
        await delay(this.#retryDelayMs * 2 ** attempt);
      }
    }

    throw lastError ?? new SafeHttpError("network_error", "HTTP request failed.");
  }

  async #getJsonOnce(initialUrl: URL): Promise<unknown> {
    let current = new URL(initialUrl);
    for (let redirects = 0; redirects <= this.#maxRedirects; redirects += 1) {
      const response = await this.#request(current);
      if (redirectStatuses.has(response.status)) {
        if (redirects === this.#maxRedirects) {
          throw new SafeHttpError("provider_error", "Provider exceeded the redirect limit.");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new SafeHttpError("invalid_response", "Provider redirect omitted Location.");
        }
        current = new URL(location, current);
        assertAllowedUrl(current);
        continue;
      }

      if (response.status === 404) {
        throw new SafeHttpError("not_found", "Provider resource was not found.", 404);
      }
      if (response.status === 429) {
        throw new SafeHttpError("rate_limited", "Provider rate limit was reached.", 429);
      }
      if (!response.ok) {
        const message = `Provider returned HTTP ${response.status}.`;
        throw new SafeHttpError("provider_error", message, response.status);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        throw new SafeHttpError("invalid_response", "Provider did not return JSON content.");
      }
      return parseJson(await readBoundedBody(response, this.#maxBodyBytes));
    }

    throw new SafeHttpError("provider_error", "Provider exceeded the redirect limit.");
  }

  async #request(url: URL): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": this.#userAgent,
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SafeHttpError("timeout", "Provider request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
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

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximum) {
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
      const { done, value } = await reader.read();
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
    if (error instanceof SafeHttpError) throw error;
    throw new SafeHttpError("invalid_response", "Provider response was not valid UTF-8.");
  }
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

async function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
