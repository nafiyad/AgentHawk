import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanDependencies } from "../src/scan.js";

describe("scanDependencies", () => {
  it("applies the canonical policy from the scanned repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { alpha: "1.0.0" } }),
      );
      await writeFile(
        join(root, ".agenthawk.yml"),
        [
          "version: 1",
          "rules:",
          "  lifecycleScripts:",
          "    action: allow",
          "    scripts: [preinstall, install, postinstall, prepack, prepare]",
          "",
        ].join("\n"),
      );
      const result = await scanDependencies(
        { cwd: root, format: "json", noCache: true, strict: true },
        {
          getPackage: async (name, requestedSpec) => ({
            data: {
              lifecycleScripts: ["postinstall"],
              name,
              packagePublishedAt: "2020-01-01T00:00:00.000Z",
              releasePublishedAt: "2025-01-01T00:00:00.000Z",
              repositoryUrl: "https://github.com/example/project",
              requestedSpec,
              resolvedVersion: requestedSpec,
            },
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            status: "ok",
          }),
          now: () => new Date("2026-08-19T18:00:00.000Z"),
          queryOsv: async () => ({
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            records: [],
            status: "ok",
          }),
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output).verdict).toBe("allow");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("aggregates deterministic checks for every direct dependency and preserves sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          dependencies: { alpha: "1.0.0", local: "workspace:*" },
          devDependencies: { beta: "2.0.0" },
        }),
      );
      const contacted: string[] = [];
      const result = await scanDependencies(
        { cwd: root, format: "json", noCache: true, strict: true },
        {
          getPackage: async (name, requestedSpec) => {
            contacted.push(name);
            return {
              data: {
                lifecycleScripts: [],
                name,
                packagePublishedAt: "2020-01-01T00:00:00.000Z",
                releasePublishedAt: "2025-01-01T00:00:00.000Z",
                requestedSpec,
                resolvedVersion: requestedSpec,
              },
              fetchedAt: "2026-08-19T17:59:00.000Z",
              ok: true,
              status: "ok",
            };
          },
          now: () => new Date("2026-08-19T18:00:00.000Z"),
          queryOsv: async () => ({
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            records: [],
            status: "ok",
          }),
        },
      );
      const report = JSON.parse(result.output);
      expect(contacted.toSorted()).toEqual(["alpha", "beta"]);
      expect(result.exitCode).toBe(1);
      expect(report.verdict).toBe("review");
      expect(report.results.map((entry: { section: string }) => entry.section)).toEqual([
        "dependencies",
        "devDependencies",
        "dependencies",
      ]);
      expect(
        report.results.map(
          (entry: { report: { target: { name: string } } }) => entry.report.target.name,
        ),
      ).toEqual(["alpha", "beta", "local"]);
      expect(report.results[2].report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: "PG015" })]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("flags confusable sibling dependency names with PG005 during a scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          dependencies: { "mature-package": "1.0.0", "mature-packagee": "1.0.0" },
        }),
      );
      const result = await scanDependencies(
        { cwd: root, format: "json", noCache: true, strict: true },
        {
          getPackage: async (name, requestedSpec) => ({
            data: {
              lifecycleScripts: [],
              name,
              packagePublishedAt: "2020-01-01T00:00:00.000Z",
              releasePublishedAt: "2025-01-01T00:00:00.000Z",
              repositoryUrl: "https://github.com/example/project",
              requestedSpec,
              resolvedVersion: requestedSpec,
            },
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            status: "ok",
          }),
          now: () => new Date("2026-08-19T18:00:00.000Z"),
          queryOsv: async () => ({
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            records: [],
            status: "ok",
          }),
        },
      );
      const report = JSON.parse(result.output);
      expect(result.exitCode).toBe(1);
      expect(report.verdict).toBe("review");
      for (const entry of report.results) {
        expect(entry.report.findings).toEqual(
          expect.arrayContaining([expect.objectContaining({ ruleId: "PG005" })]),
        );
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders terminal findings and propagates provider errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { alpha: "1.0.0" } }),
      );
      const result = await scanDependencies(
        { cwd: root, format: "terminal", noCache: true, strict: true },
        {
          getPackage: async () => ({
            fetchedAt: "2026-08-19T17:59:00.000Z",
            message: "Provider unavailable.",
            ok: false,
            status: "network_error",
          }),
          now: () => new Date("2026-08-19T18:00:00.000Z"),
        },
      );
      expect(result.exitCode).toBe(3);
      expect(result.output).toContain("ERROR alpha");
      expect(result.output).toContain("PG013");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("returns the bounded inventory error when package.json is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      const result = await scanDependencies({ cwd: root, format: "json", strict: true });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({ error: { code: "invalid_input" } });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("propagates an invalid direct dependency coordinate safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "Bad Name": "1" } }),
      );
      const result = await scanDependencies({ cwd: root, format: "json", strict: true });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        schemaVersion: "1.0",
        error: {
          code: "invalid_input",
          message: "Package specification contains whitespace or control characters.",
        },
        exitCode: 2,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("envelopes malformed nested JSON as a redacted internal failure", async () => {
    const result = await scanDependencies(
      { format: "json", strict: true },
      {
        inventory: async () => ({
          exitCode: 0,
          output: `${JSON.stringify({
            schemaVersion: "1.0",
            manifest: "package.json",
            dependencies: [{ name: "alpha", requestedSpec: "1.0.0", section: "dependencies" }],
          })}\n`,
        }),
        checkPackage: async () => ({ exitCode: 4, output: "not-json" }),
      },
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "internal_error", message: "Dependency scan failed safely." },
      exitCode: 4,
    });
  });

  it("preserves a non-overridable malicious-package block in the aggregate", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-security-scan-"));
    try {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { alpha: "1.0.0" } }),
      );
      const result = await scanDependencies(
        { cwd: root, format: "json", noCache: true, strict: false },
        {
          getPackage: async (name, requestedSpec) => ({
            data: {
              lifecycleScripts: [],
              name,
              packagePublishedAt: "2020-01-01T00:00:00.000Z",
              releasePublishedAt: "2025-01-01T00:00:00.000Z",
              requestedSpec,
              resolvedVersion: requestedSpec,
            },
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            status: "ok",
          }),
          now: () => new Date("2026-08-19T18:00:00.000Z"),
          queryOsv: async () => ({
            fetchedAt: "2026-08-19T17:59:00.000Z",
            ok: true,
            records: [{ id: "MAL-1", malicious: true }],
            status: "ok",
          }),
        },
      );
      expect(JSON.parse(result.output).verdict).toBe("block");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
