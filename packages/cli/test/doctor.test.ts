import { doctorReportSchema } from "@agenthawk/core";
import { describe, expect, it, vi } from "vitest";
import { type DoctorDependencies, runDoctor } from "../src/doctor.js";

const checkedAt = new Date("2026-08-21T22:00:00.000Z");

function healthy(overrides: DoctorDependencies = {}): DoctorDependencies {
  return {
    architecture: "x64",
    cliVersion: "0.1.0-alpha.1",
    coreVersion: "0.1.0-alpha.1",
    cwd: "C:/private/repository",
    inspectFile: async () => "absent",
    nodeVersion: "24.19.0",
    now: () => checkedAt,
    platform: "win32",
    probeCache: async () => "writable",
    readApprovals: async () => undefined,
    readPolicy: async () => undefined,
    runGit: async () => "git version 2.51.0.windows.1\n",
    ...overrides,
  };
}

describe("doctor", () => {
  it("runs its bounded real local probes without provider access", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not run");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctor({ format: "json" });
      const report = doctorReportSchema.parse(JSON.parse(result.output));
      expect(report.providersContacted).toBe(false);
      expect([0, 1]).toContain(result.exitCode);
      expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(65_536);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("emits a strict ready report without contacting a provider", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not run");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await runDoctor({ format: "json" }, healthy());
      expect(result.exitCode).toBe(0);
      const report = doctorReportSchema.parse(JSON.parse(result.output));
      expect(report).toMatchObject({
        command: "doctor",
        providersContacted: false,
        ready: true,
        runtime: { declaredCompatible: true, upstreamSupported: true },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.output).not.toContain("C:/private");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["EOL Node", { nodeVersion: "20.20.2" }],
    ["Current Node", { nodeVersion: "26.7.0" }],
    ["malformed Node", { nodeVersion: "24.19.0\u001bsecret" }],
    ["prerelease Node", { nodeVersion: "24.19.0-rc.1" }],
    ["zero-padded minor", { nodeVersion: "22.01.0" }],
    ["zero-padded major", { nodeVersion: "022.0.0" }],
    ["zero-padded current minor", { nodeVersion: "24.019.0" }],
    ["unsafe Node 22 minor", { nodeVersion: "22.9007199254740992.0" }],
    ["unsafe Node 24 patch", { nodeVersion: "24.0.9007199254740992" }],
    ["version mismatch", { cliVersion: "0.1.0-alpha.2" }],
    ["cache unavailable", { probeCache: async () => "unwritable" as const }],
    ["Git unavailable", { runGit: async () => "hostile output" }],
    ["invalid policy", { readPolicy: async () => ({ bypass: true, version: 1 }) }],
    ["unsafe integration", { inspectFile: async () => "invalid" as const }],
  ])("reports attention for %s", async (_label, overrides) => {
    const result = await runDoctor({ format: "json" }, healthy(overrides));
    expect(result.exitCode).toBe(1);
    expect(doctorReportSchema.parse(JSON.parse(result.output)).ready).toBe(false);
  });

  it("labels known files as unverified presence and never reflects their contents", async () => {
    const secret = "secret-template-value";
    const result = await runDoctor(
      { format: "terminal" },
      healthy({
        inspectFile: async (path) => (path.endsWith("AGENTS.md") ? "present" : "absent"),
        readPolicy: async () => ({ version: 1 }),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Integration files are presence-only");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("AGENTS.md");
    expect(result.output).not.toContain("C:/private");
  });

  it("redacts unexpected failures that prevent a valid report", async () => {
    const result = await runDoctor(
      { format: "json" },
      healthy({ now: () => new Date("invalid-secret-diagnostic") }),
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "internal_error", message: "Doctor could not safely produce a report." },
      exitCode: 4,
    });
    expect(result.output).not.toContain("secret-diagnostic");
  });

  it("normalizes supported and unknown host families without reflecting hostile values", async () => {
    const arm = doctorReportSchema.parse(
      JSON.parse(
        (
          await runDoctor(
            { format: "json" },
            healthy({ architecture: "arm64", nodeVersion: "22.23.2", platform: "darwin" }),
          )
        ).output,
      ),
    );
    expect(arm).toMatchObject({
      ready: true,
      runtime: { architecture: "arm64", platform: "darwin" },
    });

    const unknown = doctorReportSchema.parse(
      JSON.parse(
        (
          await runDoctor(
            { format: "json" },
            healthy({ architecture: "hostile-arch", platform: "aix" }),
          )
        ).output,
      ),
    );
    expect(unknown).toMatchObject({
      ready: false,
      runtime: { architecture: "other", ciTestedPlatform: false, platform: "other" },
    });
    expect(JSON.stringify(unknown)).not.toContain("hostile-arch");
  });

  it("maps thrown component probes and invalid approvals to fixed attention states", async () => {
    const result = await runDoctor(
      { format: "json" },
      healthy({
        probeCache: async () => {
          throw new Error("private-cache-path");
        },
        runGit: async () => {
          throw new Error("private-git-stderr");
        },
        readApprovals: async () => ({ approvals: [{ wildcard: "*" }], version: 1 }),
        inspectFile: async () => {
          throw new Error("private-integration-path");
        },
      }),
    );
    const report = doctorReportSchema.parse(JSON.parse(result.output));
    expect(report).toMatchObject({
      ready: false,
      cache: { state: "unwritable" },
      git: { state: "unavailable" },
      configuration: { approvals: "invalid" },
      integrations: { codex: "invalid" },
    });
    expect(result.output).not.toContain("private-");
  });

  it("rejects overlong Git output and safely renders a terminal internal error", async () => {
    const attention = await runDoctor(
      { format: "json" },
      healthy({ runGit: async () => `git version 2.51.0 ${"a".repeat(4_096)}` }),
    );
    expect(doctorReportSchema.parse(JSON.parse(attention.output)).git.state).toBe("unavailable");

    const internal = await runDoctor(
      { format: "terminal" },
      healthy({ now: () => new Date("invalid") }),
    );
    expect(internal).toEqual({
      exitCode: 4,
      output: "AgentHawk: Doctor could not safely produce a report.\n",
    });
  });
});
