import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { JsonHttpClient } from "../src/http/safe-http-client.js";
import { SafeHttpError } from "../src/http/safe-http-client.js";
import {
  NpmRegistryProvider,
  npmResultForCache,
  parseCachedNpmResult,
} from "../src/npm/provider.js";
import { OperationCancelledError } from "../src/operation.js";

async function fixture(name: string): Promise<unknown> {
  const value = await readFile(new URL(`./fixtures/npm/${name}`, import.meta.url), "utf8");
  return JSON.parse(value) as unknown;
}

function client(value: unknown, capture?: (url: URL) => void): JsonHttpClient {
  return {
    getJson: async (url) => {
      capture?.(url);
      return value;
    },
  };
}

describe("NpmRegistryProvider", () => {
  it("forwards cancellation and does not downgrade it to provider failure", async () => {
    const controller = new AbortController();
    const provider = new NpmRegistryProvider({
      httpClient: {
        getJson: async (_url, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort(new Error("untrusted"));
          return {};
        },
      },
    });

    await expect(
      provider.getPackage(
        { ecosystem: "npm", name: "example", requestedSpec: "latest" },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(OperationCancelledError);
  });
  it("normalizes latest metadata without retaining arbitrary scripts", async () => {
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("mature-package.json")),
      now: () => new Date("2026-08-19T17:59:00.000Z"),
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "example-package",
      requestedSpec: "latest",
    });

    expect(result).toEqual({
      fetchedAt: "2026-08-19T17:59:00.000Z",
      ok: true,
      status: "ok",
      data: {
        name: "example-package",
        requestedSpec: "latest",
        resolvedVersion: "2.0.0",
        packagePublishedAt: "2020-01-01T00:00:00.000Z",
        releasePublishedAt: "2025-01-01T00:00:00.000Z",
        repositoryUrl: "git+https://github.com/example/example-package.git",
        lifecycleScripts: ["postinstall"],
        dist: {
          tarball: "https://registry.npmjs.org/example-package/-/example-package-2.0.0.tgz",
          integrity: "sha512-FAKE2",
        },
      },
    });
  });

  it.each([
    ["1.0.0", "1.0.0"],
    ["^1.0.0", "1.0.0"],
    ["next", "3.0.0-beta.1"],
  ] as const)("resolves selector %s to %s", async (requestedSpec, resolvedVersion) => {
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("mature-package.json")),
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "example-package",
      requestedSpec,
    });
    expect(result.ok && result.data.resolvedVersion).toBe(resolvedVersion);
  });

  it("encodes scoped package names without leaking query data", async () => {
    let requestedUrl: URL | undefined;
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("scoped-package.json"), (url) => {
        requestedUrl = url;
      }),
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "@example/scoped",
      requestedSpec: "1.2.3",
    });

    expect(result.ok).toBe(true);
    expect(requestedUrl?.pathname).toBe("/@example%2Fscoped");
    expect(requestedUrl?.search).toBe("");
  });

  it("reports a missing version as not found", async () => {
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("mature-package.json")),
    });
    await expect(
      provider.getPackage({
        ecosystem: "npm",
        name: "example-package",
        requestedSpec: "99.0.0",
      }),
    ).resolves.toMatchObject({ ok: false, status: "not_found" });
  });

  it("rejects inconsistent package and version identities", async () => {
    const base = (await fixture("mature-package.json")) as Record<string, unknown>;
    const wrongPackage = new NpmRegistryProvider({
      httpClient: client({ ...base, name: "different-package" }),
    });
    await expect(
      wrongPackage.getPackage({
        ecosystem: "npm",
        name: "example-package",
        requestedSpec: "latest",
      }),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });

    const versions = base.versions as Record<string, Record<string, unknown>>;
    const wrongVersion = new NpmRegistryProvider({
      httpClient: client({
        ...base,
        versions: { ...versions, "2.0.0": { ...versions["2.0.0"], version: "2.0.1" } },
      }),
    });
    await expect(
      wrongVersion.getPackage({
        ecosystem: "npm",
        name: "example-package",
        requestedSpec: "latest",
      }),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });

  it("normalizes deprecation without inventing repository or integrity data", async () => {
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("mature-package.json")),
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "example-package",
      requestedSpec: "next",
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        resolvedVersion: "3.0.0-beta.1",
        deprecated: "Use 2.x until the stable release.",
        lifecycleScripts: [],
      },
    });
  });

  it("maps provider and schema failures without raw data", async () => {
    const unavailable = new NpmRegistryProvider({
      httpClient: {
        getJson: async () => {
          throw new SafeHttpError("rate_limited", "Provider rate limit was reached.");
        },
      },
    });
    await expect(
      unavailable.getPackage({ ecosystem: "npm", name: "example", requestedSpec: "latest" }),
    ).resolves.toMatchObject({
      ok: false,
      status: "rate_limited",
      message: "Provider rate limit was reached.",
    });

    const malformed = new NpmRegistryProvider({
      httpClient: client({ untrustedField: "TEST_ONLY_PUBLIC_VALUE" }),
    });
    const result = await malformed.getPackage({
      ecosystem: "npm",
      name: "example",
      requestedSpec: "latest",
    });
    expect(result).toMatchObject({
      ok: false,
      status: "invalid_response",
      message: "Registry returned metadata with an invalid shape.",
    });
    expect(JSON.stringify(result)).not.toContain("TEST_ONLY_PUBLIC_VALUE");
  });

  it("rejects impossible registry timestamps at the provider boundary", async () => {
    const base = (await fixture("mature-package.json")) as Record<string, unknown>;
    const provider = new NpmRegistryProvider({
      httpClient: client({
        ...base,
        time: { ...(base.time as Record<string, string>), created: "2026-02-30T00:00:00.000Z" },
      }),
    });
    await expect(
      provider.getPackage({
        ecosystem: "npm",
        name: "example-package",
        requestedSpec: "latest",
      }),
    ).resolves.toMatchObject({ ok: false, status: "invalid_response" });
  });

  it("rejects insecure or credential-bearing registry URLs", () => {
    expect(() => new NpmRegistryProvider({ registryUrl: "http://registry.example.com" })).toThrow();
    expect(
      () => new NpmRegistryProvider({ registryUrl: "https://user:pass@example.com" }),
    ).toThrow();
  });

  it("maps unexpected provider failures to a redacted provider error", async () => {
    const provider = new NpmRegistryProvider({
      httpClient: {
        getJson: async () => {
          throw new Error("secret internal detail");
        },
      },
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "example",
      requestedSpec: "latest",
    });
    expect(result).toMatchObject({
      ok: false,
      status: "provider_error",
      message: "Registry evaluation failed.",
    });
  });
});

describe("npm cache normalization", () => {
  const credentialed = {
    ok: true as const,
    status: "ok" as const,
    fetchedAt: "2026-08-19T18:00:00.000Z",
    data: {
      name: "example",
      requestedSpec: "1.0.0",
      resolvedVersion: "1.0.0",
      repositoryUrl: "https://user:repository-secret@example.com/project.git",
      lifecycleScripts: [],
      dist: {
        integrity: "sha512-public",
        tarball: "https://token:tarball-secret@registry.example.com/example.tgz",
      },
    },
  };

  it("removes credential-bearing URLs before persistence", () => {
    const normalized = npmResultForCache(credentialed);
    expect(normalized.data.repositoryUrl).toBeUndefined();
    expect(normalized.data.dist).toEqual({ integrity: "sha512-public" });
    expect(JSON.stringify(normalized)).not.toContain("secret");
  });

  it("rejects forged cached payloads containing URL credentials", () => {
    expect(() => parseCachedNpmResult(credentialed)).toThrow();
  });

  it("preserves credential-free optional metadata and accepts non-URL repository notation", () => {
    const normalized = npmResultForCache({
      ...credentialed,
      data: {
        ...credentialed.data,
        repositoryUrl: "https://example.com/project.git",
        dist: { tarball: "https://registry.example.com/example.tgz" },
      },
    });
    expect(normalized.data).toMatchObject({
      repositoryUrl: "https://example.com/project.git",
      dist: { tarball: "https://registry.example.com/example.tgz" },
    });
    expect(
      parseCachedNpmResult({
        ...normalized,
        data: { ...normalized.data, repositoryUrl: "github:owner/project" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("handles absent optional URL metadata without inventing fields", () => {
    const { dist: _dist, repositoryUrl: _repositoryUrl, ...data } = credentialed.data;
    const normalized = npmResultForCache({ ...credentialed, data });
    expect(normalized.data).not.toHaveProperty("repositoryUrl");
    expect(normalized.data).not.toHaveProperty("dist");
  });
});
