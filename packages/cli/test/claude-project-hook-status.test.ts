import { type ChildProcess, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeProjectHookStatusReportSchema } from "@agenthawk/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeProjectHookArtifacts,
  buildClaudeProjectHookLockBytes,
} from "../src/claude-project-hook-format.js";
import {
  type ClaudeProjectHookStatusDependencies,
  statusClaudeProjectHook,
} from "../src/claude-project-hook-status.js";
import { createProgram } from "../src/program.js";
import { RepositoryAuthorityError } from "../src/repository-authority.js";

const run = promisify(execFile);
const roots: string[] = [];
const integrationTimeout = process.platform === "win32" ? 30_000 : 15_000;
const ignoreRules = [
  ".claude/settings.local.json",
  ".agenthawk/integrations/claude-v1.json",
  ".agenthawk-claude-integration.lock",
  ".agenthawk-claude-integration-*",
  "",
].join("\n");

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Claude project-hook status", { timeout: integrationTimeout }, () => {
  it("reports only the healthy future-installation precondition without mutating .claude", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".gitignore"), ignoreRules);
    const before = await inventory(root);
    const result = await statusClaudeProjectHook({ format: "json" }, { cwd: root });
    const report = claudeProjectHookStatusReportSchema.parse(JSON.parse(result.output));
    expect(result.exitCode).toBe(0);
    expect(report).toEqual({
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "integrations_claude_status",
      localSettings: "absent",
      sharedSettings: "absent",
      sharedPreToolUse: "absent",
      sharedDisableAllHooks: false,
      localSettingsIgnored: "ignored",
      integrationArtifactsIgnored: "ignored",
      ownership: "absent",
      readiness: "not_applicable",
      blockers: [],
      activation: "unproven",
      providersContacted: false,
      exitCodeMeaning: "future_installation_precondition_met",
    });
    expect(await inventory(root)).toEqual(before);
    await expect(lstat(join(root, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies an exact root-bound pair as current without disclosing ownership material", async () => {
    const fixture = await ownedRoot();
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    const report = claudeProjectHookStatusReportSchema.parse(JSON.parse(result.output));
    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      ownership: "owned_exact",
      readiness: "current",
      blockers: [],
      activation: "unproven",
      exitCodeMeaning: "integration_current",
    });
    for (const privateValue of [
      fixture.root,
      fixture.adapterEntry,
      fixture.artifacts.receipt.installationId,
      fixture.artifacts.receipt.rootBinding,
      fixture.artifacts.receipt.adapterSha256,
    ]) {
      expect(result.output).not.toContain(privateValue);
    }
  });

  it("keeps ownership independent across inactive, modified, unowned, and colliding states", async () => {
    const inactive = await ownedRoot();
    await rm(join(inactive.root, ".claude", "settings.local.json"));
    expect(await fixtureStatus(inactive)).toMatchObject({
      localSettings: "absent",
      ownership: "owned_inactive",
      readiness: "current",
    });

    const modified = await ownedRoot();
    await writeFile(join(modified.root, ".claude", "settings.local.json"), "{}\n");
    expect(await fixtureStatus(modified)).toMatchObject({
      localSettings: "present",
      ownership: "owned_modified",
      readiness: "current",
    });

    const unowned = await gitRoot();
    await mkdir(join(unowned, ".claude"));
    await writeFile(join(unowned, ".claude", "settings.local.json"), "{}\n");
    expect(
      JSON.parse(
        (
          await statusClaudeProjectHook(
            { format: "json" },
            {
              cwd: unowned,
              observeIgnore: async () => "ignored",
              observeIntegrationIgnore: async () => "ignored",
            },
          )
        ).output,
      ),
    ).toMatchObject({
      ownership: "unowned_settings",
      readiness: "not_applicable",
      blockers: ["local_settings_present"],
    });

    const collision = await ownedRoot();
    await writeFile(join(collision.root, ".agenthawk", "integrations", "claude-v1.json"), "{}\n");
    expect(await fixtureStatus(collision)).toMatchObject({
      ownership: "record_collision",
      readiness: "not_applicable",
    });
  });

  it("reports artifact drift and unavailability without changing exact ownership", async () => {
    const fixture = await ownedRoot();
    expect(await fixtureStatus(fixture, { adapterVersion: "0.1.0-alpha.2" })).toMatchObject({
      ownership: "owned_exact",
      readiness: "artifact_drift",
    });
    expect(
      await fixtureStatus(fixture, { adapterEntry: join(fixture.root, "missing-adapter.js") }),
    ).toMatchObject({ ownership: "owned_exact", readiness: "artifact_unavailable" });
  });

  it("uses current runtime defaults without exposing them in terminal output", async () => {
    const fixture = await ownedRoot();
    const result = await statusClaudeProjectHook(
      { format: "terminal" },
      {
        adapterEntry: fixture.adapterEntry,
        cwd: fixture.root,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Ownership: owned_exact");
    expect(result.output).toContain("Readiness: current");
    expect(result.output).not.toContain(fixture.root);
    expect(result.output).not.toContain(fixture.adapterEntry);
  });

  it("separates oversized record collisions from modified owned settings", async () => {
    const oversizedReceipt = await ownedRoot();
    await writeFile(
      join(oversizedReceipt.root, ".agenthawk", "integrations", "claude-v1.json"),
      Buffer.alloc(8_193, 0x20),
    );
    expect(await fixtureStatus(oversizedReceipt)).toMatchObject({
      ownership: "record_collision",
      readiness: "not_applicable",
    });

    const oversizedSettings = await ownedRoot();
    await writeFile(
      join(oversizedSettings.root, ".claude", "settings.local.json"),
      Buffer.alloc(65_537, 0x20),
    );
    expect(await fixtureStatus(oversizedSettings)).toMatchObject({
      localSettings: "present",
      ownership: "owned_modified",
      readiness: "current",
    });
  });

  it("treats a hard-linked ownership record as unsafe", async () => {
    const fixture = await ownedRoot();
    const receipt = join(fixture.root, ".agenthawk", "integrations", "claude-v1.json");
    await link(receipt, join(fixture.root, ".agenthawk", "integrations", "receipt-copy.json"));
    expect(await fixtureStatus(fixture)).toMatchObject({
      ownership: "unsafe",
      readiness: "not_applicable",
    });
  });

  it.each([
    ["not_ignored", "integration_artifacts_not_ignored"],
    ["unknown", "integration_ignore_status_unavailable"],
  ] as const)(
    "maps %s aggregate integration ignore state to one blocker",
    async (state, blocker) => {
      const fixture = await ownedRoot();
      const result = await statusClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          observeIgnore: async () => "ignored",
          observeIntegrationIgnore: async () => state,
        },
      );
      expect(JSON.parse(result.output)).toMatchObject({
        integrationArtifactsIgnored: state,
        ownership: "owned_exact",
        readiness: "current",
        blockers: [blocker],
      });
    },
  );

  it("suppresses readiness when shared project hooks independently block installation", async () => {
    const fixture = await ownedRoot();
    await writeFile(
      join(fixture.root, ".claude", "settings.json"),
      '{"hooks":{"PreToolUse":[{"matcher":"Bash"}]}}\n',
    );
    expect(await fixtureStatus(fixture)).toMatchObject({
      ownership: "owned_exact",
      readiness: "not_applicable",
      blockers: ["project_hooks_present"],
    });
  });

  it("derives only the exact staging ignore candidate from a canonical operation lock", async () => {
    const fixture = await ownedRoot();
    const operationId = "ab".repeat(32);
    await writeFile(
      join(fixture.root, ".agenthawk-claude-integration.lock"),
      buildClaudeProjectHookLockBytes(operationId),
    );
    await mkdir(join(fixture.root, `.agenthawk-claude-integration-${operationId}`));
    const observedPaths: string[][] = [];
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async (_root, paths) => {
          observedPaths.push([...paths]);
          return "ignored";
        },
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ownership: "owned_exact",
      readiness: "current",
      blockers: ["operation_locked"],
    });
    expect(observedPaths).toEqual([
      [
        receiptRelative(),
        ".agenthawk-claude-integration.lock",
        `.agenthawk-claude-integration-${operationId}`,
      ],
      [
        receiptRelative(),
        ".agenthawk-claude-integration.lock",
        `.agenthawk-claude-integration-${operationId}`,
      ],
    ]);
    expect(result.output).not.toContain(operationId);
  });

  it("observes an absent derived staging directory without scanning siblings", async () => {
    const fixture = await ownedRoot();
    const operationId = "cd".repeat(32);
    await writeFile(
      join(fixture.root, ".agenthawk-claude-integration.lock"),
      buildClaudeProjectHookLockBytes(operationId),
    );
    const paths: string[][] = [];
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async (_root, candidates) => {
          paths.push([...candidates]);
          return "ignored";
        },
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({ blockers: ["operation_locked"] });
    expect(paths.flat()).toContain(`.agenthawk-claude-integration-${operationId}`);
  });

  it("fails safely when the derived staging directory identity changes between snapshots", async () => {
    const fixture = await ownedRoot();
    const operationId = "ef".repeat(32);
    const staging = join(fixture.root, `.agenthawk-claude-integration-${operationId}`);
    await writeFile(
      join(fixture.root, ".agenthawk-claude-integration.lock"),
      buildClaudeProjectHookLockBytes(operationId),
    );
    await mkdir(staging);
    let calls = 0;
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => {
          if (++calls === 1) {
            await rename(staging, `${staging}-old`);
            await mkdir(staging);
          }
          return "ignored";
        },
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ownership: "unsafe",
      readiness: "not_applicable",
      activation: "unproven",
    });
  });

  it("fails closed on unrecognized locks and integration ignore uncertainty", async () => {
    const fixture = await ownedRoot();
    await writeFile(join(fixture.root, ".agenthawk-claude-integration.lock"), "{}\n");
    expect(await fixtureStatus(fixture)).toMatchObject({
      ownership: "owned_exact",
      readiness: "current",
      integrationArtifactsIgnored: "unknown",
      blockers: ["integration_ignore_status_unavailable", "operation_locked"],
    });
  });

  it("uses quiet Git exit states to require every fixed artifact to be ignored", async () => {
    const root = await gitRoot();
    const result = await statusClaudeProjectHook(
      { format: "json" },
      { cwd: root, observeIgnore: async () => "ignored" },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      integrationArtifactsIgnored: "not_ignored",
      ownership: "absent",
      blockers: ["integration_artifacts_not_ignored"],
    });
  });

  it.each(["close", "error"] as const)(
    "maps a quiet Git %s failure to bounded unknown states",
    async (failure) => {
      const root = await gitRoot();
      const result = await statusClaudeProjectHook(
        { format: "json" },
        {
          cwd: root,
          spawnProcess: (() => {
            const child = new EventEmitter();
            queueMicrotask(() => {
              if (failure === "error") child.emit("error", new Error("private git failure"));
              child.emit("close", failure === "close" ? 2 : null, null);
            });
            return child as ChildProcess;
          }) as typeof import("node:child_process").spawn,
        },
      );
      expect(JSON.parse(result.output)).toMatchObject({
        localSettingsIgnored: "unknown",
        integrationArtifactsIgnored: "unknown",
        blockers: ["ignore_status_unavailable", "integration_ignore_status_unavailable"],
      });
      expect(result.output).not.toContain("private git failure");
    },
  );

  it("reports foreign local settings and distinguishes ignored from force-added tracked state", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".gitignore"), ignoreRules);
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude", "settings.local.json"), '{"private":"do-not-render"}\n');
    expect(await status(root)).toMatchObject({
      localSettings: "present",
      localSettingsIgnored: "ignored",
      blockers: ["local_settings_present"],
    });

    await git(root, ["add", "-f", ".claude/settings.local.json"]);
    const tracked = await status(root);
    expect(tracked).toMatchObject({
      localSettings: "present",
      localSettingsIgnored: "not_ignored",
      blockers: ["local_settings_present", "local_settings_not_ignored"],
    });
    expect(JSON.stringify(tracked)).not.toContain("do-not-render");
  });

  it("detects only relevant shared declarations and preserves blocker order", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".gitignore"), ignoreRules);
    await mkdir(join(root, ".claude"));
    await writeFile(
      join(root, ".claude", "settings.json"),
      `${JSON.stringify({
        disableAllHooks: true,
        hooks: { PostToolUse: [{ private: "ignored" }], PreToolUse: [{ matcher: "Bash" }] },
        hostile: "\u001b[31m/private/value",
      })}\n`,
    );
    const result = await statusClaudeProjectHook({ format: "terminal" }, { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Shared PreToolUse: present");
    expect(result.output).toContain("Shared disableAllHooks: true");
    expect(result.output).toContain(
      "Blockers: project_hooks_present, project_hooks_declared_disabled",
    );
    expect(result.output).not.toContain("private");
    expect(result.output).not.toContain("\u001b[31m");

    await writeFile(
      join(root, ".claude", "settings.json"),
      '{"hooks":{"PreToolUse":[]},"disableAllHooks":false,"other":{"value":true}}\n',
    );
    const harmless = await statusClaudeProjectHook({ format: "json" }, { cwd: root });
    expect(harmless.exitCode).toBe(0);
    expect(JSON.parse(harmless.output)).toMatchObject({
      sharedSettings: "present",
      sharedPreToolUse: "absent",
      sharedDisableAllHooks: false,
      blockers: [],
      exitCodeMeaning: "future_installation_precondition_met",
    });
    await writeFile(join(root, ".claude", "settings.json"), '{"hooks":{}}\n');
    expect(await status(root)).toMatchObject({
      sharedSettings: "present",
      sharedPreToolUse: "absent",
    });
  });

  it("does not read or validate unrelated AgentHawk configuration", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".agenthawk.yml"), "not: valid: yaml\n");
    await writeFile(join(root, "package.json"), "not-json\n");
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      localSettings: "absent",
      sharedSettings: "absent",
      blockers: [],
    });
  });

  it.each([
    ["duplicate", '{"hooks":{"PreToolUse":[],"PreToolUse":[]}}\n'],
    ["non-object", "[]\n"],
    ["invalid hooks object", '{"hooks":[]}\n'],
    ["invalid relevant shape", '{"hooks":{"PreToolUse":"Bash"}}\n'],
    ["invalid hook group member", '{"hooks":{"PreToolUse":[1]}}\n'],
    ["invalid disable flag", '{"disableAllHooks":"true"}\n'],
  ])("classifies %s shared settings as unsafe without parser detail", async (_label, source) => {
    const root = await sharedRoot();
    await writeFile(join(root, ".claude", "settings.json"), source);
    const result = await statusClaudeProjectHook({ format: "json" }, { cwd: root });
    expect(JSON.parse(result.output)).toMatchObject({
      sharedSettings: "unsafe",
      sharedPreToolUse: "unknown",
      sharedDisableAllHooks: "unknown",
      blockers: ["shared_settings_unsafe"],
    });
    expect(result.output).not.toContain(source.trim());
  });

  it("rejects invalid UTF-8, oversized, deep, and wide shared settings", async () => {
    const root = await sharedRoot();
    const path = join(root, ".claude", "settings.json");
    await writeFile(path, Buffer.from(`{}${" ".repeat(262_142)}`));
    expect(await status(root)).toMatchObject({ sharedSettings: "present" });
    for (const bytes of [Buffer.from([0xff]), Buffer.from("x".repeat(262_145))]) {
      await writeFile(path, bytes);
      expect(await status(root)).toMatchObject({ sharedSettings: "unsafe" });
    }

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) deep = { child: deep };
    await writeFile(path, `${JSON.stringify(deep)}\n`);
    expect(await status(root)).toMatchObject({ sharedSettings: "unsafe" });

    const wide = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`field${index}`, true]),
    );
    await writeFile(path, `${JSON.stringify(wide)}\n`);
    expect(await status(root)).toMatchObject({ sharedSettings: "unsafe" });
    await writeFile(path, `${JSON.stringify({ other: Array.from({ length: 1_025 }) })}\n`);
    expect(await status(root)).toMatchObject({ sharedSettings: "unsafe" });
  });

  it("turns compatibility aliases and hard-linked settings into affected unsafe states", async () => {
    const aliasRoot = await gitRoot();
    await mkdir(join(aliasRoot, ".CLAUDE"));
    expect(await status(aliasRoot)).toMatchObject({
      localSettings: "unsafe",
      sharedSettings: "unsafe",
    });

    const unicodeAliasRoot = await gitRoot();
    await mkdir(join(unicodeAliasRoot, ".ｃｌａｕｄｅ"));
    expect(await status(unicodeAliasRoot)).toMatchObject({
      localSettings: "unsafe",
      sharedSettings: "unsafe",
    });

    const fileAliasRoot = await sharedRoot();
    await writeFile(join(fileAliasRoot, ".claude", "SETTINGS.JSON"), "{}\n");
    expect(await status(fileAliasRoot)).toMatchObject({ sharedSettings: "unsafe" });

    const hardlinkRoot = await sharedRoot();
    const settings = join(hardlinkRoot, ".claude", "settings.json");
    await writeFile(settings, "{}\n");
    await link(settings, join(hardlinkRoot, ".claude", "settings-copy.json"));
    expect(await status(hardlinkRoot)).toMatchObject({ sharedSettings: "unsafe" });
  });

  it("rejects linked settings parents where the platform permits them", async () => {
    const root = await gitRoot();
    const external = join(root, "external");
    await mkdir(external);
    try {
      await symlink(external, join(root, ".claude"), "junction");
      expect(await status(root)).toMatchObject({
        localSettings: "unsafe",
        sharedSettings: "unsafe",
      });
    } catch (error) {
      if (!hasCode(error, "EPERM")) throw error;
    }
  });

  it("fails safely when ignore state changes or the quiet query is unavailable", async () => {
    const root = await gitRoot();
    let calls = 0;
    const changed = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        observeIgnore: async () => (++calls === 1 ? "ignored" : "not_ignored"),
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(changed.output)).toMatchObject({
      localSettings: "unsafe",
      sharedSettings: "unsafe",
      localSettingsIgnored: "unknown",
      blockers: [
        "local_settings_unsafe",
        "shared_settings_unsafe",
        "ignore_status_unavailable",
        "integration_ignore_status_unavailable",
      ],
    });

    const unavailable = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        observeIgnore: async () => {
          throw new Error("secret-pattern=/private/credential");
        },
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(unavailable.output)).toMatchObject({
      localSettingsIgnored: "unknown",
      blockers: ["ignore_status_unavailable"],
    });
    expect(unavailable.output).not.toContain("secret-pattern");
    expect(unavailable.output).not.toContain("credential");
  });

  it("rejects parent and target identity replacement between snapshots", async () => {
    const root = await sharedRoot();
    await writeFile(join(root, ".claude", "settings.json"), "{}\n");
    let calls = 0;
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        observeIgnore: async () => {
          if (++calls === 1) {
            await rm(join(root, ".claude-old"), { force: true, recursive: true });
            await rename(join(root, ".claude"), join(root, ".claude-old"));
            await mkdir(join(root, ".claude"));
            await writeFile(join(root, ".claude", "settings.json"), "{}\n");
          }
          return "ignored";
        },
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      localSettings: "unsafe",
      sharedSettings: "unsafe",
      localSettingsIgnored: "unknown",
    });
  });

  it("reports linked worktrees as the final ordered blocker", async () => {
    const main = await gitRoot();
    const linked = `${main}-linked`;
    roots.push(linked);
    await git(main, ["worktree", "add", "--detach", linked]);
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: await realpath(linked),
        observeIgnore: async () => "not_ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      blockers: ["local_settings_not_ignored", "linked_worktree"],
      activation: "unproven",
    });
  });

  it("propagates cancellation without producing a report", async () => {
    const root = await gitRoot();
    const controller = new AbortController();
    controller.abort(new Error("private cancellation"));
    await expect(
      statusClaudeProjectHook({ format: "json", signal: controller.signal }, { cwd: root }),
    ).rejects.toThrow();
  });

  it("waits for an active quiet Git child to close before propagating cancellation", async () => {
    const root = await gitRoot();
    const controller = new AbortController();
    const child = new EventEmitter();
    let notifyError!: () => void;
    const errorObserved = new Promise<void>((resolvePromise) => {
      notifyError = resolvePromise;
    });
    const pending = statusClaudeProjectHook(
      { format: "json", signal: controller.signal },
      {
        cwd: root,
        spawnProcess: (() => {
          queueMicrotask(() => {
            controller.abort(new Error("private cancellation"));
            child.emit("error", new Error("private abort detail"));
            notifyError();
          });
          return child as ChildProcess;
        }) as typeof import("node:child_process").spawn,
      },
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await errorObserved;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(pending).rejects.toThrow();
    expect(settled).toBe(true);
  });

  it("bounds oversized directory enumeration and closes the reader", async () => {
    const root = await gitRoot();
    let reads = 0;
    let closed = false;
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        openDirectory: async () => ({
          close: async () => {
            closed = true;
          },
          read: async () => ({ name: `entry-${reads++}` }),
        }),
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({ localSettings: "unsafe" });
    expect(reads).toBe(8_194);
    expect(closed).toBe(true);
  });

  it("fails safely when a bounded directory reader cannot close", async () => {
    const root = await gitRoot();
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        openDirectory: async () => ({
          close: async () => {
            throw new Error("private close failure");
          },
          read: async () => null,
        }),
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({ ownership: "unsafe" });
    expect(result.output).not.toContain("private close failure");
  });

  it("keeps exact ownership when current adapter observation is unsafe or changes before open", async () => {
    const directoryAdapter = await ownedRoot();
    expect(
      await fixtureStatus(directoryAdapter, { adapterEntry: directoryAdapter.root }),
    ).toMatchObject({ ownership: "owned_exact", readiness: "artifact_unavailable" });

    const changedAdapter = await ownedRoot();
    let replaced = false;
    expect(
      await fixtureStatus(changedAdapter, {
        openFile: async (path, flags) => {
          if (path === changedAdapter.adapterEntry && !replaced) {
            replaced = true;
            await rename(path, `${path}.old`);
            await writeFile(path, "export const changed = true;\n");
          }
          return await open(path, flags);
        },
      }),
    ).toMatchObject({ ownership: "owned_exact", readiness: "artifact_unavailable" });
  });

  it("fails safely when an owned fixed file changes between inspection and open", async () => {
    const fixture = await ownedRoot();
    const receipt = join(fixture.root, ".agenthawk", "integrations", "claude-v1.json");
    let replaced = false;
    const result = await statusClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        openFile: async (path, flags) => {
          if (path === receipt && !replaced) {
            replaced = true;
            await rename(path, `${path}.old`);
            await writeFile(path, fixture.artifacts.receiptBytes);
          }
          return await open(path, flags);
        },
        observeIgnore: async () => "ignored",
        observeIntegrationIgnore: async () => "ignored",
      },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ownership: "unsafe",
      readiness: "not_applicable",
    });
  });

  it.each(["invalid", "oversized", "identity"] as const)(
    "fails safely on %s repository topology evidence",
    async (failure) => {
      const root = await gitRoot();
      const stats = await lstat(root, { bigint: true });
      const result = await statusClaudeProjectHook(
        { format: "json" },
        {
          cwd: root,
          ...(failure === "identity"
            ? {
                loadRootAuthority: async () => ({
                  repositoryIdentity: { dev: stats.dev, ino: stats.ino + 1n },
                  repositoryRoot: root,
                }),
              }
            : {
                runTopologyGit: async () =>
                  failure === "invalid" ? "invalid\n" : `${"x".repeat(65_537)}\n`,
              }),
          observeIgnore: async () => "ignored",
          observeIntegrationIgnore: async () => "ignored",
        },
      );
      expect(JSON.parse(result.output)).toMatchObject({ ownership: "unsafe" });
    },
  );

  it("returns the same minimum-disclosure unsafe report for repository authority errors", async () => {
    for (const format of ["json", "terminal"] as const) {
      const result = await statusClaudeProjectHook(
        { format },
        {
          loadRootAuthority: async () => {
            throw new RepositoryAuthorityError("repository_identity", "private root path");
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.output).not.toContain("private root path");
      if (format === "json") {
        expect(JSON.parse(result.output)).toMatchObject({ ownership: "unsafe" });
      } else {
        expect(result.output).toContain("Ownership: unsafe");
      }
    }
  });

  it("redacts unexpected failures and dispatches the nested CLI command", async () => {
    const failed = await statusClaudeProjectHook(
      { format: "json" },
      {
        loadRootAuthority: async () => {
          throw new Error("private authority failure");
        },
      },
    );
    expect(failed.exitCode).toBe(4);
    expect(JSON.parse(failed.output)).toEqual({
      schemaVersion: "1.0",
      error: {
        code: "internal_error",
        message: "Claude project-hook status could not be observed safely.",
      },
      exitCode: 4,
    });
    expect(failed.output).not.toContain("private authority failure");

    const terminalFailure = await statusClaudeProjectHook(
      { format: "terminal" },
      {
        loadRootAuthority: async () => {
          throw new Error("private terminal authority failure");
        },
      },
    );
    expect(terminalFailure.exitCode).toBe(4);
    expect(terminalFailure.output).toBe(
      "AgentHawk: Claude project-hook status could not be observed safely.\n",
    );

    const root = await gitRoot();
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      cwd: root,
      observeIgnore: async () => "ignored",
      observeIntegrationIgnore: async () => "ignored",
      setExitCode: (value) => (exitCode = value),
      write: (value) => (output += value),
    });
    await program.parseAsync(["integrations", "claude", "status", "--format", "json"], {
      from: "user",
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ command: "integrations_claude_status" });
  });
});

async function gitRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-claude-status-"));
  roots.push(root);
  await git(root, ["init", "--quiet"]);
  await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await git(root, ["add", "package.json"]);
  await git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return await realpath(root);
}

async function ownedRoot() {
  const root = await gitRoot();
  await writeFile(join(root, ".gitignore"), ignoreRules);
  const adapterBytes = Buffer.from("export {};\n", "utf8");
  const adapterEntry = join(root, "fixture-claude-adapter.js");
  await writeFile(adapterEntry, adapterBytes);
  const nodeExecutable = await realpath(process.execPath);
  const rootStats = await lstat(root, { bigint: true });
  const artifacts = buildClaudeProjectHookArtifacts({
    adapterBytes,
    adapterEntry: await realpath(adapterEntry),
    adapterVersion: "0.1.0-alpha.1",
    installationId: "12".repeat(32),
    nodeExecutable,
    nodeVersion: process.version,
    repositoryIdentity: { dev: rootStats.dev, ino: rootStats.ino },
    repositoryRoot: root,
  });
  await mkdir(join(root, ".claude"));
  await mkdir(join(root, ".agenthawk", "integrations"), { recursive: true });
  await writeFile(join(root, ".claude", "settings.local.json"), artifacts.settingsBytes);
  await writeFile(
    join(root, ".agenthawk", "integrations", "claude-v1.json"),
    artifacts.receiptBytes,
  );
  return {
    adapterEntry: await realpath(adapterEntry),
    artifacts,
    dependencies: {
      adapterEntry: await realpath(adapterEntry),
      adapterVersion: "0.1.0-alpha.1",
      cwd: root,
      nodeExecutable,
      nodeVersion: process.version,
    },
    root,
  };
}

async function fixtureStatus(
  fixture: Awaited<ReturnType<typeof ownedRoot>>,
  overrides: ClaudeProjectHookStatusDependencies = {},
): Promise<Record<string, unknown>> {
  return JSON.parse(
    (
      await statusClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          observeIgnore: async () => "ignored",
          observeIntegrationIgnore: async () => "ignored",
          ...overrides,
        },
      )
    ).output,
  ) as Record<string, unknown>;
}

function receiptRelative(): string {
  return ".agenthawk/integrations/claude-v1.json";
}

async function sharedRoot(): Promise<string> {
  const root = await gitRoot();
  await writeFile(join(root, ".gitignore"), ignoreRules);
  await mkdir(join(root, ".claude"));
  return root;
}

async function status(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    (await statusClaudeProjectHook({ format: "json" }, { cwd: root })).output,
  ) as Record<string, unknown>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd, windowsHide: true });
}

async function inventory(root: string): Promise<string[]> {
  const entries: string[] = [];
  async function visit(directory: string, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      entries.push(`${entry.isDirectory() ? "d" : "f"}:${relative}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
    }
  }
  await visit(root);
  return entries.sort();
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
