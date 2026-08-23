import { describe, expect, it } from "vitest";

import {
  assertLoopbackUrl,
  encodeSse,
  HostHarnessError,
  hookCommands,
  parseArguments,
  selectCommandTool,
} from "./verify-codex-host.mjs";

describe("Codex host hook command boundary", () => {
  it("uses the PowerShell call operator for an absolute executable", () => {
    expect(hookCommands("C:\\Program Files\\node.exe", "C:\\fixture path\\hook.mjs")).toEqual({
      posix: "'C:\\Program Files\\node.exe' 'C:\\fixture path\\hook.mjs'",
      windows: '& "C:\\Program Files\\node.exe" "C:\\fixture path\\hook.mjs"',
    });
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
