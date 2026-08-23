#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_CODEX_VERSION = "0.149.0";
const MAX_CAPTURE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const CHILD_TIMEOUT_MS = 45_000;
const SERVER_CLOSE_TIMEOUT_MS = 2_000;
const TREE_KILL_TIMEOUT_MS = 5_000;

export class HostHarnessError extends Error {
  constructor(code) {
    super(code);
    this.name = "HostHarnessError";
    this.code = code;
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new HostHarnessError(`missing_value:${flag}`);
  }
  return value;
}

export function parseArguments(argv) {
  let codexEntry;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex-entry") {
      codexEntry = requireValue(argv, index, argument);
      index += 1;
      continue;
    }
    throw new HostHarnessError(`unknown_argument:${argument}`);
  }
  if (!codexEntry) {
    throw new HostHarnessError("missing_argument:--codex-entry");
  }
  if (!isAbsolute(codexEntry)) {
    throw new HostHarnessError("codex_entry_not_absolute");
  }
  return { codexEntry: resolve(codexEntry) };
}

export function assertLoopbackUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HostHarnessError("provider_url_invalid");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new HostHarnessError("provider_not_loopback");
  }
  if (url.username || url.password) {
    throw new HostHarnessError("provider_url_has_credentials");
  }
  return url;
}

function tomlLiteral(value) {
  if (value.includes("'")) {
    throw new HostHarnessError("temporary_path_not_toml_safe");
  }
  return `'${value}'`;
}

function quotePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosixArgument(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function hookCommands(executable, script) {
  return {
    posix: `${quotePosixArgument(executable)} ${quotePosixArgument(script)}`,
    windows: `& ${quotePowerShellLiteral(executable)} ${quotePowerShellLiteral(script)}`,
  };
}

export function encodeSse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function responseCreated(id) {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function functionCall(callId, name, args) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(args),
    },
  };
}

function assistantMessage(id, text) {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }],
    },
  };
}

export function selectCommandTool(requestBody, command, expectedTool) {
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  const names = new Set(tools.map((tool) => tool?.name).filter((name) => typeof name === "string"));
  if (!names.has(expectedTool)) throw new HostHarnessError(`host_missing_tool:${expectedTool}`);
  if (expectedTool === "shell_command") {
    return {
      name: "shell_command",
      arguments: { command, timeout_ms: 10_000, login: false },
    };
  }
  return {
    name: "exec_command",
    arguments: { cmd: command, tty: false, yield_time_ms: 10_000, login: false },
  };
}

function containsFunctionOutput(value, callId) {
  if (Array.isArray(value)) return value.some((item) => containsFunctionOutput(item, callId));
  if (!value || typeof value !== "object") return false;
  if (value.type === "function_call_output" && value.call_id === callId) return true;
  return Object.values(value).some((item) => containsFunctionOutput(item, callId));
}

function findFunctionOutput(value, callId) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFunctionOutput(item, callId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  if (value.type === "function_call_output" && value.call_id === callId) return value.output;
  for (const item of Object.values(value)) {
    const found = findFunctionOutput(item, callId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function classifyFunctionOutput(value, callId) {
  const output = findFunctionOutput(value, callId);
  if (output === undefined) return "missing";
  const serialized = JSON.stringify(output).toLowerCase();
  if (serialized.includes("agenthawk:")) return "denied";
  if (serialized.includes("blocked by policy")) return "sandbox_rejected";
  if (serialized.includes("not recognized") || serialized.includes("not found")) return "not_found";
  if (
    serialized.includes('"exit_code":0') ||
    serialized.includes('"exit code":0') ||
    serialized.includes("process exited with code 0")
  )
    return "success";
  return "unknown";
}

export function neutralScenarioPassed(platform, functionOutput, markerVerified) {
  if (platform !== "win32") return functionOutput === "success";
  return markerVerified && (functionOutput === "success" || functionOutput === "unknown");
}

async function readBoundedJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HostHarnessError("provider_request_too_large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HostHarnessError("provider_request_invalid_json");
  }
}

function createFixtureServer(command, expectedTool) {
  const state = { requests: 0, error: undefined };
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        throw new HostHarnessError("provider_unexpected_request");
      }
      state.requests += 1;
      const body = await readBoundedJson(request);
      let events;
      if (state.requests === 1) {
        const selected = selectCommandTool(body, command, expectedTool);
        events = [
          responseCreated("resp-agenthawk-call"),
          functionCall("call-agenthawk", selected.name, selected.arguments),
          responseCompleted("resp-agenthawk-call"),
        ];
      } else if (state.requests === 2) {
        if (!containsFunctionOutput(body, "call-agenthawk")) {
          throw new HostHarnessError("provider_missing_function_output");
        }
        state.functionOutput = classifyFunctionOutput(body, "call-agenthawk");
        events = [
          responseCreated("resp-agenthawk-finished"),
          assistantMessage("msg-agenthawk-finished", "fixture complete"),
          responseCompleted("resp-agenthawk-finished"),
        ];
      } else {
        throw new HostHarnessError("provider_too_many_requests");
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      response.end(encodeSse(events));
    } catch (error) {
      state.error =
        error instanceof HostHarnessError ? error : new HostHarnessError("provider_internal_error");
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"message":"fixture rejected request"}}');
    }
  });
  return { server, state };
}

async function listenLoopback(server) {
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new HostHarnessError("provider_address_unavailable");
  }
  return assertLoopbackUrl(`http://127.0.0.1:${address.port}/v1`);
}

export async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => rejectClose(new HostHarnessError("provider_close_timeout"))),
      SERVER_CLOSE_TIMEOUT_MS,
    );
    timer.unref();
    server.close((error) =>
      finish(() =>
        error ? rejectClose(new HostHarnessError("provider_close_failed")) : resolveClose(),
      ),
    );
    server.closeAllConnections();
  });
}

function minimalEnvironment(codexHome, taskRoot, fakeBin) {
  const environment = {
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "dumb",
    TEMP: taskRoot,
    TMP: taskRoot,
    USERPROFILE: taskRoot,
  };
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec"]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  const pathKey = Object.hasOwn(environment, "Path") ? "Path" : "PATH";
  environment[pathKey] = `${fakeBin}${delimiter}${environment[pathKey] ?? ""}`;
  return environment;
}

function commandForEntry(entry, args) {
  if ([".js", ".mjs", ".cjs"].some((extension) => entry.toLowerCase().endsWith(extension))) {
    return { file: process.execPath, args: [entry, ...args] };
  }
  return { file: entry, args };
}

export async function terminateChild(child, spawnTreeKiller = spawn) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid) {
    const treeKillCompleted = await new Promise((resolveKill) => {
      const killer = spawnTreeKiller("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (completed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveKill(completed);
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(false);
      }, TREE_KILL_TIMEOUT_MS);
      timer.unref();
      killer.once("close", (code, signal) => finish(code === 0 && signal === null));
      killer.once("error", () => finish(false));
    });
    if (!treeKillCompleted && child.exitCode === null && child.signalCode === null) child.kill();
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child when the process group has already exited.
    }
  }
  child.kill("SIGKILL");
}

export async function runBounded(entry, args, options) {
  const command = commandForEntry(entry, args);
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.file, command.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: [], stderr: [], bytes: 0 };
    let settled = false;
    let terminating = false;
    let timer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const capture = (target) => (chunk) => {
      output.bytes += chunk.length;
      if (output.bytes > MAX_CAPTURE_BYTES) {
        if (terminating) return;
        terminating = true;
        void terminateChild(child).then(() =>
          finish(() => rejectRun(new HostHarnessError("host_output_too_large"))),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(output.stdout));
    child.stderr.on("data", capture(output.stderr));
    child.once("error", () => {
      if (!terminating) finish(() => rejectRun(new HostHarnessError("host_process_start_failed")));
    });
    child.once("close", (code, signal) => {
      if (!terminating) {
        finish(() =>
          resolveRun({
            code,
            signal,
            stdout: Buffer.concat(output.stdout).toString("utf8"),
            stderr: Buffer.concat(output.stderr).toString("utf8"),
          }),
        );
      }
    });
    timer = setTimeout(() => {
      if (terminating) return;
      terminating = true;
      void terminateChild(child).then(() =>
        finish(() => rejectRun(new HostHarnessError("host_process_timeout"))),
      );
    }, options.timeoutMs ?? CHILD_TIMEOUT_MS);
    timer.unref();
  });
}

function assertExactVersion(result) {
  if (result.code !== 0 || result.signal !== null) {
    throw new HostHarnessError("codex_version_failed");
  }
  const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/u.exec(result.stdout.trim());
  if (!match || match[1] !== EXPECTED_CODEX_VERSION) {
    throw new HostHarnessError("codex_version_mismatch");
  }
}

export function buildCodexConfig(providerUrl, platform = process.platform) {
  return [
    'model = "agenthawk-fixture"',
    'model_provider = "agenthawk_loopback"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    "",
    "[shell_environment_policy]",
    'inherit = "all"',
    "",
    "[model_providers.agenthawk_loopback]",
    'name = "AgentHawk loopback fixture"',
    `base_url = ${tomlLiteral(providerUrl.href.replace(/\/$/u, ""))}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "stream_idle_timeout_ms = 5000",
    "",
    ...(platform === "win32" ? ["[windows]", 'sandbox = "unelevated"', ""] : []),
    "[features]",
    "hooks = true",
    `unified_exec = ${platform === "win32" ? "false" : "true"}`,
    "",
  ].join("\n");
}

async function configureFixture(
  taskRoot,
  codexHome,
  repository,
  providerUrl,
  adapterEntry,
  fakeBin,
) {
  const node = process.execPath;
  const probeEntry = join(fakeBin, "hook-probe.mjs");
  const probeCommands = hookCommands(node, probeEntry);
  const adapterCommands = hookCommands(node, adapterEntry);
  const hook = {
    description: "Ephemeral AgentHawk real-host compatibility harness.",
    hooks: {
      SessionStart: [
        {
          matcher: "^startup$",
          hooks: [
            {
              type: "command",
              command: probeCommands.posix,
              commandWindows: probeCommands.windows,
              timeout: 10,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "^Bash$",
          hooks: [
            {
              type: "command",
              command: adapterCommands.posix,
              commandWindows: adapterCommands.windows,
              timeout: 10,
              statusMessage: "Evaluating dependency action",
            },
          ],
        },
      ],
    },
  };
  await writeFile(join(codexHome, "hooks.json"), `${JSON.stringify(hook, null, 2)}\n`, "utf8");
  await writeFile(
    probeEntry,
    'import { writeFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nwriteFileSync(fileURLToPath(new URL("../hook-probe.marker", import.meta.url)), "started");\n',
    "utf8",
  );
  const config = buildCodexConfig(providerUrl);
  await writeFile(join(codexHome, "config.toml"), config, "utf8");
  await writeFile(join(repository, ".agenthawk.yml"), "version: 1\nmode: review\n", "utf8");
  await writeFile(
    join(repository, "package.json"),
    '{"name":"agenthawk-host-fixture","private":true}\n',
    "utf8",
  );
  const git = await runBounded("git", ["init", "--quiet"], {
    cwd: repository,
    env: minimalEnvironment(codexHome, taskRoot, fakeBin),
    timeoutMs: 10_000,
  });
  if (git.code !== 0) {
    throw new HostHarnessError("fixture_git_init_failed");
  }
}

async function runScenario({ codexEntry, codexHome, repository, taskRoot, fakeBin, command }) {
  const fixture = createFixtureServer(
    command,
    process.platform === "win32" ? "shell_command" : "exec_command",
  );
  const providerUrl = await listenLoopback(fixture.server);
  try {
    const configPath = join(codexHome, "config.toml");
    const config = await readFile(configPath, "utf8");
    await writeFile(
      configPath,
      config.replace(
        /base_url = '[^']+'/u,
        `base_url = ${tomlLiteral(providerUrl.href.replace(/\/$/u, ""))}`,
      ),
      "utf8",
    );
    const result = await runBounded(
      codexEntry,
      [
        "--dangerously-bypass-hook-trust",
        "--strict-config",
        "--cd",
        repository,
        "--sandbox",
        "workspace-write",
        "exec",
        "--json",
        "Run the single command supplied by the fixture, then stop.",
      ],
      {
        cwd: repository,
        env: minimalEnvironment(codexHome, taskRoot, fakeBin),
      },
    );
    if (fixture.state.error) throw fixture.state.error;
    if (fixture.state.requests !== 2) throw new HostHarnessError("provider_request_count_mismatch");
    if (result.code !== 0 || result.signal !== null)
      throw new HostHarnessError("codex_scenario_failed");
    return fixture.state.functionOutput;
  } finally {
    await closeServer(fixture.server);
  }
}

export async function verifyCodexHost({ codexEntry }) {
  await access(codexEntry);
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterEntry = join(projectRoot, "packages", "cli", "dist", "codex-pretooluse-entry.js");
  await access(adapterEntry);
  const taskRoot = await mkdtemp(join(tmpdir(), "agenthawk-codex-host-"));
  const codexHome = join(taskRoot, "codex-home");
  const repository = join(taskRoot, "repository");
  const deniedMarker = join(repository, "denied.marker");
  const neutralMarker = join(repository, "agenthawk-neutral.marker");
  const hookProbeMarker = join(repository, "hook-probe.marker");
  const fakeBin = join(repository, ".agenthawk-host-bin");
  try {
    await mkdir(codexHome, { recursive: true });
    await mkdir(repository, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
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
    const environment = minimalEnvironment(codexHome, taskRoot, fakeBin);
    const version = await runBounded(codexEntry, ["--version"], {
      cwd: repository,
      env: environment,
      timeoutMs: 10_000,
    });
    assertExactVersion(version);
    await configureFixture(
      taskRoot,
      codexHome,
      repository,
      new URL("http://127.0.0.1:1/v1"),
      adapterEntry,
      fakeBin,
    );
    const neutralCommand =
      process.platform === "win32"
        ? "Set-Content -LiteralPath agenthawk-neutral.marker -Value executed"
        : "/usr/bin/true";
    const neutralOutput = await runScenario({
      codexEntry,
      codexHome,
      repository,
      taskRoot,
      fakeBin,
      command: neutralCommand,
    });
    let neutralMarkerVerified = false;
    try {
      await access(hookProbeMarker);
    } catch {
      throw new HostHarnessError("host_did_not_run_session_hook");
    }
    if (process.platform === "win32") {
      try {
        const neutralMarkerContents = await readFile(neutralMarker, "utf8");
        if (neutralMarkerContents.trim() !== "executed") {
          throw new HostHarnessError("neutral_marker_invalid");
        }
        neutralMarkerVerified = true;
      } catch (error) {
        if (error instanceof HostHarnessError) throw error;
        throw new HostHarnessError("neutral_marker_missing");
      }
    }
    const deniedExecutable = join(fakeBin, process.platform === "win32" ? "npm.cmd" : "npm");
    const deniedCommand = `${deniedExecutable} add agenthawk-host-denied`;
    const deniedOutput = await runScenario({
      codexEntry,
      codexHome,
      repository,
      taskRoot,
      fakeBin,
      command: deniedCommand,
    });
    if (deniedOutput !== "denied")
      throw new HostHarnessError(`denial_not_observed:${deniedOutput}`);
    try {
      await access(deniedMarker);
      throw new HostHarnessError("denied_command_executed");
    } catch (error) {
      if (error instanceof HostHarnessError) throw error;
      if (error?.code !== "ENOENT") throw new HostHarnessError("denied_marker_check_failed");
    }
    if (!neutralScenarioPassed(process.platform, neutralOutput, neutralMarkerVerified))
      throw new HostHarnessError(`neutral_command_failed:${neutralOutput}:denial_passed`);
    return {
      schemaVersion: "1.0",
      host: "codex-cli",
      version: EXPECTED_CODEX_VERSION,
      surface:
        process.platform === "win32" ? "local-exec-windows-shell-command" : "local-exec-unified",
      neutral: "passed",
      denial: "passed",
      isolation: "temporary-codex-home-loopback-provider",
    };
  } finally {
    await rm(taskRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main() {
  try {
    const result = await verifyCodexHost(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof HostHarnessError ? error.code : "unexpected_failure";
    process.stderr.write(`AgentHawk Codex host verification failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
