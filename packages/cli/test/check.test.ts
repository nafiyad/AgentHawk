import type { FileHandle } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NpmProviderResult } from "@agenthawk/core";
import { describe, expect, it } from "vitest";
import { checkNpmPackage, readPolicyFile } from "../src/check.js";

const now = new Date("2026-08-19T18:00:00.000Z");

function success(
  overrides: Partial<Extract<NpmProviderResult, { ok: true }>["data"]> = {},
): NpmProviderResult {
  return {
    data: {
      lifecycleScripts: [],
      name: "example-package",
      packagePublishedAt: "2020-01-01T00:00:00.000Z",
      releasePublishedAt: "2025-01-01T00:00:00.000Z",
      repositoryUrl: "https://github.com/example/example-package",
      requestedSpec: "1.0.0",
      resolvedVersion: "1.0.0",
      ...overrides,
    },
    fetchedAt: "2026-08-19T17:59:00.000Z",
    ok: true,
    status: "ok",
  };
}

describe("checkNpmPackage", () => {
  it("renders a schema-stable allow report as JSON", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "json", strict: false },
      { getPackage: async () => success(), now: () => now },
    );
    const report = JSON.parse(result.output) as Record<string, unknown>;

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      exitCodeMeaning: "allowed; warnings or non-strict findings may exist",
      schemaVersion: "1.0",
      verdict: "allow",
    });
    expect(report.policyDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("returns exit 1 for review findings in strict mode", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "terminal", strict: true },
      {
        getPackage: async () => {
          const value = success();
          if (!value.ok) throw new Error("unreachable");
          delete value.data.repositoryUrl;
          value.data.lifecycleScripts = ["postinstall"];
          return value;
        },
        now: () => now,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("REVIEW PG007");
    expect(result.output).toContain("No package was installed.");
  });

  it("returns exit 3 for a required provider error in strict mode", async () => {
    const result = await checkNpmPackage(
      "example-package",
      { format: "json", strict: true },
      {
        getPackage: async () => ({
          fetchedAt: "2026-08-19T17:59:00.000Z",
          message: "sensitive upstream detail",
          ok: false,
          status: "timeout",
        }),
        now: () => now,
      },
    );

    expect(result.exitCode).toBe(3);
    expect(result.output).not.toContain("sensitive upstream detail");
    expect(JSON.parse(result.output)).toMatchObject({ verdict: "error" });
  });

  it("does not include raw provider diagnostics in evidence digests", async () => {
    const run = async (message: string) =>
      JSON.parse(
        (
          await checkNpmPackage(
            "example-package",
            { format: "json", strict: true },
            {
              getPackage: async () => ({
                fetchedAt: "2026-08-19T17:59:00.000Z",
                message,
                ok: false,
                status: "provider_error",
              }),
              now: () => now,
            },
          )
        ).output,
      );

    const first = await run("token=first-secret");
    const second = await run("token=second-secret");
    expect(first.evidenceDigest).toBe(second.evidenceDigest);
    expect(JSON.stringify(first)).not.toContain("first-secret");
  });

  it("returns exit 2 for invalid package input or policy", async () => {
    const invalidSpec = await checkNpmPackage("bad package", { format: "json", strict: false });
    const invalidPolicy = await checkNpmPackage(
      "example-package",
      { format: "json", policyPath: "policy.yml", strict: false },
      { now: () => now, readPolicy: async () => ({ bypass: true, version: 1 }) },
    );

    expect(invalidSpec.exitCode).toBe(2);
    expect(invalidPolicy.exitCode).toBe(2);
    expect(invalidPolicy.output).not.toContain("bypass");
  });

  it("rejects unsafe registry URLs as input errors before network access", async () => {
    const result = await checkNpmPackage("example-package", {
      format: "json",
      registryUrl: "https://user:password@example.test/",
      strict: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.output).not.toContain("password");
  });

  it("returns a redacted exit 4 for unexpected internal failures", async () => {
    const result = await checkNpmPackage(
      "example-package",
      { format: "terminal", strict: false },
      {
        getPackage: async () => {
          throw new Error("token=internal-secret");
        },
        now: () => now,
      },
    );

    expect(result).toEqual({ exitCode: 4, output: "AgentHawk: Unexpected internal error.\n" });
  });

  it("classifies non-registry input without contacting npm", async () => {
    let contacted = false;
    const result = await checkNpmPackage(
      "owner/repository#main",
      { format: "json", strict: true },
      {
        getPackage: async () => {
          contacted = true;
          return success();
        },
        now: () => now,
      },
    );

    expect(contacted).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).findings[0]).toMatchObject({ ruleId: "PG015" });
  });

  it("produces deterministic digests for identical normalized inputs", async () => {
    const options = { format: "json" as const, strict: false };
    const dependencies = { getPackage: async () => success(), now: () => now };
    const first = JSON.parse(
      (await checkNpmPackage("example-package@1.0.0", options, dependencies)).output,
    );
    const second = JSON.parse(
      (await checkNpmPackage("example-package@1.0.0", options, dependencies)).output,
    );
    expect(first.policyDigest).toBe(second.policyDigest);
    expect(first.evidenceDigest).toBe(second.evidenceDigest);
  });

  it("loads valid policy files at the exact size limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-"));
    try {
      const path = join(directory, "policy.yml");
      const prefix = "version: 1\n#";
      await writeFile(path, `${prefix}${"x".repeat(256 * 1_024 - prefix.length)}`, "utf8");
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", policyPath: path, strict: false },
        { getPackage: async () => success(), now: () => now },
      );
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["duplicate keys", Buffer.from("version: 1\nversion: 1\n")],
    ["aliases", Buffer.from("version: &version 1\nmode: *version\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["oversized content", Buffer.alloc(256 * 1_024 + 1, 0x20)],
  ])("rejects policy file boundary violation: %s", async (_label, contents) => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-"));
    try {
      const path = join(directory, "policy.yml");
      await writeFile(path, contents);
      const result = await checkNpmPackage("example-package", {
        format: "json",
        policyPath: path,
        strict: false,
      });
      expect(result.exitCode).toBe(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a directory used as a policy file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-"));
    try {
      const result = await checkNpmPackage("example-package", {
        format: "json",
        policyPath: directory,
        strict: false,
      });
      expect(result.exitCode).toBe(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("continues bounded reads until EOF after short FileHandle reads", async () => {
    const source = Buffer.from("version: 1\n");
    let closed = false;
    const handle = {
      close: async () => {
        closed = true;
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(2, length, source.length - position);
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
      stat: async () => ({ isFile: () => true, size: source.length }),
    } as unknown as FileHandle;

    await expect(readPolicyFile("ignored", async () => handle)).resolves.toMatchObject({
      version: 1,
    });
    expect(closed).toBe(true);
  });
});
