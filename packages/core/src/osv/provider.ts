import { z } from "zod";
import {
  type HttpErrorKind,
  type JsonRequestClient,
  SafeHttpClient,
  SafeHttpError,
} from "../http/safe-http-client.js";
import { validClockValue } from "../time.js";

export const osvSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
export type OsvSeverity = z.infer<typeof osvSeveritySchema>;

export interface OsvRecord {
  id: string;
  malicious: boolean;
  severity?: OsvSeverity;
}

export type OsvProviderResult =
  | { ok: true; status: "ok"; fetchedAt: string; records: OsvRecord[] }
  | { ok: false; status: HttpErrorKind; fetchedAt: string; message: string };

export interface OsvPackageQuery {
  name: string;
  version: string;
}

export interface OsvProviderOptions {
  apiUrl?: string;
  httpClient?: JsonRequestClient;
  maxPages?: number;
  maxRecords?: number;
  now?: () => Date;
}

const defaultMaxPages = 8;
const defaultMaxRecords = 100;
const maximumPageTokenLength = 2_048;
const maximumBatchQueries = 32;
const maliciousId = /^MAL-\d{4}-\d+$/u;
const qualitativeSeverity = /^(CRITICAL|HIGH|MEDIUM|LOW|MODERATE)$/iu;
const ubuntuSeverity = /^(critical|high|medium|low)$/iu;

const queryResponseSchema = z
  .object({
    vulns: z.array(z.unknown()).optional(),
    next_page_token: z.string().min(1).max(maximumPageTokenLength).optional(),
  })
  .passthrough();

const abbreviatedVulnSchema = z
  .object({
    id: z.string().min(1),
    modified: z.string().min(1).optional(),
  })
  .passthrough();

const batchResultSchema = z
  .object({
    vulns: z.array(abbreviatedVulnSchema).optional(),
    next_page_token: z.string().min(1).max(maximumPageTokenLength).optional(),
  })
  .passthrough();

const batchResponseSchema = z
  .object({
    results: z.array(batchResultSchema),
  })
  .passthrough();

const osvRecordSchema = z
  .object({
    id: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    withdrawn: z.string().optional(),
    severity: z.array(z.unknown()).optional(),
    database_specific: z.record(z.string(), z.unknown()).optional(),
    affected: z.array(z.unknown()).optional(),
  })
  .passthrough();

export class OsvProvider {
  readonly id = "osv";
  readonly #apiUrl: URL;
  readonly #httpClient: JsonRequestClient;
  readonly #maxPages: number;
  readonly #maxRecords: number;
  readonly #now: () => Date;

  constructor(options: OsvProviderOptions = {}) {
    this.#httpClient = options.httpClient ?? new SafeHttpClient();
    this.#maxPages = options.maxPages ?? defaultMaxPages;
    this.#maxRecords = options.maxRecords ?? defaultMaxRecords;
    this.#now = options.now ?? (() => new Date());
    this.#apiUrl = normalizeApiUrl(options.apiUrl ?? "https://api.osv.dev/");
    for (const [name, value] of [
      ["maxPages", this.#maxPages],
      ["maxRecords", this.#maxRecords],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new TypeError(`${name} must be a positive integer.`);
      }
    }
  }

  async query(input: OsvPackageQuery): Promise<OsvProviderResult> {
    try {
      const records = new Map<string, OsvRecord>();
      let pageToken: string | undefined;
      for (let page = 0; page < this.#maxPages; page += 1) {
        const document = await this.#httpClient.postJson(new URL("v1/query", this.#apiUrl), {
          package: { ecosystem: "npm", name: input.name },
          version: input.version,
          ...(pageToken ? { page_token: pageToken } : {}),
        });
        const parsed = queryResponseSchema.parse(document);
        for (const value of parsed.vulns ?? []) {
          const record = normalizeRecord(value);
          if (!record) continue;
          if (records.size >= this.#maxRecords && !records.has(record.id)) {
            return truncated(this.#now());
          }
          records.set(record.id, record);
        }
        if (!parsed.next_page_token) {
          return success([...records.values()], this.#now());
        }
        if (page === this.#maxPages - 1) return truncated(this.#now());
        pageToken = parsed.next_page_token;
      }
      return truncated(this.#now());
    } catch (error) {
      return mapFailure(error, this.#now());
    }
  }

  async queryBatch(queries: readonly OsvPackageQuery[]): Promise<OsvProviderResult> {
    try {
      if (queries.length === 0) return success([], this.#now());
      if (queries.length > maximumBatchQueries) {
        return failure(
          "invalid_response",
          "OSV batch query exceeded the supported size.",
          validClockValue(this.#now(), "Provider clock"),
        );
      }

      const ids = new Set<string>();
      let remaining = queries.map((query) => ({
        query,
        pageToken: undefined as string | undefined,
      }));
      for (let page = 0; page < this.#maxPages; page += 1) {
        const document = await this.#httpClient.postJson(new URL("v1/querybatch", this.#apiUrl), {
          queries: remaining.map(({ query, pageToken }) => ({
            package: { ecosystem: "npm", name: query.name },
            version: query.version,
            ...(pageToken ? { page_token: pageToken } : {}),
          })),
        });
        const parsed = batchResponseSchema.parse(document);
        if (parsed.results.length !== remaining.length) {
          return failure(
            "invalid_response",
            "OSV batch results did not match the query count.",
            validClockValue(this.#now(), "Provider clock"),
          );
        }
        const nextRemaining: typeof remaining = [];
        for (const [index, result] of parsed.results.entries()) {
          const current = remaining[index];
          if (!current) {
            return failure(
              "invalid_response",
              "OSV batch results did not match the query count.",
              validClockValue(this.#now(), "Provider clock"),
            );
          }
          for (const vuln of result.vulns ?? []) {
            if (ids.size >= this.#maxRecords && !ids.has(vuln.id)) return truncated(this.#now());
            ids.add(vuln.id);
          }
          if (result.next_page_token) {
            nextRemaining.push({ query: current.query, pageToken: result.next_page_token });
          }
        }
        if (nextRemaining.length === 0) break;
        if (page === this.#maxPages - 1) return truncated(this.#now());
        remaining = nextRemaining;
      }

      const records: OsvRecord[] = [];
      for (const id of [...ids].sort()) {
        const document = await this.#httpClient.getJson(
          new URL(`v1/vulns/${encodeURIComponent(id)}`, this.#apiUrl),
        );
        const record = normalizeRecord(document);
        if (record) records.push(record);
      }
      return success(records, this.#now());
    } catch (error) {
      return mapFailure(error, this.#now());
    }
  }
}

export function classifyOsvRecord(record: {
  id: string;
  aliases?: string[] | undefined;
  withdrawn?: string | undefined;
  severity?: unknown;
  database_specific?: Record<string, unknown> | undefined;
  affected?: unknown[] | undefined;
}): OsvRecord | undefined {
  if (record.withdrawn) return undefined;
  const identifiers = [record.id, ...(record.aliases ?? [])];
  const malicious = identifiers.some((value) => maliciousId.test(value));
  const severity = qualitativeSeverityFrom(record);
  return {
    id: record.id,
    malicious,
    ...(severity ? { severity } : {}),
  };
}

function normalizeRecord(value: unknown): OsvRecord | undefined {
  return classifyOsvRecord(osvRecordSchema.parse(value));
}

function qualitativeSeverityFrom(record: {
  severity?: unknown;
  database_specific?: Record<string, unknown> | undefined;
  affected?: unknown[] | undefined;
}): OsvSeverity | undefined {
  const databaseSeverity = mapQualitativeLabel(record.database_specific?.severity);
  if (databaseSeverity) return databaseSeverity;

  const fromTopLevel = mapSeverityArray(record.severity);
  if (fromTopLevel) return fromTopLevel;

  if (!Array.isArray(record.affected)) return undefined;
  for (const entry of record.affected) {
    if (!entry || typeof entry !== "object") continue;
    const affected = entry as { severity?: unknown };
    const mapped = mapSeverityArray(affected.severity);
    if (mapped) return mapped;
  }
  return undefined;
}

function mapSeverityArray(value: unknown): OsvSeverity | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; score?: unknown };
    if (candidate.type === "Ubuntu" && typeof candidate.score === "string") {
      const mapped = mapQualitativeLabel(candidate.score.toUpperCase());
      if (mapped && ubuntuSeverity.test(candidate.score)) return mapped;
    }
    if (typeof candidate.score === "string") {
      const mapped = mapQualitativeLabel(candidate.score);
      if (mapped && qualitativeSeverity.test(candidate.score) && !candidate.score.includes("/")) {
        return mapped;
      }
    }
  }
  return undefined;
}

function mapQualitativeLabel(value: unknown): OsvSeverity | undefined {
  if (typeof value !== "string" || !qualitativeSeverity.test(value)) return undefined;
  const normalized = value.toUpperCase();
  if (normalized === "MODERATE") return "MEDIUM";
  if (
    normalized === "CRITICAL" ||
    normalized === "HIGH" ||
    normalized === "MEDIUM" ||
    normalized === "LOW"
  ) {
    return normalized;
  }
  return undefined;
}

function success(records: OsvRecord[], now: Date): OsvProviderResult {
  return {
    fetchedAt: validClockValue(now, "Provider clock"),
    ok: true,
    records: [...records].sort((left, right) => left.id.localeCompare(right.id)),
    status: "ok",
  };
}

function truncated(now: Date): OsvProviderResult {
  return failure(
    "invalid_response",
    "OSV results were truncated before pagination completed.",
    validClockValue(now, "Provider clock"),
  );
}

function mapFailure(error: unknown, now: Date): OsvProviderResult {
  const fetchedAt = validClockValue(now, "Provider clock");
  if (error instanceof SafeHttpError) return failure(error.kind, error.message, fetchedAt);
  if (error instanceof z.ZodError) {
    return failure("invalid_response", "OSV returned records with an invalid shape.", fetchedAt);
  }
  return failure("provider_error", "OSV evaluation failed.", fetchedAt);
}

function failure(status: HttpErrorKind, message: string, fetchedAt: string): OsvProviderResult {
  return { fetchedAt, message, ok: false, status };
}

function normalizeApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new TypeError("OSV API URL must not contain credentials.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError("OSV API URL must use HTTPS.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
