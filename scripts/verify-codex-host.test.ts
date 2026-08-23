import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import {
  assertLoopbackUrl,
  closeServer,
  encodeSse,
  HostHarnessError,
  hookCommands,
  parseArguments,
  runBounded,
  selectCommandTool,
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

describe("Codex host process cleanup boundary", () => {
  it("terminates descendant processes when the host times out", async () => {
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
  }, 5_000);

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
