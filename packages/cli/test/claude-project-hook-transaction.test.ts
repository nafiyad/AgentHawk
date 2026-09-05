import { execFile } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  open,
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
import { OperationCancelledError } from "@agenthawk/core";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeProjectHookLockBytes } from "../src/claude-project-hook-format.js";
import { statusClaudeProjectHook } from "../src/claude-project-hook-status.js";
import {
  installClaudeProjectHook,
  removeClaudeProjectHook,
  type TransactionCheckpoint,
} from "../src/claude-project-hook-transaction.js";
import { createProgram } from "../src/program.js";
import { loadRepositoryRootAuthority } from "../src/repository-authority.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Claude project-hook lifecycle", { timeout: 20_000 }, () => {
  it.each(["install", "remove"] as const)(
    "propagates %s authority cancellation without mutation",
    async (command) => {
      const fixture = await lifecycleFixture();
      const operation = command === "install" ? installClaudeProjectHook : removeClaudeProjectHook;
      await expect(
        operation(
          { format: "json" },
          {
            ...fixture.dependencies,
            loadRootAuthority: async () => {
              throw new OperationCancelledError();
            },
          },
        ),
      ).rejects.toBeInstanceOf(OperationCancelledError);
      await expect(
        readFile(join(fixture.root, ".agenthawk-claude-integration.lock")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["oversized", "opened", "read"] as const)(
    "rejects an adapter that is %s before publication",
    async (fault) => {
      const fixture = await lifecycleFixture();
      if (fault === "oversized")
        await writeFile(fixture.dependencies.adapterEntry, Buffer.alloc(1_048_577));
      let injected = fault === "oversized";
      const result = await installClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          openFile: async (...args) => {
            const handle = await open(...args);
            if (String(args[0]) !== fixture.dependencies.adapterEntry || injected) return handle;
            injected = true;
            if (fault === "opened") {
              await writeFile(
                fixture.dependencies.adapterEntry,
                "changed before open verification\n",
              );
              return handle;
            }
            return new Proxy(handle, {
              get(object, key) {
                if (key === "read")
                  return async (...values: unknown[]) => {
                    const result = await Reflect.apply(object.read, object, values);
                    await writeFile(
                      fixture.dependencies.adapterEntry,
                      "changed during bounded read\n",
                    );
                    return result;
                  };
                const value = Reflect.get(object, key);
                return typeof value === "function" ? value.bind(object) : value;
              },
            });
          },
        },
      );
      expect(injected).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).not.toContain(fixture.root);
      await expect(
        readFile(join(fixture.root, ".claude", "settings.local.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([".no-replace-probe", ".occupied-probe"])(
    "retains recovery state when deleting %s is denied",
    async (probe) => {
      const fixture = await lifecycleFixture();
      let injected = false;
      const result = await installClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          beforeUnlink: (path) => {
            if (path.endsWith(probe)) {
              injected = true;
              throw new Error("private cleanup diagnostic");
            }
          },
        },
      );
      expect(injected).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output).outcome).toBe("recovery_required");
      expect(result.output).not.toContain("private cleanup");
      expect(await status(fixture)).toMatchObject({
        blockers: expect.arrayContaining(["operation_locked"]),
      });
      await expect(
        readFile(join(fixture.root, ".claude", "settings.local.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a filesystem that changes an occupied destination despite EEXIST", async () => {
    const fixture = await lifecycleFixture();
    let injected = false;
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        linkFile: async (source, destination) => {
          if (String(destination).endsWith(".occupied-probe")) {
            injected = true;
            await writeFile(destination, "foreign occupied bytes\n");
            throw Object.assign(new Error("occupied"), { code: "EEXIST" });
          }
          return link(source, destination);
        },
      },
    );
    expect(injected).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).outcome).toBe("recovery_required");
    expect(await status(fixture)).toMatchObject({
      blockers: expect.arrayContaining(["operation_locked"]),
    });
    await expect(
      readFile(join(fixture.root, ".claude", "settings.local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "lock_created",
    "before_hook_remove",
    "hook_removed",
    "before_receipt_remove",
    "receipt_removed",
  ] as const)(
    "preserves foreign receipt bytes introduced at removal checkpoint %s",
    async (boundary) => {
      const fixture = await lifecycleFixture();
      expect(
        (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
      ).toBe(0);
      const receiptPath = join(fixture.root, ".agenthawk", "integrations", "claude-v1.json");
      const result = await removeClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: async (step) => {
            if (step === boundary) await writeFile(receiptPath, "foreign receipt\n");
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(await readFile(receiptPath, "utf8")).toBe("foreign receipt\n");
      expect(result.output).not.toContain(fixture.root);
    },
  );

  it.each(["hook_published", "before_cleanup"] as const)(
    "does not report installation success after settings drift at %s",
    async (boundary) => {
      const fixture = await lifecycleFixture();
      const settingsPath = join(fixture.root, ".claude", "settings.local.json");
      const result = await installClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: async (step) => {
            if (step === boundary) await writeFile(settingsPath, "foreign settings\n");
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output).outcome).toBe("recovery_required");
      expect(await readFile(settingsPath, "utf8")).toBe("foreign settings\n");
      expect(
        (await readFile(join(fixture.root, ".agenthawk", "integrations", "claude-v1.json"))).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each([
    ["lock", "writeFile"],
    ["lock", "sync"],
    ["lock", "stat"],
    ["lock", "close"],
    ["stage", "writeFile"],
    ["stage", "sync"],
    ["stage", "stat"],
    ["stage", "close"],
  ] as const)("fails closed on %s handle %s failure", async (target, method) => {
    const fixture = await lifecycleFixture();
    let injected = false;
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        openFile: async (...args) => {
          const handle = await open(...args);
          const selected =
            args[1] === "wx+" &&
            (target === "lock"
              ? String(args[0]).endsWith(".lock")
              : String(args[0]).endsWith("claude-v1.json"));
          if (!selected) return handle;
          return new Proxy(handle, {
            get(object, key) {
              if (key === method)
                return async (...values: unknown[]) => {
                  if (!injected) {
                    injected = true;
                    if (method === "close") await object.close();
                    throw new Error("private filesystem diagnostics must not escape");
                  }
                  return Reflect.apply(Reflect.get(object, key), object, values);
                };
              const value = Reflect.get(object, key);
              return typeof value === "function" ? value.bind(object) : value;
            },
          });
        },
      },
    );
    expect(injected).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("private filesystem");
    expect(result.output).not.toContain(fixture.root);
    if (target === "lock" && method === "close") {
      expect(JSON.parse(result.output).outcome).toBe("recovery_required");
      expect(await status(fixture)).toMatchObject({ ownership: "owned_exact" });
    } else {
      await expect(
        readFile(join(fixture.root, ".claude", "settings.local.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(fixture.root, "unrelated.txt"), "utf8")).toBe("preserve\n");
  });

  it.each(["parent", "staging"] as const)(
    "fails closed when %s directory creation is denied",
    async (target) => {
      const fixture = await lifecycleFixture();
      let injected = false;
      const result = await installClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          makeDirectory: (async (...args: Parameters<typeof mkdir>) => {
            if (target === "parent" || String(args[0]).includes(".agenthawk-claude-integration-")) {
              injected = true;
              throw Object.assign(new Error("private directory diagnostics"), { code: "EACCES" });
            }
            return mkdir(...args);
          }) as typeof mkdir,
        },
      );
      expect(injected).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).not.toContain("private directory");
      await expect(
        readFile(join(fixture.root, ".claude", "settings.local.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (target === "staging") {
        expect(JSON.parse(result.output).outcome).toBe("recovery_required");
        expect(await status(fixture)).toMatchObject({
          blockers: expect.arrayContaining(["operation_locked"]),
        });
      } else {
        await expect(
          readFile(join(fixture.root, ".agenthawk-claude-integration.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("retains a discoverable lock after ambiguous staging creation", async () => {
    const fixture = await lifecycleFixture();
    let stagedPath = "";
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        makeDirectory: (async (...args: Parameters<typeof mkdir>) => {
          const result = await mkdir(...args);
          if (String(args[0]).includes(".agenthawk-claude-integration-")) {
            stagedPath = String(args[0]);
            throw new Error("mkdir succeeded but completion was lost");
          }
          return result;
        }) as typeof mkdir,
      },
    );
    expect(stagedPath).not.toBe("");
    expect(await readdir(stagedPath)).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).outcome).toBe("recovery_required");
    expect(await status(fixture)).toMatchObject({
      blockers: expect.arrayContaining(["operation_locked"]),
    });
    await expect(
      readFile(join(fixture.root, ".claude", "settings.local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs a current root-bound pair and removes only that exact pair", async () => {
    const fixture = await lifecycleFixture();
    const installed = await installClaudeProjectHook({ format: "json" }, fixture.dependencies);
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.output)).toMatchObject({
      command: "integrations_claude_install",
      outcome: "installed",
      ownership: "owned_exact",
      readiness: "current",
      blockers: [],
      providersContacted: false,
    });
    expect(await status(fixture)).toMatchObject({ ownership: "owned_exact", readiness: "current" });
    expect(await readFile(join(fixture.root, ".claude", "settings.local.json"), "utf8")).toContain(
      "PreToolUse",
    );

    const removed = await removeClaudeProjectHook({ format: "json" }, fixture.dependencies);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.output)).toMatchObject({
      command: "integrations_claude_remove",
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
    await program.parseAsync(["integrations", "claude", "install", "--format", "json"], {
      from: "user",
    });
    await program.parseAsync(["integrations", "claude", "remove", "--format", "json"], {
      from: "user",
    });
    expect(exitCodes).toEqual([0, 0]);
    expect(outputs).toMatchObject([
      { command: "integrations_claude_install", outcome: "installed" },
      { command: "integrations_claude_remove", outcome: "removed" },
    ]);
  });

  it("uses the packaged runtime defaults when optional artifact metadata is omitted", async () => {
    const fixture = await lifecycleFixture();
    const dependencies = {
      adapterEntry: fixture.dependencies.adapterEntry,
      cwd: fixture.root,
    };
    const installed = await installClaudeProjectHook({ format: "json" }, dependencies);
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.output)).toMatchObject({ readiness: "current" });
    expect((await removeClaudeProjectHook({ format: "json" }, dependencies)).exitCode).toBe(0);
  });

  it("rejects a nested launch instead of writing outside canonical root authority", async () => {
    const fixture = await lifecycleFixture();
    const nested = join(fixture.root, "nested", "directory");
    await mkdir(nested, { recursive: true });
    const dependencies = { ...fixture.dependencies, cwd: nested };
    expect((await installClaudeProjectHook({ format: "json" }, dependencies)).exitCode).toBe(2);
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
    await expect(readFile(join(nested, ".claude", "settings.local.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses collisions and never replaces an unowned hook", async () => {
    const fixture = await lifecycleFixture();
    await writeFile(join(fixture.root, ".claude"), "foreign\n");
    const result = await installClaudeProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({ error: { code: "invalid_input" } });
    expect(await readFile(join(fixture.root, ".claude"), "utf8")).toBe("foreign\n");
  });

  it("rolls back a cancellation after receipt publication without activating the hook", async () => {
    const fixture = await lifecycleFixture();
    const controller = new AbortController();
    const checkpoints: TransactionCheckpoint[] = [];
    await expect(
      installClaudeProjectHook(
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
    expect(await readdir(fixture.root)).not.toContain(".agenthawk-claude-integration.lock");
  });

  it("allows only one concurrent installer to publish", async () => {
    const fixture = await lifecycleFixture();
    const first = installClaudeProjectHook(
      { format: "json" },
      { ...fixture.dependencies, createIdentifier: identifierSequence("a") },
    );
    const second = installClaudeProjectHook(
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
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    const hookPath = join(fixture.root, ".claude", "settings.local.json");
    await writeFile(hookPath, '{"hooks":{}}\n');
    const result = await removeClaudeProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(2);
    expect(await readFile(hookPath, "utf8")).toBe('{"hooks":{}}\n');
  });

  it("removes a valid inactive receipt and tolerates an unrelated configuration blocker", async () => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    await unlink(join(fixture.root, ".claude", "settings.local.json"));
    await writeFile(join(fixture.root, ".claude", "config.toml"), "[features]\nhooks = true\n");
    const result = await removeClaudeProjectHook({ format: "terminal" }, fixture.dependencies);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain("REMOVED");
    expect(await status(fixture)).toMatchObject({ ownership: "absent" });
  });

  it("rolls back cleanly when installation fails before and after receipt publication", async () => {
    for (const failurePoint of ["before_receipt_publish", "receipt_published"] as const) {
      const fixture = await lifecycleFixture();
      const result = await installClaudeProjectHook(
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
      expect(await readdir(fixture.root)).not.toContain(".agenthawk-claude-integration.lock");
    }
  });

  it("reports recovery when failure occurs after hook publication", async () => {
    const fixture = await lifecycleFixture();
    const result = await installClaudeProjectHook(
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
    const result = await installClaudeProjectHook(
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
    expect((await installClaudeProjectHook({ format: "json" }, before.dependencies)).exitCode).toBe(
      0,
    );
    const controller = new AbortController();
    await expect(
      removeClaudeProjectHook(
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
    expect((await installClaudeProjectHook({ format: "json" }, after.dependencies)).exitCode).toBe(
      0,
    );
    const result = await removeClaudeProjectHook(
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

  it("refuses foreign locks, shared hook collisions, missing artifacts, and target races", async () => {
    const lockFixture = await lifecycleFixture();
    await writeFile(
      join(lockFixture.root, ".agenthawk-claude-integration.lock"),
      buildClaudeProjectHookLockBytes("f".repeat(64)),
    );
    expect(
      (await installClaudeProjectHook({ format: "json" }, lockFixture.dependencies)).exitCode,
    ).toBe(2);

    const configFixture = await lifecycleFixture();
    await mkdir(join(configFixture.root, ".claude"));
    await writeFile(
      join(configFixture.root, ".claude", "settings.json"),
      '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[]}]}}\n',
    );
    expect(
      (await installClaudeProjectHook({ format: "json" }, configFixture.dependencies)).exitCode,
    ).toBe(2);

    const missingFixture = await lifecycleFixture();
    await unlink(missingFixture.dependencies.adapterEntry);
    expect(
      (await installClaudeProjectHook({ format: "json" }, missingFixture.dependencies)).exitCode,
    ).toBe(4);

    const raceFixture = await lifecycleFixture();
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...raceFixture.dependencies,
        checkpoint: async (name) => {
          if (name === "before_receipt_publish") {
            await writeFile(
              join(raceFixture.root, ".agenthawk", "integrations", "claude-v1.json"),
              "foreign\n",
            );
          }
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(
      await readFile(
        join(raceFixture.root, ".agenthawk", "integrations", "claude-v1.json"),
        "utf8",
      ),
    ).toBe("foreign\n");
  });

  it("fails closed when hard-link publication cannot prove no replacement", async () => {
    const fixture = await lifecycleFixture();
    let injectedDestination = 0;
    const result = await installClaudeProjectHook(
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
    const removeResult = await removeClaudeProjectHook({ format: "terminal" }, absent.dependencies);
    expect(removeResult.exitCode).toBe(2);
    expect(removeResult.output).toContain("cannot continue");

    const invalid = await lifecycleFixture();
    const installResult = await installClaudeProjectHook(
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
      (await removeClaudeProjectHook({ format: "json" }, { ...fixture.dependencies, cwd: nested }))
        .exitCode,
    ).toBe(2);
    const unexpected = await installClaudeProjectHook(
      { format: "terminal" },
      {
        ...fixture.dependencies,
        loadRootAuthority: async () => {
          throw new Error("private authority diagnostic");
        },
      },
    );
    expect(unexpected.exitCode).toBe(4);
    expect(unexpected.output).toBe("AgentHawk: Claude project-hook install failed safely.\n");
    expect(unexpected.output).not.toContain("private authority diagnostic");
  });

  it("accepts an ambiguous successful link only after exact identity verification", async () => {
    const fixture = await lifecycleFixture();
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        linkFile: async (source, destination) => {
          await link(source, destination);
          if (String(destination).endsWith("claude-v1.json")) {
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
    const unsupportedResult = await installClaudeProjectHook(
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
    const cleanupResult = await installClaudeProjectHook(
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
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    const result = await removeClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        unlinkFile: async (path) => {
          if (String(path).endsWith("settings.local.json")) {
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
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    await writeFile(
      join(fixture.root, ".agenthawk-claude-integration.lock"),
      buildClaudeProjectHookLockBytes("e".repeat(64)),
    );
    const result = await removeClaudeProjectHook({ format: "json" }, fixture.dependencies);
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
      const result = await installClaudeProjectHook(
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
                  value === ".claude" ||
                  value === ".agenthawk" ||
                  value === ".agenthawk-claude-integration.lock" ||
                  value.startsWith(".agenthawk-claude-integration-"),
              )) {
                await rename(join(replaced, entry), join(fixture.root, entry));
              }
            }
            if (target === "staging" && name === "staged_files_ready") {
              const entry = (await readdir(fixture.root)).find((value) =>
                value.startsWith(".agenthawk-claude-integration-"),
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
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        beforeRmdir: async (path) => {
          if (!path.includes(".agenthawk-claude-integration-")) return;
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
        (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
      ).toBe(0);
      const hookPath = join(fixture.root, ".claude", "settings.local.json");
      const settingsBytes = await readFile(hookPath);
      const result = await removeClaudeProjectHook(
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
      await expect(readFile(hookPath)).resolves.toEqual(settingsBytes);
    }
  });

  it("rejects authority identity drift before install or removal mutation", async () => {
    const installFixture = await lifecycleFixture();
    let installAuthorityCall = 0;
    const installResult = await installClaudeProjectHook(
      { format: "json" },
      {
        ...installFixture.dependencies,
        loadRootAuthority: async (root, options) => {
          const authority = await loadRepositoryRootAuthority(root, options);
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
      (await installClaudeProjectHook({ format: "json" }, removeFixture.dependencies)).exitCode,
    ).toBe(0);
    const hookPath = join(removeFixture.root, ".claude", "settings.local.json");
    const settingsBytes = await readFile(hookPath);
    let removeAuthorityCall = 0;
    const removeResult = await removeClaudeProjectHook(
      { format: "json" },
      {
        ...removeFixture.dependencies,
        loadRootAuthority: async (root, options) => {
          const authority = await loadRepositoryRootAuthority(root, options);
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
    await expect(readFile(hookPath)).resolves.toEqual(settingsBytes);
  });

  it("rejects byte-identical replacement of the acquired lock identity", async () => {
    const fixture = await lifecycleFixture();
    const lockPath = join(fixture.root, ".agenthawk-claude-integration.lock");
    const result = await installClaudeProjectHook(
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
    await expect(
      readFile(join(fixture.root, ".claude", "settings.local.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never deletes byte-identical hook replacements", async () => {
    const hookFixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, hookFixture.dependencies)).exitCode,
    ).toBe(0);
    const hookPath = join(hookFixture.root, ".claude", "settings.local.json");
    const settingsBytes = await readFile(hookPath);
    const hookResult = await removeClaudeProjectHook(
      { format: "json" },
      {
        ...hookFixture.dependencies,
        beforeUnlink: async (path) => {
          if (path === hookPath) {
            await rename(hookPath, `${hookPath}.original`);
            await writeFile(hookPath, settingsBytes);
          }
        },
      },
    );
    expect(hookResult.exitCode).toBe(1);
    await expect(readFile(hookPath)).resolves.toEqual(settingsBytes);
  });

  it("never deletes byte-identical receipt replacements", async () => {
    const receiptFixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, receiptFixture.dependencies)).exitCode,
    ).toBe(0);
    await unlink(join(receiptFixture.root, ".claude", "settings.local.json"));
    const receiptPath = join(receiptFixture.root, ".agenthawk", "integrations", "claude-v1.json");
    const receiptBytes = await readFile(receiptPath);
    const receiptResult = await removeClaudeProjectHook(
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

describe("Claude transaction-specific trust boundaries", { timeout: 30_000 }, () => {
  it.each(["install", "remove"] as const)(
    "redacts initial %s observation failures",
    async (command) => {
      const fixture = await lifecycleFixture();
      let calls = 0;
      const operation = command === "install" ? installClaudeProjectHook : removeClaudeProjectHook;
      const result = await operation(
        { format: "json" },
        {
          ...fixture.dependencies,
          loadRootAuthority: async (cwd, options) => {
            if (++calls > 1) throw new Error("private observation detail");
            return loadRepositoryRootAuthority(cwd, options);
          },
        },
      );
      expect(result.exitCode).toBe(4);
      expect(result.output).not.toContain("private observation detail");
      expect(await readdir(fixture.root)).not.toContain(".agenthawk-claude-integration.lock");
    },
  );

  it("refuses a settings hard link added immediately before deletion", async () => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    const settings = join(fixture.root, ".claude", "settings.local.json");
    const bytes = await readFile(settings);
    const result = await removeClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        beforeUnlink: async (path) => {
          if (path === settings) await link(path, `${path}.linked`);
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(await readFile(settings)).toEqual(bytes);
  });

  it("settles cancellation after settings deletion and preserves unrelated containers", async () => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    const controller = new AbortController();
    const result = await removeClaudeProjectHook(
      { format: "json", signal: controller.signal },
      {
        ...fixture.dependencies,
        checkpoint: (step) => {
          if (step === "hook_removed") controller.abort();
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output).outcome).toBe("removed");
    expect(await readdir(fixture.root)).toContain(".claude");
    expect(await readdir(join(fixture.root, ".agenthawk"))).toContain("integrations");
  });

  it("retains the canonical lock when staging cleanup throws", async () => {
    const fixture = await lifecycleFixture();
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        beforeRmdir: () => {
          throw new Error("private cleanup detail");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).not.toContain("private cleanup detail");
    expect((await status(fixture)).blockers).toContain("operation_locked");
  });

  it("checks the candidate staging ignore rule before acquiring any lock", async () => {
    const fixture = await lifecycleFixture();
    await writeFile(
      join(fixture.root, ".git", "info", "exclude"),
      ".claude/settings.local.json\n.agenthawk/integrations/claude-v1.json\n.agenthawk-claude-integration.lock\n",
    );
    const steps: string[] = [];
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        checkpoint: (step) => {
          steps.push(step);
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(steps).toEqual([]);
    expect(await readdir(fixture.root)).not.toContain(".agenthawk-claude-integration.lock");
  });

  it.each(["not_ignored", "unknown"] as const)(
    "refuses all mutation when ignore state is %s",
    async (state) => {
      const fixture = await lifecycleFixture();
      expect(
        (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
      ).toBe(0);
      const path = join(fixture.root, ".claude", "settings.local.json");
      const bytes = await readFile(path);
      const result = await removeClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          observeIntegrationIgnore: async () => state,
        },
      );
      expect(result.exitCode).toBe(2);
      expect(await readFile(path)).toEqual(bytes);
      expect(await readdir(fixture.root)).not.toContain(".agenthawk-claude-integration.lock");
    },
  );

  it("refuses tracked local settings even when an ignore rule matches", async () => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    await git(fixture.root, ["add", "-f", ".claude/settings.local.json"]);
    expect((await removeClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode).toBe(
      2,
    );
    expect((await status(fixture)).ownership).toBe("owned_exact");
  });

  it("rejects ignore drift under its lock before creating parents", async () => {
    const fixture = await lifecycleFixture();
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        checkpoint: async (step) => {
          if (step === "lock_created")
            await writeFile(join(fixture.root, ".git", "info", "exclude"), "");
        },
      },
    );
    expect(result.exitCode).toBe(2);
    expect(await readdir(fixture.root)).not.toContain(".claude");
  });

  it.each(["receipt", "shared", "ignore"] as const)(
    "revalidates %s before publishing settings",
    async (target) => {
      const fixture = await lifecycleFixture();
      const result = await installClaudeProjectHook(
        { format: "json" },
        {
          ...fixture.dependencies,
          checkpoint: async (step) => {
            if (step !== "before_hook_publish") return;
            if (target === "receipt")
              await writeFile(
                join(fixture.root, ".agenthawk", "integrations", "claude-v1.json"),
                "modified\n",
              );
            if (target === "shared")
              await writeFile(
                join(fixture.root, ".claude", "settings.json"),
                '{"disableAllHooks":true}\n',
              );
            if (target === "ignore")
              await writeFile(join(fixture.root, ".git", "info", "exclude"), "");
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      await expect(
        readFile(join(fixture.root, ".claude", "settings.local.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      if (target === "receipt")
        expect(
          await readFile(
            join(fixture.root, ".agenthawk", "integrations", "claude-v1.json"),
            "utf8",
          ),
        ).toBe("modified\n");
    },
  );

  it("preserves the receipt when settings publication succeeds but verification fails", async () => {
    const fixture = await lifecycleFixture();
    const lockPath = join(fixture.root, ".agenthawk-claude-integration.lock");
    const settingsPath = join(fixture.root, ".claude", "settings.local.json");
    const result = await installClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        linkFile: async (source, destination) => {
          await link(source, destination);
          if (String(destination) === settingsPath) await writeFile(lockPath, "foreign\n");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).outcome).toBe("recovery_required");
    expect((await readFile(settingsPath)).length).toBeGreaterThan(0);
    expect(
      (await readFile(join(fixture.root, ".agenthawk", "integrations", "claude-v1.json"))).length,
    ).toBeGreaterThan(0);
    expect(await readFile(lockPath, "utf8")).toBe("foreign\n");
  });

  it.each(["settings", "receipt"] as const)("never deletes in-place changed %s", async (target) => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    const path =
      target === "settings"
        ? join(fixture.root, ".claude", "settings.local.json")
        : join(fixture.root, ".agenthawk", "integrations", "claude-v1.json");
    const result = await removeClaudeProjectHook(
      { format: "json" },
      {
        ...fixture.dependencies,
        beforeUnlink: async (candidate) => {
          if (candidate === path) await writeFile(path, "changed in place\n");
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe("changed in place\n");
  });

  it("removes an exact old pair despite artifact drift and shared hook blockers", async () => {
    const fixture = await lifecycleFixture();
    expect(
      (await installClaudeProjectHook({ format: "json" }, fixture.dependencies)).exitCode,
    ).toBe(0);
    await writeFile(fixture.dependencies.adapterEntry, "changed adapter\n");
    await writeFile(join(fixture.root, ".claude", "settings.json"), '{"disableAllHooks":true}\n');
    const result = await removeClaudeProjectHook({ format: "json" }, fixture.dependencies);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ outcome: "removed", activation: "unproven" });
    expect(await readFile(join(fixture.root, ".claude", "settings.json"), "utf8")).toBe(
      '{"disableAllHooks":true}\n',
    );
  });
});

async function lifecycleFixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-claude-lifecycle-"));
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
  await writeFile(
    join(root, ".git", "info", "exclude"),
    [
      ".claude/settings.local.json",
      ".agenthawk/integrations/claude-v1.json",
      ".agenthawk-claude-integration.lock",
      ".agenthawk-claude-integration-*",
      "",
    ].join("\n"),
  );
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
  const result = await statusClaudeProjectHook({ format: "json" }, fixture.dependencies);
  return JSON.parse(result.output) as Record<string, unknown>;
}

function identifierSequence(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}${String(counter++).padStart(63, "0")}`;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await run("git", args, { cwd, windowsHide: true });
}
