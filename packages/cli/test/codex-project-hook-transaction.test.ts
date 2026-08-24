import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexProjectHookLockBytes } from "../src/codex-project-hook-format.js";
import { statusCodexProjectHook } from "../src/codex-project-hook-status.js";
import {
  installCodexProjectHook,
  removeCodexProjectHook,
  type TransactionCheckpoint,
} from "../src/codex-project-hook-transaction.js";
import { createProgram } from "../src/program.js";
import { loadRepositoryAuthority } from "../src/repository-authority.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Codex project-hook lifecycle", { timeout: 20_000 }, () => {
  it("installs a current root-bound pair and removes only that exact pair", async () => {
    const fixture = await lifecycleFixture();
    const installed = await installCodexProjectHook({ format: "json" }, fixture.dependencies);
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.output)).toMatchObject({
      command: "integrations_codex_install",
      outcome: "installed",
      ownership: "owned_exact",
      readiness: "current",
      blockers: [],
      providersContacted: false,
    });
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact", readiness: "current" });
    expect(await readFile(join(fixture.root, ".codex", "hooks.json"), "utf8")).toContain(
      "PreToolUse",
    );

    const removed = await removeCodexProjectHook({ format: "json" }, fixture.dependencies);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.output)).toMatchObject({
      command: "integrations_codex_remove",
      outcome: "removed",
      ownership: "absent",
      readiness: "not_applicable",
    });
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
    expect(await readdir(fixture.root)).toContain("unrelated.txt");
  });

  it("dispatches install and remove through the public nested CLI", async () => {
    const fixture = await lifecycleFixture();
    const outputs: unknown[] = [];
    const exitCodes: number[] = [];
    const program = createProgram({
      ...fixture.dependencies,
      setExitCode: (code) => exitCodes.push(code),
      write: (output) => outputs.push(JSON.parse(output)),
    });
    await program.parseAsync(["integrations", "codex", "install", "--format", "json"], {
      from: "user",
    });
    await program.parseAsync(["integrations", "codex", "remove", "--format", "json"], {
      from: "user",
    });
    expect(exitCodes).toEqual([0, 0]);
    expect(outputs).toMatchObject([
      { command: "integrations_codex_install", outcome: "installed" },
      { command: "integrations_codex_remove", outcome: "removed" },
    ]);
  });

  it("uses the packaged runtime defaults when optional artifact metadata is omitted", async () => {
    const fixture = await lifecycleFixture();
    const dependencies = {
      adapterEntry: fixture.dependencies.adapterEntry,
      cwd: fixture.root,
    };
    const installed = await installCodexProjectHook({ format: "json" }, dependencies);
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.output)).toMatchObject({ readiness: "current" });
    expect((await removeCodexProjectHook({ format: "json" }, dependencies)).exitCode).toBe(0);
  });

  it("rejects a nested launch instead of writing outside canonical root authority", async () => {
    const fixture = await lifecycleFixture();
    const nested = join(fixture.root, "nested", "directory");
    await mkdir(nested, { recursive: true });
    const dependencies = { ...fixture.dependencies, cwd: nested };
    expect((await installCodexProjectHook({ format: "json" }, dependencies)).exitCode).toBe(2);
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
    await expect(readFile(join(nested, ".codex", "hooks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses collisions and never replaces an unowned hook", async () => {
    const fixture = await lifecycleFixture();
    await writeFile(join(fixture.root, ".codex"), "foreign\n");
    const result = await installCodexProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ error: { code: "invalid_input" } });
    expect(await readFile(join(fixture.root, ".codex"), "utf8")).toBe("foreign\n");
  });

  it("rolls back a cancellation after receipt publication without activating the hook", async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    const checkpoints: TransactionCheckpoint[] = [];
    await expect(
      installCodexProjectHook(
        { format: "json", signal: controller.signal },
        {
          ...fixture.dependencies,
          checkpoint: (name) => {
            checkpoints.push(name);
            if (name === "receipt_published") controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "OperationCancelledError" });
    expect(checkpoints).toContain("receipt_published");
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
    expect(await readdir(fixture.root)).not.toContain(".agenthawk-codex-integration.lock");
  });

  it("allows only one concurrent installer to publish", async () => {
    const fixture = await lifecycleFixture();
    const first = installCodexProjectHook(
      { format: "json" },
      { ...fixture.dependencies, createIdentifier: identifierSequence("a") },
    );
    const second = installCodexProjectHook(
      { format: "json" },
      { ...fixture.dependencies, createIdentifier: identifierSequence("b") },
    );
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact", readiness: "current" });
  });

  it("refuses removal after owned hook mutation", async () => {
    const fixture = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, fixture.dependencies)).exitCode).toBe(
      0,
    );
    const hookPath = join(fixture.root, ".codex", "hooks.json");
    await writeFile(hookPath, '{"hooks":{}}\n');
    const result = await removeCodexProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(2);
    expect(await readFile(hookPath, "utf8")).toBe('{"hooks":{}}\n');
  });

  it("removes a valid inactive receipt and tolerates an unrelated configuration blocker", async () => {
    const fixture = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, fixture.dependencies)).exitCode).toBe(
      0,
    );
    await unlink(join(fixture.root, ".codex", "hooks.json"));
    await writeFile(join(fixture.root, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const result = await removeCodexProjectHook({ format: "terminal" }, fixture.dependencies);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("REMOVED");
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
  });

  it("rolls back cleanly when installation fails before and after receipt publication", async () => {
    for (const failurePoint of ["before_receipt_publish", "receipt_published"] as const) {
      const fixture = await lifecycleFixture();
      const result = await installCodexProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: (name) => {
            if (name === failurePoint) throw new Error("injected failure");
          },
        },
      );
      expect(result.exitCode).toBe(4);
      expect(await status(fixture)).toMatchObject({ ownership: "absent" });
      expect(await readdir(fixture.root)).not.toContain(".agenthawk-codex-integration.lock");
    }
  });

  it("reports recovery when failure occurs after hook publication", async () => {
    const fixture = await lifecycleFixture();
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        checkpoint: (name) => {
          if (name === "hook_published") throw new Error("injected post-commit failure");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "recovery_required" });
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact" });
  });

  it("defers cancellation after hook publication and returns the verified installed state", async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    const result = await installCodexProjectHook(
      { format: "json", signal: controller.signal },
      {
        ...fixture.dependencies,
        checkpoint: (name) => {
          if (name === "hook_published") controller.abort();
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "installed" });
  });

  it("cancels removal before deletion and reports recovery after its commit point", async () => {
    const before = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, before.dependencies)).exitCode).toBe(
      0,
    );
    const controller = new AbortController();
    await expect(
      removeCodexProjectHook(
        { format: "json", signal: controller.signal },
        {
          ...before.dependencies,
          checkpoint: (name) => {
            if (name === "before_hook_remove") controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "OperationCancelledError" });
    expect(await status(before)).toMatchObject({ ownership: "owned_exact" });

    const after = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, after.dependencies)).exitCode).toBe(
      0,
    );
    const result = await removeCodexProjectHook(
      { format: "json" },
      {
        ...after.dependencies,
        checkpoint: (name) => {
          if (name === "hook_removed") throw new Error("injected post-commit failure");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "recovery_required" });
    expect(await status(after)).toMatchObject({ ownership: "owned_inactive" });
  });

  it("refuses foreign locks, config collisions, missing artifacts, and target races", async () => {
    const lockFixture = await lifecycleFixture();
    await writeFile(
      join(lockFixture.root, ".agenthawk-codex-integration.lock"),
      buildCodexProjectHookLockBytes("f".repeat(64)),
    );
    expect(
      (await installCodexProjectHook({ format: "json" }, lockFixture.dependencies)).exitCode,
    ).toBe(2);

    const configFixture = await lifecycleFixture();
    await mkdir(join(configFixture.root, ".codex"));
    await writeFile(join(configFixture.root, ".codex", "config.toml"), "[features]\n");
    expect(
      (await installCodexProjectHook({ format: "json" }, configFixture.dependencies)).exitCode,
    ).toBe(2);

    const missingFixture = await lifecycleFixture();
    await unlink(missingFixture.dependencies.adapterEntry);
    expect(
      (await installCodexProjectHook({ format: "json" }, missingFixture.dependencies)).exitCode,
    ).toBe(4);

    const raceFixture = await lifecycleFixture();
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...raceFixture.dependencies,
        checkpoint: async (name) => {
          if (name === "before_receipt_publish") {
            await writeFile(
              join(raceFixture.root, ".agenthawk", "integrations", "codex-v1.json"),
              "foreign\n",
            );
          }
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(
      await readFile(join(raceFixture.root, ".agenthawk", "integrations", "codex-v1.json"), "utf8"),
    ).toBe("foreign\n");
  });

  it("fails closed when hard-link publication cannot prove no replacement", async () => {
    const fixture = await lifecycleFixture();
    let injectedDestination = 0;
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        linkFile: async (source, destination) => {
          if (String(destination).endsWith(".no-replace-probe")) {
            await link(source, `${destination}-${injectedDestination++}`);
            return;
          }
          await link(source, destination);
        },
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(await status(fixture)).not.toMatchObject({ ownership: "owned_exact" });
  });

  it("returns bounded failures for absent removal and invalid generated identifiers", async () => {
    const absent = await lifecycleFixture();
    const removeResult = await removeCodexProjectHook({ format: "terminal" }, absent.dependencies);
    expect(removeResult.exitCode).toBe(2);
    expect(removeResult.output).toContain("cannot continue");

    const invalid = await lifecycleFixture();
    const installResult = await installCodexProjectHook(
      { format: "json" },
      { ...invalid.dependencies, createIdentifier: () => "invalid" },
    );
    expect(installResult.exitCode).toBe(4);
    expect(JSON.parse(installResult.output)).toMatchObject({ error: { code: "internal_error" } });
  });

  it("bounds authority failures for both lifecycle commands", async () => {
    const fixture = await lifecycleFixture();
    const nested = join(fixture.root, "nested");
    await mkdir(nested);
    expect(
      (await removeCodexProjectHook({ format: "json" }, { ...fixture.dependencies, cwd: nested }))
        .exitCode,
    ).toBe(2);
    const unexpected = await installCodexProjectHook(
      { format: "terminal" },
      {
        ...fixture.dependencies,
        loadAuthority: async () => {
          throw new Error("private authority diagnostic");
        },
      },
    );
    expect(unexpected.exitCode).toBe(4);
    expect(unexpected.output).toBe("AgentHawk: Codex project-hook install failed safely.\n");
    expect(unexpected.output).not.toContain("private authority diagnostic");
  });

  it("accepts an ambiguous successful link only after exact identity verification", async () => {
    const fixture = await lifecycleFixture();
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        linkFile: async (source, destination) => {
          await link(source, destination);
          if (String(destination).endsWith("codex-v1.json")) {
            throw new Error("injected ambiguous completion");
          }
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact" });
  });

  it("fails closed on unsupported occupied-target behavior and directory cleanup failure", async () => {
    const unsupported = await lifecycleFixture();
    const unsupportedResult = await installCodexProjectHook(
      { format: "json" },
      {
        ...unsupported.dependencies,
        linkFile: async (source, destination) => {
          if (String(destination).endsWith(".occupied-probe")) {
            throw Object.assign(new Error("unsupported"), { code: "EPERM" });
          }
          await link(source, destination);
        },
      },
    );
    expect(unsupportedResult.exitCode).not.toBe(0);

    const cleanup = await lifecycleFixture();
    const cleanupResult = await installCodexProjectHook(
      { format: "json" },
      {
        ...cleanup.dependencies,
        removeDirectory: async () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    );
    expect(cleanupResult.exitCode).toBe(1);
    expect(JSON.parse(cleanupResult.output)).toMatchObject({ outcome: "recovery_required" });
  });

  it("keeps exact files when injected unlink failures make cleanup unprovable", async () => {
    const fixture = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, fixture.dependencies)).exitCode).toBe(
      0,
    );
    const result = await removeCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        unlinkFile: async (path) => {
          if (String(path).endsWith("hooks.json")) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          await unlink(path);
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact" });
  });

  it("refuses to remove an exact owned pair while a foreign operation lock exists", async () => {
    const fixture = await lifecycleFixture();
    expect((await installCodexProjectHook({ format: "json" }, fixture.dependencies)).exitCode).toBe(
      0,
    );
    await writeFile(
      join(fixture.root, ".agenthawk-codex-integration.lock"),
      buildCodexProjectHookLockBytes("e".repeat(64)),
    );
    const result = await removeCodexProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(2);
    expect(await status(fixture)).toMatchObject({
      ownership: "owned_exact",
      blockers: ["operation_locked"],
    });
  });

  it("rejects full parent-chain and staging identity replacement before publication", async () => {
    for (const target of ["leaf", "intermediate", "root", "staging"] as const) {
      const fixture = await lifecycleFixture();
      const external = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-external-"));
      roots.push(external);
      const result = await installCodexProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: async (name) => {
            if (target === "leaf" && name === "before_receipt_publish") {
              const parent = join(fixture.root, ".agenthawk", "integrations");
              await rename(parent, `${parent}-replaced`);
              await symlink(external, parent, process.platform === "win32" ? "junction" : "dir");
            }
            if (target === "intermediate" && name === "before_receipt_publish") {
              const parent = join(fixture.root, ".agenthawk");
              const replaced = `${parent}-replaced`;
              await rename(parent, replaced);
              await mkdir(parent);
              await rename(join(replaced, "integrations"), join(parent, "integrations"));
            }
            if (target === "root" && name === "before_receipt_publish") {
              const replaced = `${fixture.root}-replaced`;
              roots.push(replaced);
              await rename(fixture.root, replaced);
              await mkdir(fixture.root);
              const entries = await readdir(replaced);
              for (const entry of entries.filter(
                (value) =>
                  value === ".codex" ||
                  value === ".agenthawk" ||
                  value === ".agenthawk-codex-integration.lock" ||
                  value.startsWith(".agenthawk-codex-integration-"),
              )) {
                await rename(join(replaced, entry), join(fixture.root, entry));
              }
            }
            if (target === "staging" && name === "staged_files_ready") {
              const entry = (await readdir(fixture.root)).find((value) =>
                value.startsWith(".agenthawk-codex-integration-"),
              );
              if (!entry) throw new Error("staging directory was not found");
              const staging = join(fixture.root, entry);
              await rename(staging, `${staging}-replaced`);
              await symlink(external, staging, process.platform === "win32" ? "junction" : "dir");
            }
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(await readdir(external)).toEqual([]);
    }
  });

  it("does not remove a replacement staging directory during cleanup", async () => {
    const fixture = await lifecycleFixture();
    let replacedPath = "";
    let originalPath = "";
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        beforeRmdir: async (path) => {
          if (!path.includes(".agenthawk-codex-integration-")) return;
          replacedPath = path;
          originalPath = `${path}.original`;
          await rename(path, originalPath);
          await mkdir(path);
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "recovery_required" });
    await expect(readdir(replacedPath)).resolves.toEqual([]);
    await expect(readdir(originalPath)).resolves.toEqual([]);
  });

  it("rejects intermediate and root identity replacement before removal", async () => {
    for (const target of ["intermediate", "root"] as const) {
      const fixture = await lifecycleFixture();
      expect(
        (await installCodexProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
      ).toBe(0);
      const hookPath = join(fixture.root, ".codex", "hooks.json");
      const hookBytes = await readFile(hookPath);
      const result = await removeCodexProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: async (name) => {
            if (name !== "before_hook_remove") return;
            if (target === "intermediate") {
              const parent = join(fixture.root, ".agenthawk");
              const replaced = `${parent}-replaced`;
              await rename(parent, replaced);
              await mkdir(parent);
              await rename(join(replaced, "integrations"), join(parent, "integrations"));
            } else {
              const replaced = `${fixture.root}-replaced`;
              roots.push(replaced);
              await rename(fixture.root, replaced);
              await mkdir(fixture.root);
              for (const entry of await readdir(replaced)) {
                await rename(join(replaced, entry), join(fixture.root, entry));
              }
            }
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      await expect(readFile(hookPath)).resolves.toEqual(hookBytes);
    }
  });

  it("rejects authority identity drift before install or removal mutation", async () => {
    const installFixture = await lifecycleFixture();
    let installAuthorityCall = 0;
    const installResult = await installCodexProjectHook(
      { format: "json" },
      {
        ...installFixture.dependencies,
        loadAuthority: async (root, options) => {
          const authority = await loadRepositoryAuthority(root, options);
          installAuthorityCall += 1;
          return installAuthorityCall === 1
            ? {
                ...authority,
                repositoryIdentity: {
                  ...authority.repositoryIdentity,
                  ino: authority.repositoryIdentity.ino + 1n,
                },
              }
            : authority;
        },
      },
    );
    expect(installResult.exitCode).toBe(2);
    expect(await status(installFixture)).toMatchObject({ ownership: "absent" });

    const removeFixture = await lifecycleFixture();
    expect(
      (await installCodexProjectHook({ format: "json" }, removeFixture.dependencies)).exitCode,
    ).toBe(0);
    const hookPath = join(removeFixture.root, ".codex", "hooks.json");
    const hookBytes = await readFile(hookPath);
    let removeAuthorityCall = 0;
    const removeResult = await removeCodexProjectHook(
      { format: "json" },
      {
        ...removeFixture.dependencies,
        loadAuthority: async (root, options) => {
          const authority = await loadRepositoryAuthority(root, options);
          removeAuthorityCall += 1;
          return removeAuthorityCall === 1
            ? {
                ...authority,
                repositoryIdentity: {
                  ...authority.repositoryIdentity,
                  ino: authority.repositoryIdentity.ino + 1n,
                },
              }
            : authority;
        },
      },
    );
    expect(removeResult.exitCode).toBe(2);
    await expect(readFile(hookPath)).resolves.toEqual(hookBytes);
  });

  it("rejects byte-identical replacement of the acquired lock identity", async () => {
    const fixture = await lifecycleFixture();
    const lockPath = join(fixture.root, ".agenthawk-codex-integration.lock");
    const result = await installCodexProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        checkpoint: async (name) => {
          if (name === "capability_verified") {
            const bytes = await readFile(lockPath);
            await rename(lockPath, `${lockPath}.original`);
            await writeFile(lockPath, bytes);
          }
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "recovery_required" });
    await expect(readFile(join(fixture.root, ".codex", "hooks.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never deletes byte-identical hook or receipt replacements", async () => {
    const hookFixture = await lifecycleFixture();
    expect(
      (await installCodexProjectHook({ format: "json" }, hookFixture.dependencies)).exitCode,
    ).toBe(0);
    const hookPath = join(hookFixture.root, ".codex", "hooks.json");
    const hookBytes = await readFile(hookPath);
    const hookResult = await removeCodexProjectHook(
      { format: "json" },
      {
        ...hookFixture.dependencies,
        beforeUnlink: async (path) => {
          if (path === hookPath) {
            await rename(hookPath, `${hookPath}.original`);
            await writeFile(hookPath, hookBytes);
          }
        },
      },
    );
    expect(hookResult.exitCode).toBe(1);
    await expect(readFile(hookPath)).resolves.toEqual(hookBytes);

    const receiptFixture = await lifecycleFixture();
    expect(
      (await installCodexProjectHook({ format: "json" }, receiptFixture.dependencies)).exitCode,
    ).toBe(0);
    await unlink(join(receiptFixture.root, ".codex", "hooks.json"));
    const receiptPath = join(receiptFixture.root, ".agenthawk", "integrations", "codex-v1.json");
    const receiptBytes = await readFile(receiptPath);
    const receiptResult = await removeCodexProjectHook(
      { format: "json" },
      {
        ...receiptFixture.dependencies,
        beforeUnlink: async (path) => {
          if (path === receiptPath) {
            await rename(receiptPath, `${receiptPath}.original`);
            await writeFile(receiptPath, receiptBytes);
          }
        },
      },
    );
    expect(receiptResult.exitCode).toBe(1);
    await expect(readFile(receiptPath)).resolves.toEqual(receiptBytes);
  });
});

async function lifecycleFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-codex-lifecycle-"));
  roots.push(root);
  await git(root, ["init", "--quiet"]);
  await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(join(root, "unrelated.txt"), "preserve\n");
  await git(root, ["add", "package.json", "unrelated.txt"]);
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
  const canonicalRoot = await realpath(root);
  const adapterEntry = join(canonicalRoot, "adapter.js");
  await writeFile(adapterEntry, "adapter fixture\n");
  return {
    root: canonicalRoot,
    dependencies: {
      adapterEntry,
      adapterVersion: "0.1.0-alpha.1",
      cwd: canonicalRoot,
      nodeExecutable: await realpath(process.execPath),
      nodeVersion: process.version,
    },
  };
}

async function status(fixture: Awaited<ReturnType<typeof lifecycleFixture>>) {
  const result = await statusCodexProjectHook({ format: "json" }, fixture.dependencies);
  return JSON.parse(result.output) as Record<string, unknown>;
}

function identifierSequence(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}${String(counter++).padStart(63, "0")}`;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd, windowsHide: true });
}
