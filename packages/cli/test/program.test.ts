import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";
import { runCli } from "../src/runner.js";

describe("CLI program", () => {
  it("exposes a stable name and description", () => {
    const program = createProgram();

    expect(program.name()).toBe("agenthawk");
    expect(program.description()).toContain("dependency admission control");
  });

  it("runs the nested npm check command with injected output and exit handling", async () => {
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      getPackage: async () => ({
        data: {
          lifecycleScripts: [],
          name: "example-package",
          packagePublishedAt: "2020-01-01T00:00:00.000Z",
          releasePublishedAt: "2025-01-01T00:00:00.000Z",
          repositoryUrl: "https://github.com/example/example-package",
          requestedSpec: "1.0.0",
          resolvedVersion: "1.0.0",
        },
        fetchedAt: "2026-08-19T17:59:00.000Z",
        ok: true,
        status: "ok",
      }),
      now: () => new Date("2026-08-19T18:00:00.000Z"),
      queryOsv: async () => ({
        fetchedAt: "2026-08-19T17:58:00.000Z",
        ok: true,
        records: [],
        status: "ok",
      }),
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });

    await program.parseAsync(["check", "npm", "example-package@1.0.0", "--format", "json"], {
      from: "user",
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ verdict: "allow" });
  });

  it("runs policy validation with the injected production boundary", async () => {
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      readPolicy: async () => ({ mode: "strict", version: 1 }),
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });

    await program.parseAsync(["policy", "validate", "--file", "policy.yml", "--format", "json"], {
      from: "user",
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      command: "policy_validate",
      mode: "strict",
      valid: true,
    });
  });

  it("runs approval verification with the injected production boundary", async () => {
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      now: () => new Date("2026-08-21T15:00:00.000Z"),
      readApprovals: async () => ({ version: 1, approvals: [] }),
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });

    await program.parseAsync(
      ["approvals", "verify", "--file", "approvals.yml", "--format", "json"],
      { from: "user" },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ command: "approvals_verify", valid: true });
  });

  it("runs doctor through injected bounded probes", async () => {
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      architecture: "x64",
      cliVersion: "0.1.0-alpha.1",
      coreVersion: "0.1.0-alpha.1",
      inspectFile: async () => "absent",
      nodeVersion: "24.19.0",
      now: () => new Date("2026-08-21T22:00:00.000Z"),
      platform: "linux",
      probeCache: async () => "writable",
      readApprovals: async () => undefined,
      readPolicy: async () => undefined,
      runGit: async () => "git version 2.51.0\n",
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });
    await program.parseAsync(["doctor", "--format", "json"], { from: "user" });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ command: "doctor", ready: true });
  });

  it("rejects unknown initialization integrations with the strict error envelope", async () => {
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });
    await program.parseAsync(["init", "--integration", "unknown", "--format", "json"], {
      from: "user",
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: "1.0",
      error: {
        code: "invalid_input",
        message: "Integration must be none, codex, claude, cursor, or generic.",
      },
      exitCode: 2,
    });
  });

  it("escapes ANSI controls in Commander parser errors", async () => {
    let errorOutput = "";
    const program = createProgram({ writeError: (value) => (errorOutput += value) }).exitOverride();

    await expect(
      program.parseAsync(["check", "npm", "example-package", `--bad\u001b[31moption`], {
        from: "user",
      }),
    ).rejects.toThrow();

    expect(errorOutput).toContain("\\u001b[31m");
    expect(errorOutput).not.toContain("\u001b");
  });
});

describe("CLI runner JSON parser failures", () => {
  it.each([
    ["missing check spec", ["check", "npm", "--format", "json"]],
    ["unknown scan option", ["scan", "--format", "json", "--unknown"]],
    ["missing diff base", ["diff", "--format", "json"]],
    ["missing policy file", ["policy", "validate", "--format", "json"]],
    ["missing approvals file", ["approvals", "verify", "--format", "json"]],
    ["unknown doctor option", ["doctor", "--format", "json", "--unknown"]],
    [
      "unknown Codex status option",
      ["integrations", "codex", "status", "--format", "json", "--unknown"],
    ],
    [
      "unknown Claude status option",
      ["integrations", "claude", "status", "--format", "json", "--unknown"],
    ],
    ["unknown init option", ["init", "--format", "json", "--unknown"]],
  ])("envelopes %s", async (_label, args) => {
    let output = "";
    let exitCode: number | undefined;
    await runCli(["node", "agenthawk", ...args], {
      setExitCode: (value) => {
        exitCode = value;
      },
      write: (value) => {
        output += value;
      },
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: "1.0",
      error: { code: "invalid_input", message: "Command-line arguments are invalid." },
      exitCode: 2,
    });
  });
});
