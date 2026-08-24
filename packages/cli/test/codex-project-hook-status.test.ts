import { execFile } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodexProjectHookArtifacts,
  buildCodexProjectHookLockBytes,
} from "../src/codex-project-hook-format.js";
import {
  observeCodexProjectHook,
  statusCodexProjectHook,
  verifyCodexProjectHookInvocation,
} from "../src/codex-project-hook-status.js";
import { createProgram } from "../src/program.js";
import { loadRepositoryAuthority } from "../src/repository-authority.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex project-hook status", { timeout: 20_000 }, () => {
  it("reports an absent clean root without changing it", async () => {
    const root = await gitRoot();
    const before = await readdir(root);
    const result = await statusCodexProjectHook({ format: "json" }, { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      toolVersion: "0.1.0-alpha.1",
      command: "integrations_codex_status",
      ownership: "absent",
      readiness: "not_applicable",
      blockers: [],
      providersContacted: false,
    });
    expect(await readdir(root)).toEqual(before);
  });

  it("classifies exact ownership, current artifacts, and independent blockers", async () => {
    const fixture = await ownedFixture();
    await writeFile(join(fixture.root, ".codex", "config.toml"), "[features]\nhooks = true\n");
    await writeFile(
      join(fixture.root, ".agenthawk-codex-integration.lock"),
      buildCodexProjectHookLockBytes("cd".repeat(32)),
    );
    const report = await status(fixture);
    expect(report).toMatchObject({
      ownership: "owned_exact",
      readiness: "current",
      blockers: ["config_collision", "operation_locked"],
      providersContacted: false,
    });
  });

  it.each([
    ["inactive", false, true, "owned_inactive", "current"],
    ["unowned", true, false, "unowned_hook", "not_applicable"],
    ["absent", false, false, "absent", "not_applicable"],
  ] as const)("classifies %s state", async (_label, hook, receipt, ownership, readiness) => {
    const fixture = await ownedFixture({ writeHook: hook, writeReceipt: receipt });
    expect(await status(fixture)).toMatchObject({ ownership, readiness });
  });

  it("preserves a valid record while reporting changed hook bytes", async () => {
    const fixture = await ownedFixture();
    await writeFile(join(fixture.root, ".codex", "hooks.json"), '{"hooks":{}}\n');
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_modified",
      readiness: "current",
    });
    await rm(fixture.dependencies.adapterEntry);
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_modified",
      readiness: "artifact_unavailable",
    });
  });

  it("keeps ownership independent from current adapter availability and drift", async () => {
    const fixture = await ownedFixture();
    await link(fixture.dependencies.adapterEntry, join(fixture.root, "adapter-copy.js"));
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_exact",
      readiness: "current",
    });
    await writeFile(fixture.dependencies.adapterEntry, "changed adapter\n");
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_exact",
      readiness: "artifact_drift",
    });
    await rm(fixture.dependencies.adapterEntry);
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_exact",
      readiness: "artifact_unavailable",
    });
  });

  it("verifies only the exact current root-bound invocation without an operation lock", async () => {
    const fixture = await ownedFixture();
    const authority = await loadRepositoryAuthority(fixture.root);
    const context = {
      deploymentTrust: "project" as const,
      installationId: fixture.artifacts.receipt.installationId,
      rootBinding: fixture.artifacts.receipt.rootBinding,
    };
    await expect(
      verifyCodexProjectHookInvocation(authority, context, {}, fixture.dependencies),
    ).resolves.toBe(true);
    await expect(
      verifyCodexProjectHookInvocation(
        authority,
        { ...context, installationId: "cd".repeat(32) },
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyCodexProjectHookInvocation(
        authority,
        { ...context, rootBinding: "dc".repeat(32) },
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(false);

    const operationId = "ef".repeat(32);
    await writeFile(
      join(fixture.root, ".agenthawk-codex-integration.lock"),
      buildCodexProjectHookLockBytes(operationId),
    );
    await expect(
      verifyCodexProjectHookInvocation(authority, context, {}, fixture.dependencies),
    ).resolves.toBe(false);
    await expect(
      observeCodexProjectHook(authority, { ownedOperationId: operationId }, fixture.dependencies),
    ).resolves.toMatchObject({ ownership: "owned_exact", blockers: [] });

    await writeFile(join(fixture.root, ".agenthawk-codex-integration.lock"), "not-json");
    await expect(
      observeCodexProjectHook(authority, { ownedOperationId: operationId }, fixture.dependencies),
    ).rejects.toThrow("Unsafe Codex operation lock");

    await rm(join(fixture.root, ".agenthawk-codex-integration.lock"));
    await writeFile(join(fixture.root, ".codex", "hooks.json"), '{"hooks":{}}\n');
    await expect(
      verifyCodexProjectHookInvocation(authority, context, {}, fixture.dependencies),
    ).resolves.toBe(false);
    await writeFile(join(fixture.root, ".codex", "hooks.json"), fixture.artifacts.hookBytes);
    await rm(join(fixture.root, ".agenthawk", "integrations", "codex-v1.json"));
    await expect(
      verifyCodexProjectHookInvocation(authority, context, {}, fixture.dependencies),
    ).resolves.toBe(false);
  });

  it("reports malformed and copied receipts as collisions without disclosing them", async () => {
    const fixture = await ownedFixture();
    const receiptPath = join(fixture.root, ".agenthawk", "integrations", "codex-v1.json");
    await writeFile(receiptPath, '{"secret":"hostile-value"}\n');
    const result = await statusCodexProjectHook({ format: "terminal" }, fixture.dependencies);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("record_collision");
    expect(result.output).not.toContain("hostile-value");

    const other = await ownedFixture({ writeHook: false, writeReceipt: false });
    await writeFile(receiptPath, other.artifacts.receiptBytes);
    expect(await status(fixture)).toMatchObject({
      ownership: "record_collision",
      readiness: "not_applicable",
    });
  });

  it("rejects noncanonical, duplicate, trailing, and non-UTF-8 ownership artifacts", async () => {
    const fixture = await ownedFixture();
    const receiptPath = join(fixture.root, ".agenthawk", "integrations", "codex-v1.json");
    const hookPath = join(fixture.root, ".codex", "hooks.json");
    const receipt = fixture.artifacts.receiptBytes.toString("utf8");
    const hook = fixture.artifacts.hookBytes.toString("utf8");

    for (const bytes of [
      Buffer.from(
        receipt.replace('"adapterSha256":', `"adapterSha256":"${"0".repeat(64)}","adapterSha256":`),
      ),
      Buffer.from(`${receipt}{}`),
      Buffer.from(receipt.replace(/\}\n$/u, ',"unknown":true}\n')),
      Buffer.from(` ${receipt}`),
      Buffer.from([0xff]),
    ]) {
      await writeFile(receiptPath, bytes);
      expect(await status(fixture)).toMatchObject({ ownership: "record_collision" });
    }

    await writeFile(receiptPath, fixture.artifacts.receiptBytes);
    for (const bytes of [
      Buffer.from(hook.replace('"hooks":', '"hooks":{},"hooks":')),
      Buffer.from(`${hook}{}`),
      Buffer.from([0xff]),
    ]) {
      await writeFile(hookPath, bytes);
      expect(await status(fixture)).toMatchObject({ ownership: "owned_modified" });
    }
  });

  it("fails visibly as unsafe for malformed locks, oversized records, and linked targets", async () => {
    const fixture = await ownedFixture({ writeHook: false, writeReceipt: false });
    await writeFile(join(fixture.root, ".agenthawk-codex-integration.lock"), "{}\n");
    expect(await status(fixture)).toMatchObject({ ownership: "unsafe" });

    await rm(join(fixture.root, ".agenthawk-codex-integration.lock"));
    await mkdir(join(fixture.root, ".agenthawk", "integrations"), { recursive: true });
    await writeFile(
      join(fixture.root, ".agenthawk", "integrations", "codex-v1.json"),
      "x".repeat(8_193),
    );
    expect(await status(fixture)).toMatchObject({ ownership: "record_collision" });

    await rm(join(fixture.root, ".agenthawk"), { recursive: true });
    const external = join(fixture.root, "external");
    await mkdir(external);
    try {
      await symlink(external, join(fixture.root, ".agenthawk"), "junction");
      expect(await status(fixture)).toMatchObject({ ownership: "unsafe" });
    } catch (error) {
      if (!hasCode(error, "EPERM")) throw error;
    }
  });

  it("rejects oversized configuration, hard-linked targets, and oversized directories", async () => {
    const fixture = await ownedFixture();
    await writeFile(join(fixture.root, ".codex", "config.toml"), "x".repeat(262_145));
    expect(await status(fixture)).toMatchObject({ ownership: "unsafe" });

    await rm(join(fixture.root, ".codex", "config.toml"));
    await link(
      join(fixture.root, ".codex", "hooks.json"),
      join(fixture.root, ".codex", "hooks-copy.json"),
    );
    expect(await status(fixture)).toMatchObject({ ownership: "unsafe" });

    const root = await gitRoot();
    let reads = 0;
    let closed = false;
    const oversized = await statusCodexProjectHook(
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
    expect(JSON.parse(oversized.output)).toMatchObject({ ownership: "unsafe" });
    expect(reads).toBe(4_097);
    expect(closed).toBe(true);
  });

  it("reports a real linked worktree as an explicit blocker", async () => {
    const main = await gitRoot();
    const linked = `${main}-linked`;
    roots.push(linked);
    await git(main, ["worktree", "add", "--detach", linked]);
    const result = await statusCodexProjectHook(
      { format: "json" },
      { cwd: await realpath(linked) },
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ownership: "absent",
      readiness: "not_applicable",
      blockers: ["linked_worktree"],
    });
    expect(JSON.parse(result.output)).not.toHaveProperty("remediation");
    expect(result.exitCode).toBe(1);
  });

  it("admits submodules and main worktrees with a separate Git directory", async () => {
    const source = await gitRoot();
    const superproject = await gitRoot();
    await git(superproject, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      source,
      "child",
    ]);
    const child = await realpath(join(superproject, "child"));
    expect(
      JSON.parse((await statusCodexProjectHook({ format: "json" }, { cwd: child })).output),
    ).toMatchObject({ ownership: "absent", blockers: [] });

    const parent = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-separate-git-"));
    roots.push(parent);
    const worktree = join(parent, "worktree");
    const gitDirectory = join(parent, "git-directory");
    await run("git", ["init", "--quiet", "--separate-git-dir", gitDirectory, worktree], {
      windowsHide: true,
    });
    await writeFile(join(worktree, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    const canonicalWorktree = await realpath(worktree);
    expect(
      JSON.parse(
        (await statusCodexProjectHook({ format: "json" }, { cwd: canonicalWorktree })).output,
      ),
    ).toMatchObject({ ownership: "absent", blockers: [] });
  });

  it("turns malformed topology and directory alias collisions into bounded unsafe state", async () => {
    const root = await gitRoot();
    const malformed = await statusCodexProjectHook(
      { format: "json" },
      { cwd: root, runTopologyGit: async () => "relative\nmissing\nfields\n" },
    );
    expect(JSON.parse(malformed.output)).toMatchObject({ ownership: "unsafe", blockers: [] });

    const dotted = `${root}${sep}.${sep}`;
    const noncanonical = await statusCodexProjectHook(
      { format: "json" },
      { cwd: root, runTopologyGit: async () => `${dotted}\n${dotted}\n${dotted}\n` },
    );
    expect(JSON.parse(noncanonical.output)).toMatchObject({ ownership: "unsafe" });

    await mkdir(join(root, ".CODEX"));
    const alias = await statusCodexProjectHook({ format: "json" }, { cwd: root });
    expect(JSON.parse(alias.output)).toMatchObject({ ownership: "unsafe" });

    await rm(join(root, ".CODEX"), { recursive: true });
    await mkdir(join(root, ".ｃｏｄｅｘ"));
    const compatibilityAlias = await statusCodexProjectHook({ format: "json" }, { cwd: root });
    expect(JSON.parse(compatibilityAlias.output)).toMatchObject({ ownership: "unsafe" });
  });

  it("rejects parent and Git-topology identity changes across the two-pass snapshot", async () => {
    const root = await gitRoot();
    await mkdir(join(root, ".codex"));
    let rootReads = 0;
    const parentSwap = await statusCodexProjectHook(
      { format: "json" },
      {
        cwd: root,
        openDirectory: async (path) => {
          if (path === root && ++rootReads === 2) {
            await rename(join(root, ".codex"), join(root, ".codex-old"));
            await mkdir(join(root, ".codex"));
          }
          return await opendir(path);
        },
      },
    );
    expect(JSON.parse(parentSwap.output)).toMatchObject({ ownership: "unsafe" });

    const other = join(root, "other-git-directory");
    await mkdir(other);
    let topologyReads = 0;
    const topologySwap = await statusCodexProjectHook(
      { format: "json" },
      {
        cwd: root,
        runTopologyGit: async (arguments_, cwd) => {
          topologyReads += 1;
          if (topologyReads === 2) return `${root}\n${other}\n${other}\n`;
          return (await run("git", arguments_, { cwd, encoding: "utf8", windowsHide: true }))
            .stdout;
        },
      },
    );
    expect(JSON.parse(topologySwap.output)).toMatchObject({ ownership: "unsafe" });
  });

  it("propagates cancellation and emits no report", async () => {
    const root = await gitRoot();
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(
      statusCodexProjectHook({ format: "json", signal: controller.signal }, { cwd: root }),
    ).rejects.toThrow();
  });

  it("closes a directory when cancellation arrives during bounded enumeration", async () => {
    const root = await gitRoot();
    const controller = new AbortController();
    let closed = false;
    await expect(
      statusCodexProjectHook(
        { format: "json", signal: controller.signal },
        {
          cwd: root,
          openDirectory: async () => ({
            close: async () => {
              closed = true;
            },
            read: async () => {
              controller.abort(new Error("private cancellation reason"));
              return { name: ".git" };
            },
          }),
        },
      ),
    ).rejects.toThrow();
    expect(closed).toBe(true);
  });

  it("closes an opened file when cancellation arrives during observation", async () => {
    const fixture = await ownedFixture();
    const controller = new AbortController();
    let opened = false;
    let closed = false;
    let aborted = false;
    await expect(
      statusCodexProjectHook(
        { format: "json", signal: controller.signal },
        {
          ...fixture.dependencies,
          inspectPath: async (path) => {
            const stats = await lstat(path, { bigint: true });
            if (opened && !aborted && path.endsWith("hooks.json")) {
              aborted = true;
              controller.abort(new Error("private cancellation reason"));
            }
            return stats;
          },
          openFile: (async (path, flags, mode) => {
            const handle = await open(path, flags, mode);
            opened = true;
            const close = handle.close.bind(handle);
            handle.close = async () => {
              closed = true;
              await close();
            };
            return handle;
          }) as typeof open,
        },
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("uses a bounded internal-error envelope for an unexpected authority failure", async () => {
    const result = await statusCodexProjectHook(
      { format: "json" },
      {
        loadAuthority: async () => {
          throw new Error("private authority failure");
        },
      },
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output)).toEqual({
      schemaVersion: "1.0",
      error: {
        code: "internal_error",
        message: "Codex project-hook status could not be observed safely.",
      },
      exitCode: 4,
    });
    expect(result.output).not.toContain("private authority failure");
  });

  it("dispatches the nested CLI command through injected output handling", async () => {
    const root = await gitRoot();
    let output = "";
    let exitCode: number | undefined;
    const program = createProgram({
      cwd: root,
      write: (value) => (output += value),
      setExitCode: (value) => (exitCode = value),
    });
    await program.parseAsync(["integrations", "codex", "status", "--format", "json"], {
      from: "user",
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ command: "integrations_codex_status" });
  });
});

async function gitRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-codex-status-"));
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

async function ownedFixture(options: { writeHook?: boolean; writeReceipt?: boolean } = {}) {
  const root = await gitRoot();
  const adapterEntry = join(root, "adapter.js");
  const adapterBytes = Buffer.from("adapter fixture\n");
  await writeFile(adapterEntry, adapterBytes);
  const identity = await lstat(root, { bigint: true });
  const artifacts = buildCodexProjectHookArtifacts({
    adapterBytes,
    adapterEntry,
    adapterVersion: "0.1.0-alpha.1",
    installationId: "ab".repeat(32),
    nodeExecutable: await realpath(process.execPath),
    nodeVersion: process.version,
    repositoryIdentity: { dev: identity.dev, ino: identity.ino },
    repositoryRoot: root,
  });
  if (options.writeHook !== false) {
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(root, ".codex", "hooks.json"), artifacts.hookBytes);
  }
  if (options.writeReceipt !== false) {
    await mkdir(join(root, ".agenthawk", "integrations"), { recursive: true });
    await writeFile(
      join(root, ".agenthawk", "integrations", "codex-v1.json"),
      artifacts.receiptBytes,
    );
  }
  return {
    root,
    artifacts,
    dependencies: {
      adapterEntry,
      adapterVersion: "0.1.0-alpha.1",
      cwd: root,
      nodeExecutable: await realpath(process.execPath),
      nodeVersion: process.version,
    },
  };
}

async function status(fixture: Awaited<ReturnType<typeof ownedFixture>>) {
  const result = await statusCodexProjectHook({ format: "json" }, fixture.dependencies);
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd, windowsHide: true });
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
