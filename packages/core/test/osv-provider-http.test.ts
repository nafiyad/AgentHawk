import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { SafeHttpClient } from "../src/http/safe-http-client.js";
import { OsvProvider } from "../src/osv/provider.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(handler: (response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => handler(response, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  return `http://127.0.0.1:${address.port}/`;
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

describe("OSV provider over bounded HTTP", () => {
  it("posts the exact resolved coordinate and normalizes malicious, vulnerable, and unknown records", async () => {
    let requestBody = "";
    const apiUrl = await serve((response, body) => {
      requestBody = body;
      json(response, {
        vulns: [
          { id: "MAL-2026-42" },
          { id: "GHSA-high", database_specific: { severity: "HIGH" } },
          { id: "GHSA-unknown", severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N" }] },
        ],
      });
    });
    const provider = new OsvProvider({ apiUrl, now: () => new Date("2026-08-19T18:00:00.000Z") });
    const result = await provider.query({ name: "@scope/example", version: "1.2.3" });

    expect(JSON.parse(requestBody)).toEqual({
      package: { ecosystem: "npm", name: "@scope/example" },
      version: "1.2.3",
    });
    expect(result.ok && result.records).toEqual([
      { id: "GHSA-high", malicious: false, severity: "HIGH" },
      { id: "GHSA-unknown", malicious: false },
      { id: "MAL-2026-42", malicious: true },
    ]);
  });

  it("returns complete empty evidence for a no-match response", async () => {
    const apiUrl = await serve((response) => json(response, {}));
    const provider = new OsvProvider({ apiUrl });
    await expect(provider.query({ name: "example", version: "1.0.0" })).resolves.toMatchObject({
      ok: true,
      records: [],
    });
  });

  it.each([
    [
      "malformed",
      (response: ServerResponse) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{");
      },
      new SafeHttpClient({ maxRetries: 0 }),
    ],
    [
      "oversized",
      (response: ServerResponse) => json(response, { padding: "x".repeat(256) }),
      new SafeHttpClient({ maxBodyBytes: 64, maxRetries: 0 }),
    ],
  ])("fail-closes a %s HTTP response", async (_label, respond, httpClient) => {
    const apiUrl = await serve((response) => respond(response));
    const provider = new OsvProvider({ apiUrl, httpClient });
    await expect(provider.query({ name: "example", version: "1.0.0" })).resolves.toMatchObject({
      ok: false,
      status: "invalid_response",
    });
  });

  it("fail-closes a stalled response body as a timeout", async () => {
    const apiUrl = await serve((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    const provider = new OsvProvider({
      apiUrl,
      httpClient: new SafeHttpClient({ maxRetries: 0, timeoutMs: 20 }),
    });
    await expect(provider.query({ name: "example", version: "1.0.0" })).resolves.toMatchObject({
      ok: false,
      status: "timeout",
    });
  });
});
