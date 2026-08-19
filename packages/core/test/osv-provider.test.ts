import { describe, expect, it } from "vitest";
import type { JsonRequestClient } from "../src/http/safe-http-client.js";
import { SafeHttpError } from "../src/http/safe-http-client.js";
import { classifyOsvRecord, OsvProvider } from "../src/osv/provider.js";

interface Route {
  body?: unknown;
  method: "GET" | "POST";
  path: string;
}

function client(
  handler: (route: Route) => unknown | Promise<unknown>,
  capture: Route[] = [],
): JsonRequestClient {
  return {
    getJson: async (url) => {
      const route: Route = { method: "GET", path: url.pathname };
      capture.push(route);
      return handler(route);
    },
    postJson: async (url, body) => {
      const route: Route = { body, method: "POST", path: url.pathname };
      capture.push(route);
      return handler(route);
    },
  };
}

const now = () => new Date("2026-08-19T17:58:00.000Z");

describe("OsvProvider.query", () => {
  it("returns no records for an empty complete page", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => ({ vulns: [] })),
      now,
    });
    await expect(provider.query({ name: "example-package", version: "1.0.0" })).resolves.toEqual({
      fetchedAt: "2026-08-19T17:58:00.000Z",
      ok: true,
      records: [],
      status: "ok",
    });
  });

  it("continues when the first page contains only a next_page_token", async () => {
    const pages = [
      { next_page_token: "page-2" },
      {
        vulns: [
          {
            id: "GHSA-aaaa-bbbb-cccc",
            database_specific: { severity: "HIGH" },
          },
        ],
      },
    ];
    const provider = new OsvProvider({
      httpClient: client(() => pages.shift()),
      now,
    });
    const result = await provider.query({ name: "example-package", version: "1.0.0" });
    expect(result.ok && result.records).toEqual([
      { id: "GHSA-aaaa-bbbb-cccc", malicious: false, severity: "HIGH" },
    ]);
  });

  it("fail-closes when pagination is truncated by the page limit", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => ({ next_page_token: "more", vulns: [] })),
      maxPages: 2,
      now,
    });
    await expect(
      provider.query({ name: "example-package", version: "1.0.0" }),
    ).resolves.toMatchObject({
      ok: false,
      status: "invalid_response",
      message: "OSV results were truncated before pagination completed.",
    });
  });

  it("fail-closes when additional records would exceed the record bound", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => ({
        vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }],
      })),
      maxRecords: 1,
      now,
    });
    await expect(
      provider.query({ name: "example-package", version: "1.0.0" }),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });

  it("classifies MAL ids as malicious and skips withdrawn records", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => ({
        vulns: [
          { id: "MAL-2024-1234", aliases: ["GHSA-malware"] },
          { id: "GHSA-withdrawn", withdrawn: "2024-01-01T00:00:00Z" },
        ],
      })),
      now,
    });
    const result = await provider.query({ name: "bad-package", version: "1.0.0" });
    expect(result.ok && result.records).toEqual([{ id: "MAL-2024-1234", malicious: true }]);
  });

  it("does not guess severity from CVSS vectors", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => ({
        vulns: [
          {
            id: "GHSA-vector-only",
            severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
          },
        ],
      })),
      now,
    });
    const result = await provider.query({ name: "example-package", version: "1.0.0" });
    expect(result.ok && result.records[0]).toEqual({ id: "GHSA-vector-only", malicious: false });
  });

  it("maps GHSA MODERATE to MEDIUM", async () => {
    expect(
      classifyOsvRecord({
        id: "GHSA-moderate",
        database_specific: { severity: "MODERATE" },
      }),
    ).toEqual({ id: "GHSA-moderate", malicious: false, severity: "MEDIUM" });
  });
});

describe("OsvProvider.queryBatch", () => {
  it("hydrates abbreviated matches before returning records", async () => {
    const captured: Route[] = [];
    const provider = new OsvProvider({
      httpClient: client((route) => {
        if (route.method === "POST") {
          return {
            results: [{ vulns: [{ id: "GHSA-hydrated", modified: "2026-01-01T00:00:00Z" }] }],
          };
        }
        return {
          id: "GHSA-hydrated",
          database_specific: { severity: "CRITICAL" },
        };
      }, captured),
      now,
    });

    const result = await provider.queryBatch([{ name: "example-package", version: "1.0.0" }]);
    expect(result.ok && result.results).toEqual([
      {
        query: { name: "example-package", version: "1.0.0" },
        records: [{ id: "GHSA-hydrated", malicious: false, severity: "CRITICAL" }],
      },
    ]);
    expect(captured.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /v1/querybatch",
      "GET /v1/vulns/GHSA-hydrated",
    ]);
  });

  it("fail-closes when abbreviated match hydration is missing", async () => {
    const provider = new OsvProvider({
      httpClient: client((route) => {
        if (route.method === "POST") {
          return { results: [{ vulns: [{ id: "GHSA-missing" }] }] };
        }
        throw new SafeHttpError("not_found", "Provider resource was not found.", 404);
      }),
      now,
    });
    await expect(
      provider.queryBatch([{ name: "example-package", version: "1.0.0" }]),
    ).resolves.toMatchObject({ ok: false, status: "not_found" });
  });

  it("paginates only the batch queries that returned a next_page_token", async () => {
    const captured: Route[] = [];
    let batchCalls = 0;
    const provider = new OsvProvider({
      httpClient: client((route) => {
        if (route.method === "POST") {
          batchCalls += 1;
          if (batchCalls === 1) {
            return {
              results: [
                { next_page_token: "q1-more", vulns: [{ id: "GHSA-one" }] },
                { vulns: [{ id: "GHSA-two" }] },
              ],
            };
          }
          return { results: [{ vulns: [{ id: "GHSA-one-b" }] }] };
        }
        const id = route.path.split("/").at(-1);
        return { id, database_specific: { severity: "HIGH" } };
      }, captured),
      now,
    });

    const result = await provider.queryBatch([
      { name: "left", version: "1.0.0" },
      { name: "right", version: "2.0.0" },
    ]);
    expect(
      result.ok && result.results.map((item) => item.records.map((record) => record.id)),
    ).toEqual([["GHSA-one", "GHSA-one-b"], ["GHSA-two"]]);
    const second = captured[1]?.body as { queries: unknown[] };
    expect(second.queries).toHaveLength(1);
  });

  it("returns empty evidence for an empty batch", async () => {
    const provider = new OsvProvider({
      httpClient: client(() => {
        throw new Error("should not query");
      }),
      now,
    });
    await expect(provider.queryBatch([])).resolves.toMatchObject({ ok: true, results: [] });
  });

  it("fail-closes when hydration returns a different advisory id", async () => {
    const provider = new OsvProvider({
      httpClient: client((route) =>
        route.method === "POST"
          ? { results: [{ vulns: [{ id: "GHSA-requested" }] }] }
          : { id: "GHSA-different", database_specific: { severity: "HIGH" } },
      ),
      now,
    });
    await expect(
      provider.queryBatch([{ name: "example-package", version: "1.0.0" }]),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });

  it("rejects oversized batches and mismatched result counts", async () => {
    const oversized = new OsvProvider({ httpClient: client(() => ({})), now });
    await expect(
      oversized.queryBatch(
        Array.from({ length: 33 }, (_, index) => ({ name: `pkg-${index}`, version: "1.0.0" })),
      ),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });

    const mismatched = new OsvProvider({
      httpClient: client(() => ({ results: [] })),
      now,
    });
    await expect(
      mismatched.queryBatch([{ name: "example-package", version: "1.0.0" }]),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });

  it("fail-closes truncated batch pagination and record bounds", async () => {
    const paged = new OsvProvider({
      httpClient: client(() => ({
        results: [{ next_page_token: "more", vulns: [{ id: "GHSA-page" }] }],
      })),
      maxPages: 1,
      now,
    });
    await expect(
      paged.queryBatch([{ name: "example-package", version: "1.0.0" }]),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });

    const bounded = new OsvProvider({
      httpClient: client(() => ({
        results: [{ vulns: [{ id: "GHSA-a" }, { id: "GHSA-b" }] }],
      })),
      maxRecords: 1,
      now,
    });
    await expect(
      bounded.queryBatch([{ name: "example-package", version: "1.0.0" }]),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });
});

describe("OsvProvider boundaries", () => {
  it("validates constructor bounds and API URLs", () => {
    expect(() => new OsvProvider({ maxPages: 0 })).toThrow(TypeError);
    expect(() => new OsvProvider({ apiUrl: "https://user:pass@api.osv.dev/" })).toThrow(TypeError);
    expect(() => new OsvProvider({ apiUrl: "http://example.test/" })).toThrow(TypeError);
    expect(() => new OsvProvider({ apiUrl: "http://127.0.0.1:9/osv" })).not.toThrow();
  });

  it("maps malformed JSON and unexpected failures without leaking details", async () => {
    const invalid = new OsvProvider({
      httpClient: client(() => ({ vulns: "not-an-array" })),
      now,
    });
    await expect(
      invalid.query({ name: "example-package", version: "1.0.0" }),
    ).resolves.toMatchObject({
      ok: false,
      status: "invalid_response",
    });

    const unexpected = new OsvProvider({
      httpClient: client(() => {
        throw new Error("token=secret");
      }),
      now,
    });
    const result = await unexpected.query({ name: "example-package", version: "1.0.0" });
    expect(result).toMatchObject({ ok: false, status: "provider_error" });
    expect(result.ok ? "" : result.message).not.toContain("secret");
  });

  it("classifies Ubuntu, package-level, and alias-based signals", () => {
    expect(
      classifyOsvRecord({
        id: "USN-1",
        severity: [{ type: "Ubuntu", score: "high" }],
      }),
    ).toEqual({ id: "USN-1", malicious: false, severity: "HIGH" });
    expect(
      classifyOsvRecord({
        id: "GHSA-affected",
        affected: [{ severity: [{ type: "label", score: "LOW" }] }],
      }),
    ).toEqual({ id: "GHSA-affected", malicious: false, severity: "LOW" });
    expect(
      classifyOsvRecord({
        id: "GHSA-alias-mal",
        aliases: ["MAL-2025-9"],
      }),
    ).toEqual({ id: "GHSA-alias-mal", malicious: true });
  });
});
