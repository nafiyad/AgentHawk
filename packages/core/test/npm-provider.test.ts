import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { JsonHttpClient } from "../src/http/safe-http-client.js";
import { SafeHttpError } from "../src/http/safe-http-client.js";
import { NpmRegistryProvider } from "../src/npm/provider.js";

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
  it("normalizes latest metadata without retaining arbitrary scripts", async () => {
    const provider = new NpmRegistryProvider({
      httpClient: client(await fixture("mature-package.json")),
    });
    const result = await provider.getPackage({
      ecosystem: "npm",
      name: "example-package",
      requestedSpec: "latest",
    });

    expect(result).toEqual({
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
    ).resolves.toEqual({
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
    expect(result).toEqual({
      ok: false,
      status: "invalid_response",
      message: "Registry returned metadata with an invalid shape.",
    });
    expect(JSON.stringify(result)).not.toContain("TEST_ONLY_PUBLIC_VALUE");
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
    expect(result).toEqual({
      ok: false,
      status: "provider_error",
      message: "Registry evaluation failed.",
    });
  });
});
