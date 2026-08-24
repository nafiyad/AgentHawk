#!/usr/bin/env node

import { access, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareTrustedProjectHookScenario } from "./verify-codex-app-server.mjs";
import {
  assertExactVersion,
  closeServer,
  createFixtureServer,
  describeFunctionOutputEvidence,
  EXPECTED_CODEX_VERSION,
  HostHarnessError,
  listenLoopback,
  minimalEnvironment,
  parseArguments,
  runBounded,
  verifyNeutralMarker,
} from "./verify-codex-host.mjs";

const MAX_PROVIDER_REQUEST_BYTES = 64 * 1024;
const FIXTURE_VERSION = "1.0.0";
const FIXTURE_TIMESTAMP = "2020-01-01T00:00:00.000Z";
const PERFORMANCE_SAMPLES = 25;

function parseMatrixArguments(argv) {
  const expectAdministratorRejection = argv.includes("--expect-administrator-rejection");
  const probeAdministratorRejection = argv.includes("--probe-administrator-rejection");
  const hostArguments = argv.filter(
    (argument) =>
      argument !== "--expect-administrator-rejection" &&
      argument !== "--probe-administrator-rejection",
  );
  return {
    ...parseArguments(hostArguments),
    expectAdministratorRejection,
    probeAdministratorRejection,
  };
}

export const MATRIX_SCENARIOS = Object.freeze({
  allow: Object.freeze({
    expectedMessage: undefined,
    expectedProviderRequests: Object.freeze({ npm: 1, osv: 0 }),
    name: "agenthawk-matrix-allow",
    repository: true,
  }),
  warn: Object.freeze({
    expectedMessage: "AgentHawk: A dependency warning requires review on this adapter.",
    expectedProviderRequests: Object.freeze({ npm: 1, osv: 0 }),
    name: "agenthawk-matrix-warn",
    repository: false,
  }),
  review: Object.freeze({
    expectedMessage: "AgentHawk: Dependency policy evaluation requires review.",
    expectedProviderRequests: Object.freeze({ npm: 1, osv: 0 }),
    lifecycleScripts: Object.freeze(["postinstall"]),
    name: "agenthawk-matrix-review",
    repository: true,
  }),
  block: Object.freeze({
    expectedMessage: "AgentHawk: Dependency policy evaluation blocked the request.",
    expectedProviderRequests: Object.freeze({ npm: 1, osv: 1 }),
    malicious: true,
    name: "agenthawk-matrix-block",
    repository: true,
  }),
  error: Object.freeze({
    expectedMessage: "AgentHawk: Dependency policy evaluation could not complete safely.",
    expectedProviderRequests: Object.freeze({ npm: 1, osv: 0 }),
    invalidNpmResponse: true,
    name: "agenthawk-matrix-error",
    repository: true,
  }),
});

function matrixError(code) {
  return new HostHarnessError(`cli_matrix_${code}`);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function percentile95(samples) {
  if (!Array.isArray(samples) || samples.length < 1 || samples.some((value) => value < 0)) {
    throw matrixError("performance_samples_invalid");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function roundedMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

async function timed(operation) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

export function validateCliToolSet(requestBody) {
  if (
    !Array.isArray(requestBody?.tools) ||
    requestBody.tools.length < 1 ||
    requestBody.tools.length > 64
  ) {
    throw matrixError("tool_set_invalid");
  }
  const names = requestBody.tools.map((tool) => (record(tool) ? tool.name : undefined));
  if (
    names.some((name) => typeof name !== "string" || name.length < 1 || name.length > 128) ||
    new Set(names).size !== names.length ||
    !names.includes("shell_command")
  ) {
    throw matrixError("tool_set_invalid");
  }
  for (const forbidden of ["exec_command", "write_stdin", "code_mode", "code_mode_execute"]) {
    if (names.includes(forbidden)) throw matrixError(`alternate_tool_exposed:${forbidden}`);
  }
  return Object.freeze([...names].sort());
}

export function validateScenarioFunctionOutput(rawOutput, scenarioName) {
  const scenario = MATRIX_SCENARIOS[scenarioName];
  if (!scenario) throw matrixError("scenario_unknown");
  const serialized = JSON.stringify(rawOutput);
  if (serialized.length > 16_384) throw matrixError("function_output_too_large");
  if (scenarioName === "allow") {
    if (serialized.toLowerCase().includes("agenthawk:")) {
      throw matrixError("allow_was_denied");
    }
    return "allowed";
  }
  if (!serialized.includes(scenario.expectedMessage)) {
    throw matrixError(`denial_reason_missing:${scenarioName}`);
  }
  return "denied";
}

export function matrixPolicy(scenarioName) {
  if (!MATRIX_SCENARIOS[scenarioName]) throw matrixError("scenario_unknown");
  const strictError = scenarioName === "error";
  const repositoryAction = scenarioName === "warn" ? "warn" : "allow";
  const lifecycleAction = scenarioName === "review" ? "review" : "allow";
  return [
    "version: 1",
    `mode: ${strictError ? "strict" : "review"}`,
    "defaults:",
    `  onProviderError: ${strictError ? "error" : "review"}`,
    "  onUnknownVersion: review",
    "  allowPrerelease: false",
    "registries:",
    "  npm:",
    "    enabled: true",
    "  osv:",
    `    enabled: ${scenarioName === "block" ? "true" : "false"}`,
    "rules:",
    "  packageAge:",
    "    minDays: 0",
    "    action: allow",
    "  releaseAge:",
    "    minHours: 0",
    "    action: allow",
    "  requireRepositoryUrl:",
    `    action: ${repositoryAction}`,
    "  deprecatedPackage:",
    "    action: allow",
    "  lifecycleScripts:",
    `    action: ${lifecycleAction}`,
    "    scripts:",
    "      - postinstall",
    "  similarToExistingDependency:",
    "    action: allow",
    "  knownMaliciousPackage:",
    "    action: block",
    "  vulnerabilities:",
    "    action: allow",
    "    severities:",
    "      - CRITICAL",
    "  nonRegistrySpecifier:",
    "    action: review",
    "approvals:",
    "  requireReason: true",
    "  requireExpiry: true",
    "  maxValidityDays: 180",
    "ci:",
    "  failOn:",
    "    - review",
    "    - block",
    "    - error",
    "",
  ].join("\n");
}

function npmPackument(scenario) {
  const version = {
    name: scenario.name,
    version: FIXTURE_VERSION,
    ...(scenario.repository
      ? { repository: { type: "git", url: `https://example.invalid/${scenario.name}.git` } }
      : {}),
    ...(scenario.lifecycleScripts
      ? { scripts: Object.fromEntries(scenario.lifecycleScripts.map((name) => [name, "refused"])) }
      : {}),
  };
  return {
    name: scenario.name,
    "dist-tags": { latest: FIXTURE_VERSION },
    versions: { [FIXTURE_VERSION]: version },
    time: { created: FIXTURE_TIMESTAMP, [FIXTURE_VERSION]: FIXTURE_TIMESTAMP },
  };
}

async function readProviderJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_PROVIDER_REQUEST_BYTES) throw matrixError("provider_request_too_large");
    chunks.push(chunk);
  }
  if (bytes === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw matrixError("provider_request_invalid_json");
  }
}

function selectedScenario(rawName) {
  return Object.values(MATRIX_SCENARIOS).find((scenario) => scenario.name === rawName);
}

export function createMatrixProviderServer() {
  const state = { error: undefined, firstRequestNanoseconds: undefined, npm: 0, osv: 0 };
  const server = createServer(async (request, response) => {
    try {
      state.firstRequestNanoseconds ??= process.hrtime.bigint();
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname.startsWith("/npm/")) {
        state.npm += 1;
        const name = decodeURIComponent(url.pathname.slice("/npm/".length));
        const scenario = selectedScenario(name);
        if (!scenario) throw matrixError("npm_package_unexpected");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(scenario.invalidNpmResponse ? { invalid: true } : npmPackument(scenario)),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/osv/v1/query") {
        state.osv += 1;
        const body = await readProviderJson(request);
        const name = body?.package?.name;
        const scenario = typeof name === "string" ? selectedScenario(name) : undefined;
        if (
          !scenario?.malicious ||
          body?.package?.ecosystem !== "npm" ||
          body?.version !== FIXTURE_VERSION
        ) {
          throw matrixError("osv_query_unexpected");
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            vulns: [
              {
                id: "MAL-2026-4242",
                modified: "2026-01-01T00:00:00Z",
                published: "2026-01-01T00:00:00Z",
                schema_version: "1.7.3",
                summary: "Deterministic AgentHawk fixture record.",
              },
            ],
          }),
        );
        return;
      }
      throw matrixError("provider_request_unexpected");
    } catch (error) {
      state.error =
        error instanceof HostHarnessError ? error : matrixError("provider_internal_error");
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"message":"fixture rejected request"}}');
    }
  });
  return { server, state };
}

async function assertAllowedCheck(checkNpmPackage, options, dependencies) {
  const result = await checkNpmPackage(
    `${MATRIX_SCENARIOS.allow.name}@${FIXTURE_VERSION}`,
    options,
    dependencies,
  );
  let report;
  try {
    report = JSON.parse(result.output);
  } catch {
    throw matrixError("performance_report_invalid");
  }
  if (result.exitCode !== 0 || report?.verdict !== "allow") {
    throw matrixError(
      `performance_verdict_changed:${String(result.exitCode)}:${typeof report?.verdict === "string" ? report.verdict : "unknown"}`,
    );
  }
}

async function measureControlledPerformance(root) {
  const [
    { MetadataCache, agentHawkConfigSchema, parseCachedNpmResult, qualifyCommand },
    { checkNpmPackage },
  ] = await Promise.all([
    import("../packages/core/dist/index.js"),
    import("../packages/cli/dist/check.js"),
  ]);
  const config = agentHawkConfigSchema.parse({
    registries: { osv: { enabled: false } },
    version: 1,
  });
  const now = () => new Date("2026-08-24T00:00:00.000Z");
  const commonDependencies = {
    now,
    readApprovals: async () => ({ approvals: [], version: 1 }),
    readPolicy: async () => config,
  };
  const unrelatedSamples = [];
  for (let index = 0; index < 100; index += 1) qualifyCommand("git status", "portable");
  for (let index = 0; index < 1_000; index += 1) {
    const started = performance.now();
    const qualification = qualifyCommand("git status", "portable");
    unrelatedSamples.push(performance.now() - started);
    if (qualification.category !== "unrelated") throw matrixError("performance_verdict_changed");
  }

  const cacheFixture = createMatrixProviderServer();
  const cacheUrl = await listenLoopback(cacheFixture.server);
  const cache = new MetadataCache({ root: join(root, "performance-cache"), now });
  const cacheOptions = {
    cwd: root,
    format: "json",
    registryUrl: new URL("/npm/", cacheUrl).href,
    strict: true,
  };
  try {
    await assertAllowedCheck(checkNpmPackage, cacheOptions, {
      ...commonDependencies,
      cache,
    });
    if (cacheFixture.state.error || cacheFixture.state.npm !== 1) {
      throw matrixError("performance_cache_warmup_invalid");
    }
    const cacheKey = JSON.stringify({
      name: MATRIX_SCENARIOS.allow.name,
      registry: cacheOptions.registryUrl,
      requestedSpec: FIXTURE_VERSION,
    });
    const cacheSamples = [];
    for (let index = 0; index < PERFORMANCE_SAMPLES; index += 1) {
      cacheSamples.push(
        await timed(async () => {
          const result = await cache.read("npm", cacheKey, parseCachedNpmResult);
          if (result.status !== "fresh" || !result.value.ok) {
            throw matrixError("performance_cache_hit_invalid");
          }
        }),
      );
    }
    if (cacheFixture.state.error || cacheFixture.state.npm !== 1) {
      throw matrixError("performance_cache_provider_request_observed");
    }

    const liveFixture = createMatrixProviderServer();
    const liveUrl = await listenLoopback(liveFixture.server);
    try {
      const liveOptions = {
        ...cacheOptions,
        noCache: true,
        registryUrl: new URL("/npm/", liveUrl).href,
      };
      const liveSamples = [];
      for (let index = 0; index < PERFORMANCE_SAMPLES; index += 1) {
        liveSamples.push(
          await timed(
            async () => await assertAllowedCheck(checkNpmPackage, liveOptions, commonDependencies),
          ),
        );
      }
      if (
        liveFixture.state.error ||
        liveFixture.state.npm !== PERFORMANCE_SAMPLES ||
        liveFixture.state.osv !== 0
      ) {
        throw matrixError("performance_live_request_count_invalid");
      }
      const measurements = {
        cacheHitP95Milliseconds: roundedMilliseconds(percentile95(cacheSamples)),
        liveEvidenceP95Milliseconds: roundedMilliseconds(percentile95(liveSamples)),
        samples: {
          cacheHit: cacheSamples.length,
          liveEvidence: liveSamples.length,
          unrelatedQualification: unrelatedSamples.length,
        },
        unrelatedQualificationP95Milliseconds: roundedMilliseconds(percentile95(unrelatedSamples)),
      };
      if (
        measurements.unrelatedQualificationP95Milliseconds >= 50 ||
        measurements.cacheHitP95Milliseconds >= 150 ||
        measurements.liveEvidenceP95Milliseconds >= 5_000
      ) {
        throw matrixError("performance_target_exceeded");
      }
      return measurements;
    } finally {
      await closeServer(liveFixture.server).catch(() => undefined);
    }
  } finally {
    await closeServer(cacheFixture.server).catch(() => undefined);
  }
}

async function replaceModelProvider(configPath, providerUrl) {
  const config = await readFile(configPath, "utf8");
  const replaced = config.replace(
    /base_url = '[^']+'/u,
    `base_url = '${providerUrl.href.replace(/\/$/u, "")}'`,
  );
  if (replaced === config) throw matrixError("model_provider_config_missing");
  await writeFile(configPath, replaced, "utf8");
}

async function markerAbsent(path, scenarioName) {
  try {
    await lstat(path);
    throw matrixError(`denied_marker_present:${scenarioName}`);
  } catch (error) {
    if (error instanceof HostHarnessError) throw error;
    if (error?.code !== "ENOENT") throw matrixError(`marker_check_failed:${scenarioName}`);
  }
}

async function allowedMarkerPresent(path, functionOutput) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw matrixError(`allow_marker_missing:${functionOutput ?? "missing"}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 10) {
    throw matrixError("allow_marker_invalid");
  }
  if ((await readFile(path, "utf8")) !== "executed\r\n") {
    throw matrixError("allow_marker_invalid");
  }
}

function scenarioCommand(scenario) {
  return `npm add ${scenario.name}@${FIXTURE_VERSION}`;
}

async function runCliScenario({
  codexEntry,
  codexHome,
  fakeBin,
  preloadEntry,
  repository,
  root,
  scenarioName,
}) {
  const scenario = MATRIX_SCENARIOS[scenarioName];
  if (!scenario) throw matrixError("scenario_unknown");
  const marker = join(repository, `agenthawk-${scenarioName}.marker`);
  await rm(marker, { force: true });
  await writeFile(join(repository, ".agenthawk.yml"), matrixPolicy(scenarioName), "utf8");
  await writeFile(
    join(fakeBin, "npm.cmd"),
    `@echo off\r\n> "%~dp0..\\agenthawk-${scenarioName}.marker" echo executed\r\nexit /b 0\r\n`,
    "utf8",
  );
  const providerFixture = createMatrixProviderServer();
  const providerUrl = await listenLoopback(providerFixture.server);
  let functionOutputNanoseconds;
  const modelFixture = createFixtureServer(scenarioCommand(scenario), "shell_command", {
    onFunctionOutput: () => {
      functionOutputNanoseconds = process.hrtime.bigint();
    },
    validateToolSet: validateCliToolSet,
  });
  const modelUrl = await listenLoopback(modelFixture.server);
  try {
    await replaceModelProvider(join(codexHome, "config.toml"), modelUrl);
    const environment = {
      ...minimalEnvironment(codexHome, root, fakeBin),
      AGENTHAWK_CODEX_PROVIDER_FIXTURE_URL: providerUrl.origin,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadEntry).href}`,
    };
    const result = await runBounded(
      codexEntry,
      [
        "--strict-config",
        "--cd",
        repository,
        "--sandbox",
        "workspace-write",
        "exec",
        "--json",
        "Run the single command supplied by the fixture, then stop.",
      ],
      { cwd: repository, env: environment },
    );
    if (modelFixture.state.error) throw modelFixture.state.error;
    if (providerFixture.state.error) throw providerFixture.state.error;
    if (result.code !== 0 || result.signal !== null)
      throw matrixError(`codex_failed:${scenarioName}`);
    if (modelFixture.state.requests !== 2) throw matrixError("model_request_count_mismatch");
    const expected = scenario.expectedProviderRequests;
    if (providerFixture.state.npm !== expected.npm || providerFixture.state.osv !== expected.osv) {
      throw matrixError(`provider_request_count_mismatch:${scenarioName}`);
    }
    validateScenarioFunctionOutput(modelFixture.state.functionOutputRaw, scenarioName);
    if (scenarioName === "allow") {
      await allowedMarkerPresent(marker, modelFixture.state.functionOutput);
    } else await markerAbsent(marker, scenarioName);
    if (!providerFixture.state.firstRequestNanoseconds || !functionOutputNanoseconds) {
      throw matrixError(`provider_timing_missing:${scenarioName}`);
    }
    const liveMilliseconds = Number(
      (functionOutputNanoseconds - providerFixture.state.firstRequestNanoseconds) / 1_000_000n,
    );
    if (liveMilliseconds < 0 || liveMilliseconds >= 5_000) {
      throw matrixError(
        `live_evidence_budget_exceeded:${scenarioName}:${String(liveMilliseconds)}`,
      );
    }
    return liveMilliseconds;
  } finally {
    await Promise.all([
      closeServer(modelFixture.server).catch(() => undefined),
      closeServer(providerFixture.server).catch(() => undefined),
    ]);
  }
}

async function runUnrelatedScenario({
  codexEntry,
  codexHome,
  expectAdministratorRejection = false,
  probeAdministratorRejection = false,
  fakeBin,
  preloadEntry,
  repository,
  root,
}) {
  const marker = join(repository, "agenthawk-neutral.marker");
  await rm(marker, { force: true });
  await writeFile(
    join(fakeBin, "agenthawk-neutral.cmd"),
    '@echo off\r\n> "%~dp0..\\agenthawk-neutral.marker" <nul set /p "=executed"\r\nexit /b 0\r\n',
    "utf8",
  );
  const providerFixture = createMatrixProviderServer();
  const providerUrl = await listenLoopback(providerFixture.server);
  const modelFixture = createFixtureServer("agenthawk-neutral.cmd", "shell_command", {
    validateToolSet: validateCliToolSet,
  });
  const modelUrl = await listenLoopback(modelFixture.server);
  try {
    await replaceModelProvider(join(codexHome, "config.toml"), modelUrl);
    const environment = {
      ...minimalEnvironment(codexHome, root, fakeBin),
      AGENTHAWK_CODEX_PROVIDER_FIXTURE_URL: providerUrl.origin,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadEntry).href}`,
    };
    const result = await runBounded(
      codexEntry,
      [
        "--strict-config",
        "--cd",
        repository,
        "--sandbox",
        "workspace-write",
        "exec",
        "--json",
        "Run the single command supplied by the fixture, then stop.",
      ],
      { cwd: repository, env: environment },
    );
    if (result.code !== 0 || result.signal !== null) throw matrixError("unrelated_codex_failed");
    if (modelFixture.state.error) throw modelFixture.state.error;
    if (modelFixture.state.requests !== 2) throw matrixError("model_request_count_mismatch");
    if (
      providerFixture.state.error ||
      providerFixture.state.npm !== 0 ||
      providerFixture.state.osv !== 0
    ) {
      throw matrixError("unrelated_provider_request_observed");
    }
    try {
      await verifyNeutralMarker(marker, "win32");
    } catch (error) {
      if (error instanceof HostHarnessError) {
        if (probeAdministratorRejection && error.code === "neutral_marker_missing") {
          return {
            rejectionProbe: describeFunctionOutputEvidence(
              {
                type: "function_call_output",
                call_id: "call-agenthawk",
                output: modelFixture.state.functionOutputRaw,
              },
              "call-agenthawk",
            ),
          };
        }
        if (
          expectAdministratorRejection &&
          modelFixture.state.functionOutput === "administrator_rejected"
        ) {
          return "administrator_rejected";
        }
        throw matrixError(
          `unrelated_marker_missing:${modelFixture.state.functionOutput ?? "missing"}`,
        );
      }
      throw error;
    }
    return "passed";
  } finally {
    await Promise.all([
      closeServer(modelFixture.server).catch(() => undefined),
      closeServer(providerFixture.server).catch(() => undefined),
    ]);
  }
}

async function verifyEmergencyDenial(adapterEntry, environment, repository) {
  const result = await runBounded(adapterEntry, [], {
    cwd: repository,
    env: environment,
    input: "{}\n",
    timeoutMs: 10_000,
  });
  if (
    result.code !== 2 ||
    result.signal !== null ||
    result.stdout !== "" ||
    result.stderr !== "AgentHawk denied the tool call because security evaluation failed.\n"
  ) {
    throw matrixError("emergency_denial_invalid");
  }
}

async function removeProjectHook(repository) {
  const { removeCodexProjectHook } = await import(
    "../packages/cli/dist/codex-project-hook-transaction.js"
  );
  const removal = await removeCodexProjectHook({ format: "json" }, { cwd: repository });
  const removalReport = JSON.parse(removal.output);
  if (
    removal.exitCode !== 0 ||
    removalReport?.command !== "integrations_codex_remove" ||
    removalReport?.ownership !== "absent" ||
    removalReport?.outcome !== "removed"
  ) {
    throw matrixError("project_hook_removal_invalid");
  }
}

export async function verifyCodexCliProjectMatrix({
  codexEntry,
  expectAdministratorRejection = false,
  probeAdministratorRejection = false,
}) {
  if (process.platform !== "win32") throw matrixError("windows_required");
  await access(codexEntry);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterEntry = join(projectRoot, "packages", "cli", "dist", "codex-pretooluse-entry.js");
  const preloadEntry = join(projectRoot, "scripts", "codex-provider-preload.mjs");
  await Promise.all([access(adapterEntry), access(preloadEntry)]);
  const version = await runBounded(codexEntry, ["--version"], {
    cwd: projectRoot,
    env: process.env,
    timeoutMs: 10_000,
  });
  assertExactVersion(version);
  const { parseStrictJson } = await import("../packages/cli/dist/hook-json.js");
  const prepared = await prepareTrustedProjectHookScenario({
    adapterEntry,
    codexEntry,
    parseJson: parseStrictJson,
  });
  const root = prepared.root;
  const repository = join(root, "repository");
  const codexHome = join(root, "codex-home");
  const fakeBin = join(repository, ".agenthawk-host-bin");
  try {
    const unrelated = await runUnrelatedScenario({
      codexEntry,
      codexHome,
      expectAdministratorRejection,
      probeAdministratorRejection,
      fakeBin,
      preloadEntry,
      repository,
      root,
    });
    if (typeof unrelated === "object" && unrelated !== null && "rejectionProbe" in unrelated) {
      await removeProjectHook(repository);
      return {
        schemaVersion: "1.0",
        host: "codex-cli-project-hook",
        version: EXPECTED_CODEX_VERSION,
        surface: "github-hosted-windows-administrator-probe",
        providerRequests: 0,
        removal: "passed",
        support: "unsupported",
        ...unrelated,
      };
    }
    if (unrelated === "administrator_rejected") {
      await removeProjectHook(repository);
      return {
        schemaVersion: "1.0",
        host: "codex-cli-project-hook",
        version: EXPECTED_CODEX_VERSION,
        surface: "github-hosted-windows-administrator",
        administratorBoundary: "rejected",
        providerRequests: 0,
        removal: "passed",
        support: "unsupported",
      };
    }
    if (expectAdministratorRejection) throw matrixError("administrator_rejection_missing");
    const liveEvidenceMilliseconds = {};
    for (const scenarioName of ["allow", "warn", "review", "block", "error"]) {
      liveEvidenceMilliseconds[scenarioName] = await runCliScenario({
        codexEntry,
        codexHome,
        fakeBin,
        preloadEntry,
        repository,
        root,
        scenarioName,
      });
    }
    await verifyEmergencyDenial(
      adapterEntry,
      minimalEnvironment(codexHome, root, fakeBin),
      repository,
    );
    const performance = await measureControlledPerformance(root);
    await removeProjectHook(repository);
    return {
      schemaVersion: "1.0",
      host: "codex-cli-project-hook",
      version: EXPECTED_CODEX_VERSION,
      surface: "local-cli-windows-shell-command-project",
      projectTrust: "exact-hash",
      unrelated: "passed",
      outcomes: {
        allow: "passed",
        warn: "passed",
        review: "passed",
        block: "passed",
        error: "passed",
      },
      emergencyDenial: "passed",
      performance,
      removal: "passed",
      liveEvidenceMilliseconds,
      isolation: "temporary-repository-codex-home-loopback-model-and-provider-fixtures",
    };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main() {
  try {
    const result = await verifyCodexCliProjectMatrix(parseMatrixArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof HostHarnessError ? error.code : "unexpected_failure";
    process.stderr.write(`AgentHawk Codex CLI project matrix failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
