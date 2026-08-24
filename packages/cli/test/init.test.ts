import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initReportSchema } from "@agenthawk/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRepository } from "../src/init.js";
import { INIT_POLICY, initAssets } from "../src/init-content.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-init-"));
  roots.push(root);
  return root;
}

describe("init", () => {
  it.each(["none", "codex", "claude", "cursor", "generic"] as const)(
    "creates deterministic %s assets and is exactly idempotent",
    async (integration) => {
      const cwd = await repository();
      const fetchSpy = vi.fn(async () => {
        throw new Error("network must not run");
      });
      vi.stubGlobal("fetch", fetchSpy);
      try {
        const first = await initializeRepository(
          { format: "json", integration },
          { cwd, uuid: () => "00000000-0000-4000-8000-000000000001" },
        );
        expect(first.exitCode).toBe(0);
        const firstReport = initReportSchema.parse(JSON.parse(first.output));
        expect(firstReport.created).toEqual(
          integration === "none" ? ["policy"] : ["policy", integration],
        );
        expect(firstReport.unchanged).toEqual([]);
        for (const asset of initAssets(integration)) {
          await expect(readFile(join(cwd, ...asset.segments), "utf8")).resolves.toBe(asset.content);
        }

        const second = await initializeRepository({ format: "json", integration }, { cwd });
        expect(second.exitCode).toBe(0);
        expect(initReportSchema.parse(JSON.parse(second.output)).unchanged).toEqual(
          integration === "none" ? ["policy"] : ["policy", integration],
        );
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("aborts all writes when a target contains different content", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "AGENTS.md"), "owner instructions\n", "utf8");
    const result = await initializeRepository({ format: "json", integration: "codex" }, { cwd });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.output)).toMatchObject({
      error: { code: "invalid_input" },
      exitCode: 2,
    });
    await expect(readFile(join(cwd, "AGENTS.md"), "utf8")).resolves.toBe("owner instructions\n");
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(result.output).not.toContain("owner instructions");
    expect(result.output).not.toContain(cwd);
  });

  it("rejects same-size different bytes after bounded inspection", async () => {
    const cwd = await repository();
    await writeFile(
      join(cwd, ".agenthawk.yml"),
      "x".repeat(Buffer.byteLength(INIT_POLICY)),
      "utf8",
    );
    const result = await initializeRepository({ format: "json", integration: "none" }, { cwd });
    expect(result.exitCode).toBe(2);
  });

  it("detects target identity replacement during exact-byte inspection", async () => {
    const cwd = await repository();
    const path = join(cwd, ".agenthawk.yml");
    const replacement = join(cwd, "replacement-policy.yml");
    await writeFile(path, INIT_POLICY, "utf8");
    await writeFile(replacement, INIT_POLICY, "utf8");
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        afterTargetInspect: async (_target, inspectedPath) => {
          await unlink(inspectedPath);
          await link(replacement, inspectedPath);
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(path, "utf8")).resolves.toBe(INIT_POLICY);
  });

  it.each([
    {
      asset: { content: INIT_POLICY, segments: [".."] as const, target: "policy" as const },
      exitCode: 2,
      label: "invalid target segment",
    },
    {
      asset: { content: INIT_POLICY, segments: [""] as const, target: "policy" as const },
      exitCode: 2,
      label: "empty target segment",
    },
    {
      asset: { content: INIT_POLICY, segments: ["."] as const, target: "policy" as const },
      exitCode: 2,
      label: "dot target segment",
    },
    {
      asset: {
        content: INIT_POLICY,
        segments: ["nested/name"] as const,
        target: "policy" as const,
      },
      exitCode: 2,
      label: "slash target segment",
    },
    {
      asset: {
        content: INIT_POLICY,
        segments: ["nested\\name"] as const,
        target: "policy" as const,
      },
      exitCode: 2,
      label: "backslash target segment",
    },
    {
      asset: { content: INIT_POLICY, segments: ["drive:name"] as const, target: "policy" as const },
      exitCode: 2,
      label: "colon target segment",
    },
    {
      asset: { content: INIT_POLICY, segments: [] as const, target: "policy" as const },
      exitCode: 2,
      label: "root target mapping",
    },
    {
      asset: { content: "", segments: ["policy.yml"] as const, target: "policy" as const },
      exitCode: 4,
      label: "empty content",
    },
    {
      asset: {
        content: `${"x".repeat(32_768)}\n`,
        segments: ["policy.yml"] as const,
        target: "policy" as const,
      },
      exitCode: 4,
      label: "oversized content",
    },
    {
      asset: {
        content: "version: 1",
        segments: ["policy.yml"] as const,
        target: "policy" as const,
      },
      exitCode: 4,
      label: "unterminated content",
    },
  ])("rejects bundled $label before mutation", async ({ asset, exitCode }) => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      { assets: () => [asset], cwd },
    );
    expect(result.exitCode).toBe(exitCode);
    await expect(readFile(join(cwd, "policy.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resumes an exact partial initialization without claiming ownership", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, ".agenthawk.yml"), INIT_POLICY, "utf8");
    const result = await initializeRepository({ format: "json", integration: "claude" }, { cwd });
    const report = initReportSchema.parse(JSON.parse(result.output));
    expect(report).toMatchObject({ created: ["claude"], unchanged: ["policy"] });
  });

  it("renders a bounded terminal summary for created and unchanged targets", async () => {
    const cwd = await repository();
    const created = await initializeRepository(
      { format: "terminal", integration: "none" },
      { cwd },
    );
    expect(created).toMatchObject({ exitCode: 0 });
    expect(created.output).toContain("Created: policy");
    expect(created.output).toContain("Unchanged: none");

    const unchanged = await initializeRepository(
      { format: "terminal", integration: "none" },
      { cwd },
    );
    expect(unchanged.output).toContain("Created: none");
    expect(unchanged.output).toContain("Unchanged: policy");
  });

  it("uses the process working directory only when no root is injected", async () => {
    const cwd = await repository();
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const result = await initializeRepository({ format: "json", integration: "none" });
      expect(result.exitCode).toBe(0);
      await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).resolves.toBe(INIT_POLICY);
    } finally {
      process.chdir(previous);
    }
  });

  it("rejects case collisions before writing policy", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "agents.md"), "different\n", "utf8");
    const result = await initializeRepository({ format: "json", integration: "codex" }, { cwd });
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a symbolic parent without writing through it", async () => {
    const cwd = await repository();
    const external = await repository();
    await symlink(
      external,
      join(cwd, ".cursor"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await initializeRepository({ format: "json", integration: "cursor" }, { cwd });
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(external, "rules", "agenthawk.mdc"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["directory", "hardlink", "symlink"] as const)(
    "rejects an existing %s target without modifying it",
    async (kind) => {
      const cwd = await repository();
      const target = join(cwd, ".agenthawk.yml");
      if (kind === "directory") {
        await mkdir(target);
      } else {
        const source = join(cwd, "owner-policy.yml");
        await writeFile(source, INIT_POLICY, "utf8");
        if (kind === "hardlink") await link(source, target);
        else await symlink(source, target, "file");
      }

      const result = await initializeRepository({ format: "json", integration: "none" }, { cwd });
      expect(result.exitCode).toBe(2);
      if (kind !== "directory") {
        await expect(readFile(target, "utf8")).resolves.toBe(INIT_POLICY);
      }
    },
  );

  it("rejects a non-directory parent and rolls back policy", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, ".cursor"), "owner content\n", "utf8");
    const result = await initializeRepository({ format: "json", integration: "cursor" }, { cwd });
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".cursor"), "utf8")).resolves.toBe("owner content\n");
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("handles a parent created concurrently as an existing verified directory", async () => {
    const cwd = await repository();
    const hook = vi.fn(async (path: string) => {
      await mkdir(path);
    });
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      { beforeCreateParent: hook, cwd },
    );
    expect(result.exitCode).toBe(0);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("rejects a concurrently created non-directory parent", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      {
        beforeCreateParent: async (path) => {
          await writeFile(path, "race\n", "utf8");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".cursor"), "utf8")).resolves.toBe("race\n");
  });

  it("detects replacement of a newly created parent before tracking it", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      {
        afterCreateParent: async (path) => {
          await rmdir(path);
          await writeFile(path, "replacement\n", "utf8");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output).error.message).toContain("cleanup could not be confirmed");
    await expect(readFile(join(cwd, ".cursor"), "utf8")).resolves.toBe("replacement\n");
  });

  it("rolls back a tracked parent when post-create verification fails", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      {
        afterCreateParent: async () => {
          throw new Error("injected post-create failure");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output).error).toMatchObject({ code: "internal_error" });
    await expect(readFile(join(cwd, ".cursor"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(cwd, ".agenthawk-init.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["lock", "staging", "stage"] as const)(
    "rolls back every tracked creation after an injected %s failure",
    async (failureKind) => {
      const cwd = await repository();
      const result = await initializeRepository(
        { format: "json", integration: "none" },
        {
          afterTrackedCreation: async (kind) => {
            if (kind === failureKind) throw new Error("injected tracked-creation failure");
          },
          cwd,
        },
      );
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.output).error).toMatchObject({ code: "internal_error" });
      await expect(readdir(cwd)).resolves.toEqual([]);
    },
  );

  it.each(["lock", "parent", "staging", "stage"] as const)(
    "marks cleanup unconfirmed when the created %s identity is unavailable",
    async (failureKind) => {
      const cwd = await repository();
      const result = await initializeRepository(
        { format: "json", integration: failureKind === "parent" ? "cursor" : "none" },
        {
          cwd,
          inspectCreatedIdentity: async (kind, _path, inspect) => {
            if (kind === failureKind) throw new Error("injected identity failure");
            return await inspect();
          },
        },
      );
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.output).error.message).toContain("cleanup could not be confirmed");
      expect(result.output).not.toContain("injected identity failure");
      expect((await readdir(cwd)).length).toBeGreaterThan(0);
      await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("fails closed when a target appears immediately before publication", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        beforePublish: async () => {
          await writeFile(join(cwd, ".agenthawk.yml"), "owner won race\n", "utf8");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).resolves.toBe("owner won race\n");
  });

  it("does not replace a target created between the final check and link", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        beforeLink: async (_target, path) => {
          await writeFile(path, "owner won final race\n", "utf8");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).resolves.toBe(
      "owner won final race\n",
    );
  });

  it("fails closed when a verified parent disappears before publication", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      {
        beforePublish: async (target) => {
          if (target === "cursor") {
            await rmdir(join(cwd, ".cursor", "rules"));
            await rmdir(join(cwd, ".cursor"));
          }
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("detects post-publication byte mutation and removes only its own file", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        afterPublish: async (_target, path) => {
          await writeFile(path, Buffer.alloc(Buffer.byteLength(INIT_POLICY), 0x78));
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(4);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports unconfirmed cleanup without deleting a replacement file", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        afterPublish: async (_target, path) => {
          await unlink(path);
          await writeFile(path, "replacement\n", "utf8");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.output).error.message).toContain("cleanup could not be confirmed");
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).resolves.toBe("replacement\n");
  });

  it("rolls back invocation-owned files when publication fails", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "cursor" },
      {
        beforePublish: async (target) => {
          if (target === "cursor") throw new Error("private failure detail");
        },
        cwd,
      },
    );
    expect(result.exitCode).toBe(4);
    expect(result.output).not.toContain("private failure detail");
    expect(result.output).not.toContain(cwd);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(cwd, ".agenthawk-init.lock"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects relative roots and an existing lock with fixed errors", async () => {
    const relative = await initializeRepository(
      { format: "json", integration: "none" },
      { cwd: "relative-root" },
    );
    expect(relative.exitCode).toBe(2);

    const cwd = await repository();
    await writeFile(join(cwd, ".agenthawk-init.lock"), "do not inspect\n", "utf8");
    const locked = await initializeRepository({ format: "terminal", integration: "none" }, { cwd });
    expect(locked.exitCode).toBe(2);
    expect(locked.output).not.toContain("do not inspect");
    expect(locked.output).not.toContain(cwd);
  });

  it("rejects missing and filesystem-root initialization roots", async () => {
    const cwd = await repository();
    const missing = await initializeRepository(
      { format: "json", integration: "none" },
      { cwd: join(cwd, "missing") },
    );
    expect(missing.exitCode).toBe(2);

    const root = process.platform === "win32" ? `${cwd.slice(0, 3)}` : "/";
    const filesystemRoot = await initializeRepository(
      { format: "json", integration: "none" },
      { cwd: root },
    );
    expect(filesystemRoot.exitCode).toBe(2);
  });

  it("rejects a symbolic initialization root without following it", async () => {
    const target = await repository();
    const holder = await repository();
    const root = join(holder, "root-link");
    await symlink(target, root, process.platform === "win32" ? "junction" : "dir");
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      { cwd: root },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(target, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("canonicalizes a root reached through a symbolic ancestor", async () => {
    const targetParent = await repository();
    const target = join(targetParent, "project");
    await mkdir(target);
    const holder = await repository();
    const alias = join(holder, "parent-alias");
    await symlink(targetParent, alias, process.platform === "win32" ? "junction" : "dir");
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      { cwd: join(alias, "project") },
    );
    expect(result.exitCode).toBe(0);
    await expect(readFile(join(target, ".agenthawk.yml"), "utf8")).resolves.toBe(INIT_POLICY);
  });

  it("rejects roots too large for bounded case-collision inspection", async () => {
    const cwd = await repository();
    const result = await initializeRepository(
      { format: "json", integration: "none" },
      {
        cwd,
        readDirectory: async (path) =>
          path === cwd
            ? Array.from({ length: 4_097 }, (_, index) => `entry-${index}`)
            : readdir(path),
      },
    );
    expect(result.exitCode).toBe(2);
    await expect(readFile(join(cwd, ".agenthawk.yml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
