import { describe, expect, it } from "vitest";

import {
  appServerSurface,
  matchesHookNotification,
  selectExpectedHook,
  validateHookNotification,
  validateInitializeResponse,
  validateThreadStart,
  validateTrustedHook,
} from "./verify-codex-app-server.mjs";
import { HostHarnessError } from "./verify-codex-host.mjs";

function listedHook(trustStatus = "untrusted") {
  return {
    cwd: "C:\\fixture",
    hook: {
      async: false,
      command: "node adapter.mjs",
      currentHash: "sha256:fixture",
      enabled: true,
      eventName: "preToolUse",
      handlerType: "command",
      isManaged: false,
      key: "fixture-key",
      matcher: "^Bash$",
      source: "user",
      sourcePath: "C:\\fixture\\hooks.json",
      timeoutSec: 10,
      trustStatus,
    },
  };
}

describe("Codex app-server response validation", () => {
  it("accepts the pinned initialize and effective thread response", () => {
    expect(
      validateInitializeResponse(
        {
          userAgent: "codex_cli_rs/0.149.0",
          codexHome: "C:\\fixture\\codex-home",
          platformFamily: "windows",
          platformOs: "windows",
        },
        "win32",
      ),
    ).toMatchObject({ platformOs: "windows" });
    expect(
      validateThreadStart({
        approvalPolicy: "never",
        cwd: "C:\\fixture",
        model: "agenthawk-fixture",
        modelProvider: "agenthawk_loopback",
        sandbox: {
          type: "workspaceWrite",
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
          writableRoots: [],
        },
        thread: { id: "thread-1" },
      }),
    ).toEqual({ cwd: "C:\\fixture", threadId: "thread-1" });
  });

  it.each([
    [{ platformFamily: "windows" }, "app_server_initialize_invalid"],
    [
      {
        approvalPolicy: "never",
        cwd: "C:\\fixture",
        model: "agenthawk-fixture",
        modelProvider: "agenthawk_loopback",
        sandbox: { type: "dangerFullAccess", networkAccess: true },
        thread: { id: "thread-1" },
      },
      "app_server_thread_start_invalid",
    ],
  ])("rejects incomplete or weakened effective state", (value, code) => {
    const validate = code.includes("initialize") ? validateInitializeResponse : validateThreadStart;
    expect(() => validate(value)).toThrowError(new HostHarnessError(code));
  });
});

describe("Codex app-server exact hook inventory", () => {
  it("accepts exactly one enabled user PreToolUse command hook", () => {
    const expected = listedHook();
    expect(
      selectExpectedHook({
        data: [
          {
            cwd: expected.cwd,
            errors: [],
            warnings: [],
            hooks: [expected.hook],
          },
        ],
      }),
    ).toEqual(expected);
  });

  it("rejects warnings, extra hooks, and changed exact-hash trust", () => {
    const expected = listedHook();
    expect(() =>
      selectExpectedHook({
        data: [
          {
            cwd: expected.cwd,
            errors: [],
            warnings: ["unexpected"],
            hooks: [expected.hook],
          },
        ],
      }),
    ).toThrowError(new HostHarnessError("app_server_hooks_list_invalid"));
    expect(() =>
      validateTrustedHook(expected, {
        ...listedHook("trusted"),
        hook: { ...listedHook("trusted").hook, currentHash: "sha256:changed" },
      }),
    ).toThrowError(new HostHarnessError("app_server_hook_trust_invalid"));
    expect(() => validateTrustedHook(expected, listedHook("trusted"))).not.toThrow();
  });
});

describe("Codex app-server hook notification binding", () => {
  it("binds the exact thread, turn, run, event, mode, handler, and status", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        entries: [{ kind: "stop", text: "blocked" }],
        id: "run-1",
        eventName: "preToolUse",
        executionMode: "sync",
        handlerType: "command",
        scope: "turn",
        source: "user",
        sourcePath: "C:\\fixture\\hooks.json",
        status: "blocked",
      },
    };
    expect(matchesHookNotification(params, "thread-1", "turn-1", "blocked", "run-1")).toBe(true);
    expect(matchesHookNotification(params, "thread-1", "turn-2", "blocked", "run-1")).toBe(false);
    expect(matchesHookNotification(params, "thread-1", "turn-1", "completed", "run-1")).toBe(false);
    expect(
      validateHookNotification(params, "thread-1", "turn-1", "blocked", "run-1"),
    ).toMatchObject({ id: "run-1", status: "blocked" });
    expect(() =>
      validateHookNotification(
        { ...params, run: { ...params.run, status: "completed" } },
        "thread-1",
        "turn-1",
        "completed",
        "run-1",
      ),
    ).toThrowError(new HostHarnessError("app_server_hook_notification_invalid"));
  });

  it("names exact operating-system and tool surfaces", () => {
    expect(appServerSurface("win32")).toBe("local-app-server-windows-stdio-shell-command");
    expect(appServerSurface("linux")).toBe("local-app-server-linux-stdio-exec-command");
    expect(appServerSurface("darwin")).toBe("local-app-server-macos-stdio-exec-command");
    expect(() => appServerSurface("aix")).toThrowError(
      new HostHarnessError("host_platform_unsupported"),
    );
  });
});
