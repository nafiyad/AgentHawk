import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptsHostedSandboxExclusion,
  createMatrixProviderServer,
  MATRIX_SCENARIOS,
  matrixPolicy,
  percentile95,
  validateCliToolSet,
  validateScenarioFunctionOutput,
} from "./verify-codex-cli-project-matrix.mjs";
import { closeServer, HostHarnessError, listenLoopback, runBounded } from "./verify-codex-host.mjs";

const servers: ReturnType<typeof createMatrixProviderServer>["server"][] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await closeServer(server)));
});

describe("Codex CLI project-hook matrix contract", () => {
  it("accepts only exact rejection evidence with a truly absent neutral marker", () => {
    expect(acceptsHostedSandboxExclusion("neutral_marker_missing", "hosted_sandbox_rejected")).toBe(
      true,
    );
    for (const markerState of [
      "marker_present",
      "neutral_marker_invalid",
      "neutral_marker_not_regular",
      "neutral_marker_check_failed",
    ]) {
      expect(acceptsHostedSandboxExclusion(markerState, "hosted_sandbox_rejected")).toBe(false);
    }
    for (const category of [
      "success",
      "unknown",
      "not_found",
      "approval_rejected",
      "permission_rejected",
      "timeout",
      "sandbox_rejected",
    ]) {
      expect(acceptsHostedSandboxExclusion("neutral_marker_missing", category)).toBe(false);
    }
  });

  it("uses the nearest-rank p95 without averaging away tail latency", () => {
    expect(percentile95(Array.from({ length: 20 }, (_value, index) => index + 1))).toBe(19);
    expect(() => percentile95([])).toThrow("cli_matrix_performance_samples_invalid");
    expect(() => percentile95([1, -1])).toThrow("cli_matrix_performance_samples_invalid");
  });

  it("accepts only shell_command without alternate execution tools", () => {
    expect(
      validateCliToolSet({
        tools: [{ name: "shell_command" }, { name: "apply_patch" }, { name: "view_image" }],
      }),
    ).toEqual(["apply_patch", "shell_command", "view_image"]);
    for (const forbidden of ["exec_command", "write_stdin", "code_mode", "code_mode_execute"]) {
      expect(() =>
        validateCliToolSet({ tools: [{ name: "shell_command" }, { name: forbidden }] }),
      ).toThrowError(new HostHarnessError(`cli_matrix_alternate_tool_exposed:${forbidden}`));
    }
  });

  it.each([
    undefined,
    null,
    {},
    { tools: [] },
    { tools: [{ name: "shell_command" }, { name: "shell_command" }] },
    { tools: [{ name: "apply_patch" }] },
    { tools: [{ name: 7 }] },
  ])("rejects malformed, duplicate, or missing tool inventories", (value) => {
    expect(() => validateCliToolSet(value)).toThrowError(
      new HostHarnessError("cli_matrix_tool_set_invalid"),
    );
  });

  it("binds every denied outcome to its exact visible reason", () => {
    expect(validateScenarioFunctionOutput({ output: "completed" }, "allow")).toBe("allowed");
    for (const scenarioName of ["warn", "review", "block", "error"] as const) {
      const expected = MATRIX_SCENARIOS[scenarioName].expectedMessage;
      expect(validateScenarioFunctionOutput({ output: expected }, scenarioName)).toBe("denied");
      expect(() =>
        validateScenarioFunctionOutput({ output: "AgentHawk: other" }, scenarioName),
      ).toThrow(`cli_matrix_denial_reason_missing:${scenarioName}`);
    }
    expect(() =>
      validateScenarioFunctionOutput({ output: MATRIX_SCENARIOS.review.expectedMessage }, "allow"),
    ).toThrow("cli_matrix_allow_was_denied");
  });

  it("emits closed scenario policies with strict provider error only for error", () => {
    expect(matrixPolicy("allow")).toContain("mode: review\n");
    expect(matrixPolicy("warn")).toContain("action: warn\n");
    expect(matrixPolicy("review")).toContain("action: review\n");
    expect(matrixPolicy("block")).toContain("enabled: true\n");
    expect(matrixPolicy("error")).toContain("mode: strict\n");
    expect(matrixPolicy("error")).toContain("onProviderError: error\n");
    expect(() => matrixPolicy("unknown")).toThrow("cli_matrix_scenario_unknown");
  });

  it("serves only the exact bounded npm and OSV fixtures", async () => {
    const fixture = createMatrixProviderServer();
    servers.push(fixture.server);
    const listening = await listenLoopback(fixture.server);
    const origin = listening.origin;

    const allowed = await fetch(`${origin}/npm/${MATRIX_SCENARIOS.allow.name}`);
    await expect(allowed.json()).resolves.toMatchObject({
      name: MATRIX_SCENARIOS.allow.name,
      "dist-tags": { latest: "1.0.0" },
    });
    const invalid = await fetch(`${origin}/npm/${MATRIX_SCENARIOS.error.name}`);
    await expect(invalid.json()).resolves.toEqual({ invalid: true });
    const malicious = await fetch(`${origin}/osv/v1/query`, {
      body: JSON.stringify({
        package: { ecosystem: "npm", name: MATRIX_SCENARIOS.block.name },
        version: "1.0.0",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await expect(malicious.json()).resolves.toMatchObject({ vulns: [{ id: "MAL-2026-4242" }] });
    expect(fixture.state).toMatchObject({ error: undefined, npm: 2, osv: 1 });

    const unexpected = await fetch(`${origin}/npm/not-a-matrix-package`);
    expect(unexpected.status).toBe(500);
    expect(fixture.state.error).toEqual(new HostHarnessError("cli_matrix_npm_package_unexpected"));
  });

  it("preloads a loopback-only provider router and refuses every other destination", async () => {
    const fixture = createMatrixProviderServer();
    servers.push(fixture.server);
    const listening = await listenLoopback(fixture.server);
    const preload = pathToFileURL(resolve("scripts/codex-provider-preload.mjs")).href;
    const environment = {
      ...process.env,
      AGENTHAWK_CODEX_PROVIDER_FIXTURE_URL: listening.origin,
    };
    const routed = await runBounded(
      process.execPath,
      [
        "--import",
        preload,
        "-e",
        `fetch('https://registry.npmjs.org/${MATRIX_SCENARIOS.allow.name}').then((response) => response.json()).then((value) => process.stdout.write(value.name))`,
      ],
      { cwd: process.cwd(), env: environment, timeoutMs: 5_000 },
    );
    expect(routed).toMatchObject({
      code: 0,
      signal: null,
      stdout: MATRIX_SCENARIOS.allow.name,
    });
    expect(fixture.state).toMatchObject({ error: undefined, npm: 1, osv: 0 });

    const refused = await runBounded(
      process.execPath,
      ["--import", preload, "-e", "fetch('https://example.invalid/').catch(() => process.exit(7))"],
      { cwd: process.cwd(), env: environment, timeoutMs: 5_000 },
    );
    expect(refused).toMatchObject({ code: 7, signal: null, stdout: "" });
    expect(fixture.state).toMatchObject({ error: undefined, npm: 1, osv: 0 });
  });
});
