import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
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
import { statusClaudeProjectHook } from "../src/claude-project-hook-status.js";
import { createProgram } from "../src/program.js";

const run = promisify(execFile);
const roots: string[] = [];
const integrationTimeout = process.platform === "win32" ? 30_000 : 15_000;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("Claude project-hook status", { timeout: integrationTimeout }, () => {
  it("reports only the healthy future-installation precondition without mutating .claude", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".gitignore"), ".claude/settings.local.json\n");
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
      blockers: [],
      activation: "unproven",
      providersContacted: false,
      exitCodeMeaning: "future_installation_precondition_met",
    });
    expect(await inventory(root)).toEqual(before);
    await expect(lstat(join(root, ".claude"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports foreign local settings and distinguishes ignored from force-added tracked state", async () => {
    const root = await gitRoot();
    await writeFile(join(root, ".gitignore"), ".claude/settings.local.json\n");
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
    await writeFile(join(root, ".gitignore"), ".claude/settings.local.json\n");
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
    expect(await status(root)).toMatchObject({
      sharedSettings: "present",
      sharedPreToolUse: "absent",
      sharedDisableAllHooks: false,
      blockers: [],
    });
  });

  it.each([
    ["duplicate", '{"hooks":{"PreToolUse":[],"PreToolUse":[]}}\n'],
    ["non-object", "[]\n"],
    ["invalid relevant shape", '{"hooks":{"PreToolUse":"Bash"}}\n'],
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
      },
    );
    expect(JSON.parse(changed.output)).toMatchObject({
      localSettings: "unsafe",
      sharedSettings: "unsafe",
      localSettingsIgnored: "unknown",
      blockers: ["local_settings_unsafe", "shared_settings_unsafe", "ignore_status_unavailable"],
    });

    const unavailable = await statusClaudeProjectHook(
      { format: "json" },
      {
        cwd: root,
        observeIgnore: async () => {
          throw new Error("secret-pattern=/private/credential");
        },
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
      { cwd: await realpath(linked), observeIgnore: async () => "not_ignored" },
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

  it("redacts unexpected failures and dispatches the nested CLI command", async () => {
    const failed = await statusClaudeProjectHook(
      { format: "json" },
      {
        loadAuthority: async () => {
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

    const root = await gitRoot();
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      cwd: root,
      observeIgnore: async () => "ignored",
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

async function sharedRoot(): Promise<string> {
  const root = await gitRoot();
  await writeFile(join(root, ".gitignore"), ".claude/settings.local.json\n");
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
