import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";

import {
  assertLoopbackUrl,
  buildCodexConfig,
  classifyFunctionOutput,
  closeServer,
  codexHostPlatform,
  encodeSse,
  HostHarnessError,
  hookCommands,
  minimalEnvironment,
  neutralScenarioPassed,
  parseArguments,
  runBounded,
  selectCommandTool,
  terminateChild,
  verifyNeutralMarker,
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

  it("can disable only the hooks feature for the activation boundary test", () => {
    const config = buildCodexConfig(providerUrl, "win32", false);
    expect(config).toContain("hooks = false");
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain("network_access = false");
  });

  it("rejects an unknown platform instead of inheriting Unix behavior", () => {
    expect(() => buildCodexConfig(providerUrl, "aix")).toThrowError(
      new HostHarnessError("host_platform_unsupported"),
    );
  });
});

describe("Codex host neutral execution proof", () => {
  it("requires the Windows marker when shell output omits an exit status", () => {
    expect(neutralScenarioPassed("unknown", true)).toBe(true);
    expect(neutralScenarioPassed("unknown", false)).toBe(false);
    expect(neutralScenarioPassed("denied", true)).toBe(false);
    expect(neutralScenarioPassed("missing", true)).toBe(false);
  });

  it("requires a marker even when the host reports successful tool output", () => {
    expect(neutralScenarioPassed("success", true)).toBe(true);
    expect(neutralScenarioPassed("success", false)).toBe(false);
  });

  it("names each tested platform and command surface exactly", () => {
    expect(codexHostPlatform("win32")).toMatchObject({
      commandTool: "shell_command",
      surface: "local-cli-windows-shell-command",
    });
    expect(codexHostPlatform("linux")).toMatchObject({
      commandTool: "exec_command",
      surface: "local-cli-linux-unified-exec",
    });
    expect(codexHostPlatform("darwin")).toMatchObject({
      commandTool: "exec_command",
      surface: "local-cli-macos-unified-exec",
    });
    expect(() => codexHostPlatform("freebsd")).toThrowError(
      new HostHarnessError("host_platform_unsupported"),
    );
  });

  it("accepts only the exact regular marker shape for each platform", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-neutral-marker-test-"));
    try {
      const linuxMarker = join(root, "linux-marker");
      const windowsMarker = join(root, "windows-marker");
      await writeFile(linuxMarker, "");
      await writeFile(windowsMarker, "executed");
      await expect(verifyNeutralMarker(linuxMarker, "linux")).resolves.toBe(true);
      await expect(verifyNeutralMarker(windowsMarker, "win32")).resolves.toBe(true);
      await writeFile(linuxMarker, "unexpected");
      await expect(verifyNeutralMarker(linuxMarker, "linux")).rejects.toThrowError(
        new HostHarnessError("neutral_marker_invalid"),
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("rejects oversized and padded marker content", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-neutral-marker-test-"));
    try {
      const oversized = join(root, "oversized");
      const padded = join(root, "padded");
      await writeFile(oversized, Buffer.alloc(1024 * 1024, 0x78));
      await writeFile(padded, " executed ");
      await expect(verifyNeutralMarker(oversized, "linux")).rejects.toThrowError(
        new HostHarnessError("neutral_marker_invalid"),
      );
      await expect(verifyNeutralMarker(padded, "win32")).rejects.toThrowError(
        new HostHarnessError("neutral_marker_invalid"),
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("rejects a path replacement after the bounded marker read", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-neutral-marker-test-"));
    try {
      const marker = join(root, "marker");
      const displaced = join(root, "displaced");
      await writeFile(marker, "");
      await expect(
        verifyNeutralMarker(marker, "linux", {
          afterRead: async () => {
            await rename(marker, displaced);
            await writeFile(marker, "");
          },
        }),
      ).rejects.toThrowError(new HostHarnessError("neutral_marker_not_regular"));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("rejects a directory or symbolic-link marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-neutral-marker-test-"));
    try {
      const directory = join(root, "directory");
      const target = join(root, "target");
      const linked = join(root, "linked");
      await mkdir(directory);
      await writeFile(target, "");
      await expect(verifyNeutralMarker(directory, "linux")).rejects.toThrowError(
        new HostHarnessError("neutral_marker_not_regular"),
      );
      await symlink(target, linked, "file");
      await expect(verifyNeutralMarker(linked, "linux")).rejects.toThrowError(
        new HostHarnessError("neutral_marker_not_regular"),
      );
      await expect(verifyNeutralMarker(target, "freebsd")).rejects.toThrowError(
        new HostHarnessError("host_platform_unsupported"),
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
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

  it("writes only a bounded explicit stdin payload", async () => {
    const result = await runBounded(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { cwd: tmpdir(), env: process.env, input: "fixture-input", timeoutMs: 5_000 },
    );
    expect(result).toMatchObject({ code: 0, signal: null, stdout: "fixture-input" });
    await expect(
      runBounded(process.execPath, ["-e", ""], {
        cwd: tmpdir(),
        env: process.env,
        input: "x".repeat(64 * 1024 + 1),
      }),
    ).rejects.toThrowError(new HostHarnessError("host_input_too_large"));
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

describe("Codex host environment isolation", () => {
  it("emits one case-insensitive PATH key with the fake bin first", () => {
    const fakeBin = process.platform === "win32" ? "C:\\fake-bin" : "/fake-bin";
    const environment = minimalEnvironment("codex-home", "task", fakeBin);
    const pathKeys = Object.keys(environment).filter((key) => key.toLowerCase() === "path");
    expect(pathKeys).toHaveLength(1);
    const path = environment[pathKeys[0] ?? ""];
    expect(path?.split(delimiter)[0]).toBe(fakeBin);
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

describe("Codex host result classification", () => {
  it.each([
    ["administrator policy rejected execution", "administrator_rejected"],
    ["approval was required", "approval_rejected"],
    ["Access is denied", "permission_rejected"],
    ["hook timed out", "timeout"],
  ])("maps bounded failure category for %j", (output, expected) => {
    expect(
      classifyFunctionOutput({ type: "function_call_output", call_id: "call", output }, "call"),
    ).toBe(expected);
  });
});
