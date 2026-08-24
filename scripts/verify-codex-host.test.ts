import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  assertLoopbackUrl,
  buildCodexConfig,
  closeServer,
  encodeSse,
  HostHarnessError,
  hookCommands,
  neutralScenarioPassed,
  parseArguments,
  runBounded,
  selectCommandTool,
  terminateChild,
} from "./verify-codex-host.mjs";

describe("Codex host hook command boundary", () => {
  it("uses inert PowerShell literals for adversarial absolute paths", () => {
    expect(
      hookCommands(
        "C:\\Program Files\\$runtime`$(ignored)\\node.exe",
        "C:\\fixture path\\owner's $hook`$(ignored).mjs",
      ),
    ).toEqual({
      posix:
        `'C:\\Program Files\\$runtime\`$(ignored)\\node.exe' ` +
        `'C:\\fixture path\\owner'"'"'s $hook\`$(ignored).mjs'`,
      windows:
        "& 'C:\\Program Files\\$runtime`$(ignored)\\node.exe' " +
        "'C:\\fixture path\\owner''s $hook`$(ignored).mjs'",
    });
  });
});

describe("Codex host sandbox configuration", () => {
  const providerUrl = new URL("http://127.0.0.1:4567/v1");

  it("activates the supported unelevated Windows sandbox without weakening policy", () => {
    const config = buildCodexConfig(providerUrl, "win32");
    expect(config).toContain('approval_policy = "never"\nsandbox_mode = "workspace-write"');
    expect(config).toContain(
      "[sandbox_workspace_write]\nnetwork_access = false\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true",
    );
    expect(config).toContain('[windows]\nsandbox = "unelevated"\n\n[features]');
    expect(config).toContain("unified_exec = false");
    expect(config).not.toMatch(
      /danger-full-access|writable_roots|network_access\s*=\s*true|sandbox_private_desktop\s*=\s*false/u,
    );
  });

  it("does not add Windows sandbox configuration on other platforms", () => {
    const config = buildCodexConfig(providerUrl, "linux");
    expect(config).not.toContain("[windows]");
    expect(config).toContain("exclude_tmpdir_env_var = true");
    expect(config).toContain("unified_exec = true");
  });
});

describe("Codex host neutral execution proof", () => {
  it("requires the Windows marker when shell output omits an exit status", () => {
    expect(neutralScenarioPassed("win32", "unknown", true)).toBe(true);
    expect(neutralScenarioPassed("win32", "unknown", false)).toBe(false);
    expect(neutralScenarioPassed("win32", "denied", true)).toBe(false);
    expect(neutralScenarioPassed("win32", "missing", true)).toBe(false);
  });

  it("retains explicit successful tool output on non-Windows platforms", () => {
    expect(neutralScenarioPassed("linux", "success", false)).toBe(true);
    expect(neutralScenarioPassed("linux", "unknown", true)).toBe(false);
  });
});

describe("Codex host process cleanup boundary", () => {
  it.skipIf(process.platform === "win32")(
    "terminates descendant processes when the host times out",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenthawk-host-process-test-"));
      const marker = join(root, "descendant-ran");
      const descendant = join(root, "descendant.mjs");
      const parent = join(root, "parent.mjs");
      try {
        await writeFile(
          descendant,
          `import { writeFileSync } from "node:fs"; setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "ran"), 800);`,
          "utf8",
        );
        await writeFile(
          parent,
          `import { spawn } from "node:child_process"; spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" }); setTimeout(() => {}, 10_000);`,
          "utf8",
        );
        const childEnvironment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              key !== "NODE_OPTIONS" && key !== "NODE_V8_COVERAGE" && !key.startsWith("VITEST"),
          ),
        );
        await expect(
          runBounded(process.execPath, [parent], {
            cwd: root,
            env: childEnvironment,
            timeoutMs: 200,
          }),
        ).rejects.toThrowError(new HostHarnessError("host_process_timeout"));
        await delay(1_000);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    5_000,
  );

  it.runIf(process.platform === "win32")(
    "terminates the Windows host process tree when the host times out",
    async () => {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
      if (!systemRoot) throw new Error("missing Windows system root");
      const root = await mkdtemp(join(tmpdir(), "agenthawk-host-windows-tree-test-"));
      const marker = join(root, "descendant-ran");
      const childScript = join(root, "descendant.ps1");
      const parentScript = join(root, "parent.ps1");
      const powershell = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const powerShellLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
      try {
        await writeFile(
          childScript,
          `Start-Sleep -Milliseconds 1200\nSet-Content -LiteralPath ${powerShellLiteral(marker)} -Value ran\n`,
          "utf8",
        );
        await writeFile(
          parentScript,
          `Start-Process -FilePath ${powerShellLiteral(powershell)} -ArgumentList @('-NoProfile', '-File', ${powerShellLiteral(childScript)}) -WindowStyle Hidden\nStart-Sleep -Seconds 10\n`,
          "utf8",
        );
        await expect(
          runBounded(powershell, ["-NoProfile", "-File", parentScript], {
            cwd: root,
            env: process.env,
            timeoutMs: 400,
          }),
        ).rejects.toThrowError(new HostHarnessError("host_process_timeout"));
        await delay(1_500);
        await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 3 });
      }
    },
    5_000,
  );

  it.runIf(process.platform === "win32")(
    "falls back to direct termination when taskkill exits unsuccessfully",
    async () => {
      const directKill = vi.fn(() => true);
      const fakeChild = { exitCode: null, signalCode: null, pid: 4242, kill: directKill };
      const spawnTreeKiller = vi.fn(() => {
        const killer = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
        queueMicrotask(() => killer.emit("close", 1, null));
        return killer;
      });
      await terminateChild(fakeChild, spawnTreeKiller);
      expect(spawnTreeKiller).toHaveBeenCalledWith(
        "taskkill",
        ["/pid", "4242", "/t", "/f"],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(directKill).toHaveBeenCalledOnce();
    },
  );

  it("closes active fixture connections without waiting indefinitely", async () => {
    const server = createServer((_request, _response) => {});
    await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const request = get(`http://127.0.0.1:${address.port}/`);
    request.on("error", () => {});
    await new Promise((resolveSocket) => request.once("socket", resolveSocket));
    await closeServer(server);
    request.destroy();
    expect(server.listening).toBe(false);
  });

  it("keeps the output-limit failure authoritative while terminating the host", async () => {
    await expect(
      runBounded(process.execPath, ["-e", 'process.stdout.write("x".repeat(200000))'], {
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrowError(new HostHarnessError("host_output_too_large"));
  });
});

describe("Codex host verification argument boundary", () => {
  it("accepts one absolute Codex entry", () => {
    const entry = process.platform === "win32" ? "C:\\fixture\\codex.js" : "/fixture/codex.js";
    expect(parseArguments(["--codex-entry", entry])).toEqual({ codexEntry: entry });
  });

  it.each([
    [[], "missing_argument:--codex-entry"],
    [["--codex-entry"], "missing_value:--codex-entry"],
    [["--codex-entry", "relative/codex.js"], "codex_entry_not_absolute"],
    [["--other"], "unknown_argument:--other"],
  ])("rejects malformed arguments", (argv, code) => {
    expect(() => parseArguments(argv)).toThrowError(new HostHarnessError(code));
  });
});

describe("Codex host verification provider boundary", () => {
  it.each(["http://127.0.0.1:4321/v1", "http://[::1]:4321/v1"])(
    "accepts an uncredentialed loopback provider",
    (url) => expect(assertLoopbackUrl(url).href).toBe(url),
  );

  it.each([
    ["https://127.0.0.1/v1", "provider_not_loopback"],
    ["http://localhost:4321/v1", "provider_not_loopback"],
    ["http://example.test/v1", "provider_not_loopback"],
    ["http://user:secret@127.0.0.1/v1", "provider_url_has_credentials"],
    ["not a url", "provider_url_invalid"],
  ])("rejects an unsafe provider URL", (url, code) => {
    expect(() => assertLoopbackUrl(url)).toThrowError(new HostHarnessError(code));
  });

  it("encodes fixture events as typed SSE records", () => {
    expect(encodeSse([{ type: "response.created", response: { id: "r1" } }])).toBe(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n',
    );
  });
});

describe("Codex host verification tool pin", () => {
  const request = { tools: [{ name: "exec_command" }, { name: "shell_command" }] };

  it("uses the pinned unified-exec shape", () => {
    expect(selectCommandTool(request, "git status", "exec_command")).toEqual({
      name: "exec_command",
      arguments: { cmd: "git status", tty: false, yield_time_ms: 10_000, login: false },
    });
  });

  it("uses the pinned Windows shell-command shape", () => {
    expect(selectCommandTool(request, "git status", "shell_command")).toEqual({
      name: "shell_command",
      arguments: { command: "git status", timeout_ms: 10_000, login: false },
    });
  });

  it("fails on missing host capability instead of switching tools", () => {
    expect(() => selectCommandTool({ tools: [] }, "git status", "shell_command")).toThrowError(
      new HostHarnessError("host_missing_tool:shell_command"),
    );
  });
});
