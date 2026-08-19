import { describe, expect, it } from "vitest";
import { createProgram } from "../src/program.js";

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
