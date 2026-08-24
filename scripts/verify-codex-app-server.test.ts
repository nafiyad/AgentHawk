import { describe, expect, it } from "vitest";

import {
  appServerSurface,
  matchesHookNotification,
  selectExpectedHook,
  validateDisabledHookInventory,
  validateHookNotification,
  validateInitializeResponse,
  validateManagedOnlyRequirements,
  validateModifiedHook,
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

function projectListedHook(trustStatus = "untrusted") {
  const listed = listedHook(trustStatus);
  return {
    ...listed,
    hook: {
      ...listed.hook,
      source: "project",
      sourcePath: "C:\\fixture\\.codex\\hooks.json",
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

  it("binds an exact project hook and rejects a source substitution", () => {
    const expected = projectListedHook();
    const response = {
      data: [{ cwd: expected.cwd, errors: [], warnings: [], hooks: [expected.hook] }],
    };
    expect(selectExpectedHook(response, "project")).toEqual(expected);
    expect(() => selectExpectedHook(response, "user")).toThrowError(
      new HostHarnessError("app_server_hook_invalid"),
    );
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
    ).toThrowError(new HostHarnessError("app_server_hooks_list_warnings_present"));
    expect(() =>
      selectExpectedHook({
        data: [
          {
            cwd: expected.cwd,
            errors: [],
            warnings: [],
            hooks: [expected.hook, expected.hook],
          },
        ],
      }),
    ).toThrowError(new HostHarnessError("app_server_hooks_list_hook_count_invalid"));
    expect(() =>
      validateTrustedHook(expected, {
        ...listedHook("trusted"),
        hook: { ...listedHook("trusted").hook, currentHash: "sha256:changed" },
      }),
    ).toThrowError(new HostHarnessError("app_server_hook_trust_invalid"));
    expect(() =>
      validateTrustedHook(expected, { ...listedHook("trusted"), cwd: "C:\\other" }),
    ).toThrowError(new HostHarnessError("app_server_hook_trust_invalid"));
    expect(() => validateTrustedHook(expected, listedHook("trusted"))).not.toThrow();
  });

  it("requires a changed hash and Codex modified state after project-hook mutation", () => {
    const trusted = projectListedHook("trusted");
    expect(() =>
      validateModifiedHook(trusted, {
        ...projectListedHook("modified"),
        hook: { ...projectListedHook("modified").hook, currentHash: "sha256:changed" },
      }),
    ).not.toThrow();
    expect(() => validateModifiedHook(trusted, projectListedHook("modified"))).toThrowError(
      new HostHarnessError("app_server_hook_mutation_invalid"),
    );
    expect(() =>
      validateModifiedHook(trusted, {
        ...projectListedHook("untrusted"),
        hook: { ...projectListedHook("untrusted").hook, currentHash: "sha256:changed" },
      }),
    ).toThrowError(new HostHarnessError("app_server_hook_mutation_invalid"));
  });

  it("accepts only an empty, warning-free inventory when hooks are disabled", () => {
    const response = {
      data: [{ cwd: "C:\\fixture", errors: [], warnings: [], hooks: [] }],
    };
    expect(validateDisabledHookInventory(response)).toEqual({ cwd: "C:\\fixture" });
    expect(() =>
      validateDisabledHookInventory({
        data: [{ ...response.data[0], hooks: [projectListedHook().hook] }],
      }),
    ).toThrowError(new HostHarnessError("app_server_hooks_disabled_invalid"));
    expect(() =>
      validateDisabledHookInventory({
        data: [{ ...response.data[0], warnings: ["unexpected"] }],
      }),
    ).toThrowError(new HostHarnessError("app_server_hooks_disabled_invalid"));
  });
});

describe("Codex app-server managed requirements", () => {
  it("accepts only a literal managed-hooks-only requirement", () => {
    expect(
      validateManagedOnlyRequirements({
        requirements: { allowManagedHooksOnly: true },
      }),
    ).toEqual({ allowManagedHooksOnly: true });
  });

  it.each([
    null,
    {},
    { requirements: null },
    { requirements: {} },
    { requirements: { allowManagedHooksOnly: false } },
    { requirements: { allowManagedHooksOnly: "true" } },
    { requirements: { allowManagedHooksOnly: true }, unexpected: true },
  ])("rejects absent, false, malformed, or widened requirement responses", (value) => {
    expect(() => validateManagedOnlyRequirements(value)).toThrowError(
      new HostHarnessError("app_server_managed_requirements_invalid"),
    );
  });

  it("bounds the requirement record", () => {
    const requirements = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`field${index}`, null]),
    );
    requirements.allowManagedHooksOnly = true;
    expect(() => validateManagedOnlyRequirements({ requirements })).toThrowError(
      new HostHarnessError("app_server_managed_requirements_invalid"),
    );
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

  it("rejects user/project notification source confusion", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      run: {
        entries: [],
        id: "run-1",
        eventName: "preToolUse",
        executionMode: "sync",
        handlerType: "command",
        scope: "turn",
        source: "project",
        sourcePath: "C:\\fixture\\.codex\\hooks.json",
        status: "completed",
      },
    };
    expect(() =>
      validateHookNotification(params, "thread-1", "turn-1", "completed", "run-1", "project"),
    ).not.toThrow();
    expect(() =>
      validateHookNotification(params, "thread-1", "turn-1", "completed", "run-1", "user"),
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
