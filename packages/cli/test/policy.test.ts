import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyValidationReportSchema } from "@agenthawk/core";
import { describe, expect, it, vi } from "vitest";
import { validatePolicyFile } from "../src/policy.js";

describe("policy validate", () => {
  it("returns a strict, deterministic JSON report for normalized policy", async () => {
    const first = await validatePolicyFile(
      "policy.yml",
      { format: "json" },
      { readPolicy: async () => ({ version: 1 }) },
    );
    const second = await validatePolicyFile(
      "other-policy.yml",
      { format: "json" },
      { readPolicy: async () => ({ mode: "review", version: 1 }) },
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const report = policyValidationReportSchema.parse(JSON.parse(first.output));
    const equivalent = policyValidationReportSchema.parse(JSON.parse(second.output));
    expect(report).toMatchObject({
      command: "policy_validate",
      mode: "review",
      policyVersion: 1,
      schemaVersion: "1.0",
      valid: true,
    });
    expect(report.policyDigest).toBe(equivalent.policyDigest);
  });

  it("renders only normalized terminal metadata and contacts no provider", async () => {
    const privatePath = "C:/private/policy.yml";
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await validatePolicyFile(
        privatePath,
        { format: "terminal" },
        {
          readPolicy: async () => ({
            defaults: {
              allowPrerelease: false,
              onProviderError: "error",
              onUnknownVersion: "error",
            },
            mode: "strict",
            version: 1,
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Policy: valid");
      expect(result.output).toContain("Mode: strict");
      expect(result.output).toContain("No provider was contacted.");
      expect(result.output).not.toContain(privatePath);
      expect(result.output).not.toContain("onProviderError");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loads a valid policy at the exact 256 KiB boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-validate-"));
    try {
      const path = join(directory, "policy.yml");
      const prefix = "version: 1\n#";
      await writeFile(path, `${prefix}${"x".repeat(256 * 1_024 - prefix.length)}`, "utf8");

      const result = await validatePolicyFile(path, { format: "json" });

      expect(result.exitCode).toBe(0);
      expect(policyValidationReportSchema.parse(JSON.parse(result.output)).valid).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["duplicate keys", Buffer.from("version: 1\nversion: 1\n")],
    ["aliases", Buffer.from("version: &version 1\nmode: *version\n")],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["oversized content", Buffer.alloc(256 * 1_024 + 1, 0x20)],
  ])("rejects hostile policy boundary input: %s", async (_label, contents) => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-validate-"));
    try {
      const path = join(directory, "policy.yml");
      await writeFile(path, contents);

      const result = await validatePolicyFile(path, { format: "json" });

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({
        error: { code: "invalid_input" },
        exitCode: 2,
        schemaVersion: "1.0",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects missing and non-regular policy paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-policy-validate-"));
    try {
      const missing = await validatePolicyFile(join(directory, "missing.yml"), { format: "json" });
      const nonRegular = await validatePolicyFile(directory, { format: "json" });

      expect(missing.exitCode).toBe(2);
      expect(nonRegular.exitCode).toBe(2);
      expect(JSON.parse(missing.output).error.message).toBe("Policy file could not be read.");
      expect(JSON.parse(nonRegular.output).error.message).toContain("regular file");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects unknown configuration without exposing schema internals", async () => {
    const result = await validatePolicyFile(
      "policy.yml",
      { format: "json" },
      { readPolicy: async () => ({ bypass: true, version: 1 }) },
    );

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "invalid_input", message: "Policy configuration is invalid." },
      exitCode: 2,
    });
    expect(result.output).not.toContain("bypass");
  });

  it("redacts unexpected reader failures", async () => {
    const result = await validatePolicyFile(
      "policy.yml",
      { format: "json" },
      {
        readPolicy: async () => {
          throw new Error("secret-reader-diagnostic");
        },
      },
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "internal_error", message: "Unexpected internal error." },
      exitCode: 4,
    });
    expect(result.output).not.toContain("secret-reader-diagnostic");
  });
});
