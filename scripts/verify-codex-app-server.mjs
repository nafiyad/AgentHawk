#!/usr/bin/env node

import { access, chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { spawnBoundedJsonl } from "./bounded-jsonl-process.mjs";
import {
  assertExactVersion,
  buildCodexConfig,
  closeServer,
  codexHostPlatform,
  createFixtureServer,
  EXPECTED_CODEX_VERSION,
  HostHarnessError,
  hookCommands,
  listenLoopback,
  minimalEnvironment,
  parseArguments,
  runBounded,
  verifyNeutralMarker,
} from "./verify-codex-host.mjs";

const EXPECTED_TAG_COMMIT = "758ef40f50c1a458425c7cfbf1eb12cbc07af0b0";
const PROMPT = "Run the single command supplied by the fixture, then stop.";

function appServerError(code) {
  return new HostHarnessError(`app_server_${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, code) {
  if (!isRecord(value)) throw appServerError(code);
  return value;
}

async function sameCanonicalPath(left, right) {
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)]);
    return process.platform === "win32"
      ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
      : canonicalLeft === canonicalRight;
  } catch {
    throw appServerError("path_verification_failed");
  }
}

export function appServerSurface(platform = process.platform) {
  const host = codexHostPlatform(platform);
  return `local-app-server-${platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux"}-stdio-${host.commandTool.replaceAll("_", "-")}`;
}

export function validateInitializeResponse(result, platform = process.platform) {
  const expectedPlatform =
    platform === "win32"
      ? { family: "windows", os: "windows" }
      : platform === "linux"
        ? { family: "unix", os: "linux" }
        : platform === "darwin"
          ? { family: "unix", os: "macos" }
          : undefined;
  if (!expectedPlatform) throw new HostHarnessError("host_platform_unsupported");
  const response = requireRecord(result, "initialize_invalid");
  if (
    typeof response.userAgent !== "string" ||
    !response.userAgent.includes(`/${EXPECTED_CODEX_VERSION}`) ||
    typeof response.codexHome !== "string" ||
    response.platformFamily !== expectedPlatform.family ||
    response.platformOs !== expectedPlatform.os
  ) {
    throw appServerError("initialize_invalid");
  }
  return response;
}

export function selectExpectedHook(result) {
  const response = requireRecord(result, "hooks_list_invalid");
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    throw appServerError("hooks_list_invalid");
  }
  const entry = requireRecord(response.data[0], "hooks_list_invalid");
  if (
    typeof entry.cwd !== "string" ||
    !Array.isArray(entry.errors) ||
    entry.errors.length !== 0 ||
    !Array.isArray(entry.warnings) ||
    entry.warnings.length !== 0 ||
    !Array.isArray(entry.hooks) ||
    entry.hooks.length !== 1
  ) {
    throw appServerError("hooks_list_invalid");
  }
  const hook = requireRecord(entry.hooks[0], "hook_invalid");
  if (
    hook.eventName !== "preToolUse" ||
    hook.handlerType !== "command" ||
    hook.async !== false ||
    hook.enabled !== true ||
    hook.source !== "user" ||
    hook.isManaged !== false ||
    hook.matcher !== "^Bash$" ||
    typeof hook.command !== "string" ||
    typeof hook.key !== "string" ||
    hook.key.length === 0 ||
    typeof hook.currentHash !== "string" ||
    hook.currentHash.length === 0 ||
    typeof hook.sourcePath !== "string" ||
    hook.timeoutSec !== 10
  ) {
    throw appServerError("hook_invalid");
  }
  return { cwd: entry.cwd, hook };
}

export function validateTrustedHook(before, after) {
  if (before.hook.trustStatus !== "untrusted") throw appServerError("hook_initial_trust_invalid");
  if (
    after.hook.key !== before.hook.key ||
    after.hook.currentHash !== before.hook.currentHash ||
    after.hook.sourcePath !== before.hook.sourcePath ||
    after.hook.command !== before.hook.command ||
    after.hook.trustStatus !== "trusted"
  ) {
    throw appServerError("hook_trust_invalid");
  }
}

export function validateThreadStart(result) {
  const response = requireRecord(result, "thread_start_invalid");
  const thread = requireRecord(response.thread, "thread_start_invalid");
  const sandbox = requireRecord(response.sandbox, "thread_start_invalid");
  if (
    response.model !== "agenthawk-fixture" ||
    response.modelProvider !== "agenthawk_loopback" ||
    response.approvalPolicy !== "never" ||
    typeof response.cwd !== "string" ||
    typeof thread.id !== "string" ||
    thread.id.length === 0 ||
    sandbox.type !== "workspaceWrite" ||
    sandbox.networkAccess !== false ||
    sandbox.excludeTmpdirEnvVar !== true ||
    sandbox.excludeSlashTmp !== true ||
    !Array.isArray(sandbox.writableRoots) ||
    sandbox.writableRoots.length !== 0
  ) {
    throw appServerError("thread_start_invalid");
  }
  return { cwd: response.cwd, threadId: thread.id };
}

function validateTurnStart(result) {
  const response = requireRecord(result, "turn_start_invalid");
  const turn = requireRecord(response.turn, "turn_start_invalid");
  if (typeof turn.id !== "string" || turn.id.length === 0 || turn.status !== "inProgress") {
    throw appServerError("turn_start_invalid");
  }
  return turn.id;
}

export function matchesHookNotification(params, threadId, turnId, status, runId) {
  if (!isRecord(params) || params.threadId !== threadId || params.turnId !== turnId) return false;
  const run = params.run;
  if (!isRecord(run)) return false;
  return (
    run.eventName === "preToolUse" &&
    run.executionMode === "sync" &&
    run.handlerType === "command" &&
    run.status === status &&
    typeof run.id === "string" &&
    run.id.length > 0 &&
    (runId === undefined || run.id === runId)
  );
}

export function validateHookNotification(params, threadId, turnId, status, runId) {
  if (!matchesHookNotification(params, threadId, turnId, status, runId)) {
    throw appServerError("hook_notification_invalid");
  }
  const run = params.run;
  if (
    run.scope !== "turn" ||
    run.source !== "user" ||
    typeof run.sourcePath !== "string" ||
    !Array.isArray(run.entries) ||
    run.entries.some(
      (entry) =>
        !isRecord(entry) ||
        !["warning", "stop", "feedback", "context", "error"].includes(entry.kind) ||
        typeof entry.text !== "string",
    ) ||
    (status === "completed" &&
      run.entries.some((entry) => entry.kind === "stop" || entry.kind === "error"))
  ) {
    throw appServerError("hook_notification_invalid");
  }
  return run;
}

function validateTurnCompleted(params, threadId, turnId) {
  const notification = requireRecord(params, "turn_completion_invalid");
  const turn = requireRecord(notification.turn, "turn_completion_invalid");
  if (
    notification.threadId !== threadId ||
    turn.id !== turnId ||
    !["completed", "failed", "interrupted"].includes(turn.status)
  ) {
    throw appServerError("turn_completion_invalid");
  }
  return turn.status;
}

async function assertAbsent(path) {
  try {
    await lstat(path);
    throw appServerError("denied_command_executed");
  } catch (error) {
    if (error instanceof HostHarnessError) throw error;
    if (error?.code !== "ENOENT") throw appServerError("denied_marker_check_failed");
  }
}

async function configureScenario(root, providerUrl, adapterEntry) {
  const codexHome = join(root, "codex-home");
  const repository = join(root, "repository");
  const fakeBin = join(repository, ".agenthawk-host-bin");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repository, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  const hookCommand = hookCommands(process.execPath, adapterEntry);
  const hooksPath = join(codexHome, "hooks.json");
  await writeFile(
    hooksPath,
    `${JSON.stringify(
      {
        description: "Ephemeral AgentHawk app-server compatibility harness.",
        hooks: {
          PreToolUse: [
            {
              matcher: "^Bash$",
              hooks: [
                {
                  type: "command",
                  command: hookCommand.posix,
                  commandWindows: hookCommand.windows,
                  timeout: 10,
                  statusMessage: "Evaluating dependency action",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(codexHome, "config.toml"), buildCodexConfig(providerUrl), "utf8");
  await writeFile(join(repository, ".agenthawk.yml"), "version: 1\nmode: review\n", "utf8");
  await writeFile(
    join(repository, "package.json"),
    '{"name":"agenthawk-app-server-fixture","private":true}\n',
    "utf8",
  );
  if (process.platform === "win32") {
    await writeFile(
      join(fakeBin, "npm.cmd"),
      '@echo off\r\n> "%~dp0..\\denied.marker" echo executed\r\nexit /b 0\r\n',
      "utf8",
    );
  } else {
    const fakeNpm = join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      '#!/bin/sh\nprintf executed > "$(dirname "$0")/../denied.marker"\n',
      "utf8",
    );
    await chmod(fakeNpm, 0o700);
  }
  const environment = minimalEnvironment(codexHome, root, fakeBin);
  const git = await runBounded("git", ["init", "--quiet"], {
    cwd: repository,
    env: environment,
    timeoutMs: 10_000,
  });
  if (git.code !== 0 || git.signal !== null) throw appServerError("fixture_git_init_failed");
  return {
    codexHome,
    environment,
    expectedHookCommand: process.platform === "win32" ? hookCommand.windows : hookCommand.posix,
    fakeBin,
    hooksPath,
    repository,
  };
}

async function runScenario({ codexEntry, adapterEntry, scenario, expectedStatus, parseJson }) {
  const root = await mkdtemp(join(tmpdir(), "agenthawk-codex-app-server-"));
  const platform = codexHostPlatform();
  const deniedExecutable = join(
    root,
    "repository",
    ".agenthawk-host-bin",
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  const command =
    scenario === "neutral"
      ? platform.neutralCommand
      : `${deniedExecutable} add agenthawk-app-server-denied`;
  const fixture = createFixtureServer(command, codexHostPlatform().commandTool);
  const providerUrl = await listenLoopback(fixture.server);
  let client;
  let succeeded = false;
  try {
    const configured = await configureScenario(root, providerUrl, adapterEntry);
    client = spawnBoundedJsonl(
      codexEntry,
      ["--strict-config", "app-server", "--listen", "stdio://"],
      {
        cwd: configured.repository,
        env: configured.environment,
        parseJson,
      },
    );
    const initialized = validateInitializeResponse(
      await client.request("agenthawk-initialize", "initialize", {
        clientInfo: {
          name: "agenthawk_test",
          title: "AgentHawk compatibility harness",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: false },
      }),
    );
    if (!(await sameCanonicalPath(initialized.codexHome, configured.codexHome))) {
      throw appServerError("codex_home_mismatch");
    }
    await client.notify("initialized");
    const before = selectExpectedHook(
      await client.request("agenthawk-hooks-before", "hooks/list", {
        cwds: [configured.repository],
      }),
    );
    if (
      !(await sameCanonicalPath(before.cwd, configured.repository)) ||
      !(await sameCanonicalPath(before.hook.sourcePath, configured.hooksPath)) ||
      before.hook.command !== configured.expectedHookCommand
    ) {
      throw appServerError("hook_path_mismatch");
    }
    const writeResponse = requireRecord(
      await client.request("agenthawk-hook-trust", "config/batchWrite", {
        edits: [
          {
            keyPath: "hooks.state",
            value: { [before.hook.key]: { trusted_hash: before.hook.currentHash } },
            mergeStrategy: "upsert",
          },
        ],
        reloadUserConfig: true,
      }),
      "hook_trust_write_invalid",
    );
    if (
      typeof writeResponse.filePath !== "string" ||
      typeof writeResponse.version !== "string" ||
      writeResponse.version.length === 0 ||
      !["ok", "okOverridden"].includes(writeResponse.status) ||
      !(await sameCanonicalPath(writeResponse.filePath, join(configured.codexHome, "config.toml")))
    ) {
      throw appServerError("hook_trust_write_invalid");
    }
    const after = selectExpectedHook(
      await client.request("agenthawk-hooks-after", "hooks/list", {
        cwds: [configured.repository],
      }),
    );
    validateTrustedHook(before, after);
    const thread = validateThreadStart(
      await client.request("agenthawk-thread-start", "thread/start", {
        model: "agenthawk-fixture",
        modelProvider: "agenthawk_loopback",
        cwd: configured.repository,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        ephemeral: true,
      }),
    );
    if (!(await sameCanonicalPath(thread.cwd, configured.repository))) {
      throw appServerError("thread_cwd_mismatch");
    }
    const turnId = validateTurnStart(
      await client.request("agenthawk-turn-start", "turn/start", {
        threadId: thread.threadId,
        input: [{ type: "text", text: PROMPT }],
      }),
    );
    const startedNotification = await client.waitForNotification("hook/started", (params) =>
      matchesHookNotification(params, thread.threadId, turnId, "running"),
    );
    const started = validateHookNotification(
      startedNotification,
      thread.threadId,
      turnId,
      "running",
    );
    if (!(await sameCanonicalPath(started.sourcePath, configured.hooksPath))) {
      throw appServerError("hook_path_mismatch");
    }
    const completedNotification = await client.waitForNotification("hook/completed", (params) =>
      matchesHookNotification(params, thread.threadId, turnId, expectedStatus, started.id),
    );
    const completed = validateHookNotification(
      completedNotification,
      thread.threadId,
      turnId,
      expectedStatus,
      started.id,
    );
    if (!(await sameCanonicalPath(completed.sourcePath, configured.hooksPath))) {
      throw appServerError("hook_path_mismatch");
    }
    const completion = await client.waitForNotification(
      "turn/completed",
      (params) => params?.threadId === thread.threadId && params?.turn?.id === turnId,
    );
    if (validateTurnCompleted(completion, thread.threadId, turnId) !== "completed") {
      throw appServerError("turn_failed");
    }
    await client.close();
    client = undefined;
    if (fixture.state.error) throw fixture.state.error;
    if (fixture.state.requests !== 2) throw appServerError("provider_request_count_mismatch");
    succeeded = true;
    return {
      functionOutput: fixture.state.functionOutput,
      neutralMarker: join(configured.repository, "agenthawk-neutral.marker"),
      deniedMarker: join(configured.repository, "denied.marker"),
      root,
    };
  } finally {
    if (client) await client.abort();
    let serverClosed = false;
    try {
      await closeServer(fixture.server);
      serverClosed = true;
    } finally {
      if (!succeeded || !serverClosed) {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
}

export async function verifyCodexAppServer({ codexEntry }) {
  codexHostPlatform();
  await access(codexEntry);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterEntry = join(projectRoot, "packages", "cli", "dist", "codex-pretooluse-entry.js");
  await access(adapterEntry);
  const { parseStrictJson } = await import("../packages/cli/dist/hook-json.js");
  const versionRoot = await mkdtemp(join(tmpdir(), "agenthawk-codex-app-server-version-"));
  try {
    const version = await runBounded(codexEntry, ["--version"], {
      cwd: versionRoot,
      env: minimalEnvironment(versionRoot, versionRoot, versionRoot),
      timeoutMs: 10_000,
    });
    assertExactVersion(version);
  } finally {
    await rm(versionRoot, { recursive: true, force: true, maxRetries: 3 });
  }
  let neutralRoot;
  let deniedRoot;
  try {
    const neutral = await runScenario({
      codexEntry,
      adapterEntry,
      scenario: "neutral",
      expectedStatus: "completed",
      parseJson: parseStrictJson,
    });
    neutralRoot = neutral.root;
    const neutralMarkerVerified = await verifyNeutralMarker(neutral.neutralMarker);
    if (!neutralMarkerVerified || !["success", "unknown"].includes(neutral.functionOutput)) {
      throw appServerError("neutral_command_failed");
    }
    const denied = await runScenario({
      codexEntry,
      adapterEntry,
      scenario: "denied",
      expectedStatus: "blocked",
      parseJson: parseStrictJson,
    });
    deniedRoot = denied.root;
    if (denied.functionOutput !== "denied") throw appServerError("denial_not_observed");
    await assertAbsent(denied.deniedMarker);
    return {
      schemaVersion: "1.0",
      host: "codex-app-server",
      version: EXPECTED_CODEX_VERSION,
      sourceCommit: EXPECTED_TAG_COMMIT,
      surface: appServerSurface(),
      neutral: "passed",
      denial: "passed",
      isolation: "per-scenario-temporary-codex-home-loopback-provider",
    };
  } finally {
    for (const root of [neutralRoot, deniedRoot]) {
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

async function main() {
  try {
    const result = await verifyCodexAppServer(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof HostHarnessError ? error.code : "unexpected_failure";
    process.stderr.write(`AgentHawk Codex app-server verification failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
