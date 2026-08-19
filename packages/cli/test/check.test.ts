import type { FileHandle } from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataCache, type NpmProviderResult } from "@agenthawk/core";
import { describe, expect, it } from "vitest";
import { checkNpmPackage, readApprovalFile, readPolicyFile } from "../src/check.js";

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

function emptyOsv() {
  return {
    fetchedAt: "2026-08-19T17:58:00.000Z",
    ok: true as const,
    records: [],
    status: "ok" as const,
  };
}

describe("checkNpmPackage", () => {
  const activeApproval = {
    version: 1,
    approvals: [
      {
        ecosystem: "npm",
        name: "example-package",
        version: "1.0.0",
        approvedBy: "github:maintainer",
        approvedAt: "2026-08-01T00:00:00.000Z",
        expiresAt: "2026-09-01T00:00:00.000Z",
        reason: "Source and release reviewed.",
      },
    ],
  };

  it("renders a schema-stable allow report as JSON", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "json", strict: false },
      { getPackage: async () => success(), now: () => now, queryOsv: async () => emptyOsv() },
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

  it("emits PG005 when existing dependency context contains a confusable name", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { existingDependencies: ["example-packagee"], format: "json", strict: true },
      { getPackage: async () => success(), now: () => now, queryOsv: async () => emptyOsv() },
    );
    const report = JSON.parse(result.output);

    expect(result.exitCode).toBe(1);
    expect(report.verdict).toBe("review");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ basis: "heuristic", ruleId: "PG005", verdict: "review" }),
      ]),
    );
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
        queryOsv: async () => emptyOsv(),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("REVIEW PG007");
    expect(result.output).toContain("No package was installed.");
  });

  it("applies an exact approval after evaluation and reports both verdicts", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { approvalsPath: "approvals.yml", format: "json", strict: true },
      {
        getPackage: async () => success({ lifecycleScripts: ["postinstall"] }),
        now: () => now,
        readApprovals: async () => activeApproval,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      approval: { approvedBy: "github:maintainer" },
      originalVerdict: "review",
      verdict: "allow",
    });
  });

  it("keeps findings visible and renders matched approval in terminal output", async () => {
    const hostile = structuredClone(activeApproval);
    const record = hostile.approvals[0];
    if (!record) throw new Error("test fixture omitted approval");
    record.approvedBy = "github:maintainer";
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { approvalsPath: "approvals.yml", format: "terminal", strict: true },
      {
        getPackage: async () => success({ lifecycleScripts: ["postinstall"] }),
        now: () => now,
        readApprovals: async () => hostile,
      },
    );
    expect(result.output).toContain("REVIEW PG007");
    expect(result.output).toContain("github:maintainer");
    expect(result.output).not.toContain("\u001b");
  });

  it("fails closed on malformed or explicitly missing approval files", async () => {
    const malformed = await checkNpmPackage(
      "example-package@1.0.0",
      { approvalsPath: "approvals.yml", format: "json", strict: false },
      { readApprovals: async () => ({ version: 1, approvals: [{ name: "*" }] }) },
    );
    const missing = await checkNpmPackage("example-package@1.0.0", {
      approvalsPath: "missing-approvals.yml",
      format: "json",
      strict: false,
    });
    expect(malformed.exitCode).toBe(2);
    expect(missing.exitCode).toBe(2);
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
        queryOsv: async () => emptyOsv(),
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
              queryOsv: async () => emptyOsv(),
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
      {
        now: () => now,
        queryOsv: async () => emptyOsv(),
        readPolicy: async () => ({ bypass: true, version: 1 }),
      },
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
    expect(JSON.parse(result.output)).toMatchObject({
      schemaVersion: "1.0",
      error: { code: "invalid_input" },
      exitCode: 2,
    });
    expect(result.output).not.toContain("password");
  });

  it("returns a redacted exit 4 for unexpected internal failures", async () => {
    const result = await checkNpmPackage(
      "example-package",
      { format: "json", strict: false },
      {
        getPackage: async () => {
          throw new Error("token=internal-secret");
        },
        now: () => now,
        queryOsv: async () => emptyOsv(),
      },
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "internal_error", message: "Unexpected internal error." },
      exitCode: 4,
    });
    expect(result.output).not.toContain("internal-secret");
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
        queryOsv: async () => emptyOsv(),
      },
    );

    expect(contacted).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).findings[0]).toMatchObject({ ruleId: "PG015" });
  });

  it("produces deterministic digests for identical normalized inputs", async () => {
    const options = { format: "json" as const, strict: false };
    const dependencies = {
      getPackage: async () => success(),
      now: () => now,
      queryOsv: async () => emptyOsv(),
    };
    const first = JSON.parse(
      (await checkNpmPackage("example-package@1.0.0", options, dependencies)).output,
    );
    const second = JSON.parse(
      (await checkNpmPackage("example-package@1.0.0", options, dependencies)).output,
    );
    expect(first.policyDigest).toBe(second.policyDigest);
    expect(first.evidenceDigest).toBe(second.evidenceDigest);
  });

  it("reuses fresh npm and OSV cache entries offline without network access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () => success(),
          now: () => now,
          queryOsv: async () => emptyOsv(),
        },
      );
      let contacted = false;
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", offline: true, strict: true },
        {
          cache,
          getPackage: async () => {
            contacted = true;
            return success();
          },
          now: () => now,
          queryOsv: async () => {
            contacted = true;
            return emptyOsv();
          },
        },
      );
      expect(contacted).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.output)).toMatchObject({
        verdict: "error",
        findings: expect.arrayContaining([expect.objectContaining({ ruleId: "PG013" })]),
        providerStatus: [
          expect.objectContaining({ provider: "npm", status: "offline" }),
          expect.objectContaining({ provider: "osv", status: "offline" }),
        ],
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("never lets an approval resolve unauthenticated offline cache evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: false },
        {
          cache,
          getPackage: async () => success(),
          now: () => now,
          queryOsv: async () => emptyOsv(),
        },
      );
      const approvalsPath = join(directory, "approvals.yml");
      await writeFile(approvalsPath, JSON.stringify(activeApproval));
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { approvalsPath, format: "json", offline: true, strict: false },
        {
          cache,
          getPackage: async () => {
            throw new Error("network must not run");
          },
          now: () => now,
          queryOsv: async () => {
            throw new Error("network must not run");
          },
        },
      );
      const report = JSON.parse(result.output);
      expect(report.verdict).toBe("review");
      expect(report.approval).toBeUndefined();
      expect(report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ approvable: false, ruleId: "PG013" })]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("never persists credential-bearing metadata URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () =>
            success({
              repositoryUrl: "https://user:repository-secret@example.com/project.git",
              dist: {
                integrity: "sha512-public",
                tarball: "https://token:tarball-secret@example.com/package.tgz",
              },
            }),
          now: () => now,
          queryOsv: async () => emptyOsv(),
        },
      );
      const contents = await Promise.all(
        (await readdir(directory)).map((name) => readFile(join(directory, name), "utf8")),
      );
      expect(contents.join("\n")).not.toContain("secret");
      expect(contents.join("\n")).not.toContain("token:");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("ignores even schema-valid cached evidence during online evaluation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () => success(),
          now: () => now,
          queryOsv: async () => emptyOsv(),
        },
      );
      let contacted = false;
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () => {
            contacted = true;
            return {
              fetchedAt: now.toISOString(),
              message: "Live provider unavailable.",
              ok: false,
              status: "network_error",
            };
          },
          now: () => now,
        },
      );
      expect(contacted).toBe(true);
      expect(result.exitCode).toBe(3);
      expect(JSON.parse(result.output).findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "PG013" })]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fail-closes stale offline evidence and reports the provider as stale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    let clock = now;
    try {
      const cache = new MetadataCache({ root: directory, now: () => clock });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () => success(),
          now: () => clock,
          queryOsv: async () => emptyOsv(),
        },
      );
      clock = new Date("2026-08-19T20:00:00.000Z");
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", offline: true, strict: true },
        {
          cache,
          getPackage: async () => {
            throw new Error("network must not run");
          },
          now: () => clock,
        },
      );
      const report = JSON.parse(result.output);
      expect(result.exitCode).toBe(3);
      expect(report.findings[0]).toMatchObject({ ruleId: "PG013" });
      expect(report.providerStatus[0]).toMatchObject({ provider: "npm", status: "stale" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fail-closes stale OSV evidence while npm cache remains fresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    let clock = now;
    try {
      const cache = new MetadataCache({ root: directory, now: () => clock });
      await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", strict: true },
        {
          cache,
          getPackage: async () => success(),
          now: () => clock,
          queryOsv: async () => emptyOsv(),
        },
      );
      clock = new Date("2026-08-19T18:16:00.000Z");
      let contacted = false;
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", offline: true, strict: true },
        {
          cache,
          getPackage: async () => {
            contacted = true;
            return success();
          },
          now: () => clock,
          queryOsv: async () => {
            contacted = true;
            return emptyOsv();
          },
        },
      );
      const report = JSON.parse(result.output);
      expect(contacted).toBe(false);
      expect(result.exitCode).toBe(3);
      expect(report.providerStatus).toEqual(
        expect.arrayContaining([expect.objectContaining({ provider: "osv", status: "stale" })]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("--no-cache performs live checks without reading or writing cache files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      const result = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", noCache: true, strict: true },
        {
          cache,
          getPackage: async () => success(),
          now: () => now,
          queryOsv: async () => emptyOsv(),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fail-closes an offline cache miss and rejects offline with no-cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-cache-cli-"));
    try {
      const cache = new MetadataCache({ root: directory, now: () => now });
      const missing = await checkNpmPackage(
        "example-package@1.0.0",
        { format: "json", offline: true, strict: true },
        { cache, now: () => now },
      );
      const conflicting = await checkNpmPackage("example-package", {
        format: "json",
        noCache: true,
        offline: true,
        strict: false,
      });
      expect(missing.exitCode).toBe(3);
      expect(JSON.parse(missing.output).providerStatus[0]).toMatchObject({ status: "offline" });
      expect(conflicting.exitCode).toBe(2);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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
        { getPackage: async () => success(), now: () => now, queryOsv: async () => emptyOsv() },
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

  it("does not query OSV when the provider is explicitly disabled", async () => {
    let queried = false;
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "json", policyPath: "policy.yml", strict: false },
      {
        getPackage: async () => success(),
        now: () => now,
        queryOsv: async () => {
          queried = true;
          return emptyOsv();
        },
        readPolicy: async () => ({ registries: { osv: { enabled: false } }, version: 1 }),
      },
    );
    const report = JSON.parse(result.output);
    expect(queried).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(report.verdict).toBe("allow");
    expect(report.providerStatus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "OSV evidence provider is disabled by policy",
          provider: "osv",
          status: "disabled",
        }),
      ]),
    );
  });

  it("does not query OSV for non-registry input", async () => {
    let queried = false;
    await checkNpmPackage(
      "owner/repository#main",
      { format: "json", strict: false },
      {
        now: () => now,
        queryOsv: async () => {
          queried = true;
          return emptyOsv();
        },
      },
    );
    expect(queried).toBe(false);
  });

  it("blocks known malicious OSV records from check npm", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "json", strict: true },
      {
        getPackage: async () => success(),
        now: () => now,
        queryOsv: async () => ({
          fetchedAt: "2026-08-19T17:58:00.000Z",
          ok: true,
          records: [{ id: "MAL-2024-1234", malicious: true }],
          status: "ok",
        }),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).findings[0]).toMatchObject({
      ruleId: "PG010",
      verdict: "block",
    });
  });

  it("never lets an exact approval override a PG010 malicious block", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { approvalsPath: "approvals.yml", format: "json", strict: true },
      {
        getPackage: async () => success(),
        now: () => now,
        queryOsv: async () => ({
          fetchedAt: "2026-08-19T17:58:00.000Z",
          ok: true,
          records: [{ id: "MAL-2026-42", malicious: true }],
          status: "ok",
        }),
        readApprovals: async () => activeApproval,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      originalVerdict: "block",
      verdict: "block",
    });
    expect(JSON.parse(result.output).approval).toBeUndefined();
  });

  it("returns exit 3 when enabled OSV evidence is unavailable", async () => {
    const result = await checkNpmPackage(
      "example-package@1.0.0",
      { format: "json", strict: true },
      {
        getPackage: async () => success(),
        now: () => now,
        queryOsv: async () => ({
          fetchedAt: "2026-08-19T17:58:00.000Z",
          message: "osv-secret",
          ok: false,
          status: "timeout",
        }),
      },
    );
    expect(result.exitCode).toBe(3);
    expect(result.output).not.toContain("osv-secret");
    expect(JSON.parse(result.output)).toMatchObject({ verdict: "error" });
  });

  it("treats only a missing conventional approval file as optional", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const opener = async () => {
      throw missing;
    };
    await expect(readApprovalFile("default.yml", false, opener)).resolves.toBeUndefined();
    await expect(readApprovalFile("explicit.yml", true, opener)).rejects.toThrow(
      "Approval file could not be read.",
    );
  });

  it.each([
    ["duplicate keys", "version: 1\napprovals: []\napprovals: []\n"],
    ["aliases", "version: 1\napprovals: &items []\ncopy: *items\n"],
  ])("rejects hostile approval YAML: %s", async (_label, source) => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-approval-"));
    try {
      const path = join(directory, "approvals.yml");
      await writeFile(path, source, "utf8");
      await expect(readApprovalFile(path, true)).rejects.toThrow();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
