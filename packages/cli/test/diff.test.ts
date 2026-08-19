import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffDependencies, inventoryDependencies, parseManifest } from "../src/diff.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenthawk-diff-"));
  roots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "AgentHawk Test"]);
  await git(root, ["config", "user.email", "agenthawk@example.invalid"]);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { postinstall: "node should-never-run.js" },
      dependencies: { existing: "1.0.0" },
    }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await git(root, ["add", "package.json", "pnpm-lock.yaml"]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

describe("scanDependencies", () => {
  it("lists only direct dependencies and does not execute manifest scripts", async () => {
    const root = await repository();
    const result = await inventoryDependencies({ cwd: root, format: "json" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output).dependencies).toEqual([
      { name: "existing", requestedSpec: "1.0.0", section: "dependencies" },
    ]);
  });

  it("escapes hostile dependency text in terminal output", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-scan-"));
    roots.push(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "bad\u001b[31m": "1" } }),
    );
    const result = await inventoryDependencies({ cwd: root, format: "terminal" });
    expect(result.output).toContain("\\u001b[31m");
    expect(result.output).not.toContain("\u001b");
  });

  it.each(["missing", "directory", "invalid-utf8", "oversized"])(
    "fails safely for a %s package manifest boundary",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "agenthawk-scan-"));
      roots.push(root);
      const path = join(root, "package.json");
      if (kind === "directory") await mkdir(path);
      if (kind === "invalid-utf8") await writeFile(path, Buffer.from([0xff, 0xfe]));
      if (kind === "oversized") await writeFile(path, Buffer.alloc(1_048_577, 0x20));
      const result = await inventoryDependencies({ cwd: root, format: "json" });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({ error: { code: "invalid_input" } });
    },
  );
});

describe("diffDependencies", () => {
  it("reports additions and PG014 when a direct dependency changes without a lockfile update", async () => {
    const root = await repository();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "@scope/new": "^2.0.0", existing: "2.0.0" } }),
    );
    const result = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "json",
      strict: true,
    });
    const report = JSON.parse(result.output);
    expect(result.exitCode).toBe(1);
    expect(report.changes).toEqual([
      { kind: "added", name: "@scope/new", requestedSpec: "^2.0.0", section: "dependencies" },
      {
        kind: "version_changed",
        name: "existing",
        previousSection: "dependencies",
        previousSpec: "1.0.0",
        requestedSpec: "2.0.0",
        section: "dependencies",
      },
    ]);
    expect(report.lockfiles).toEqual({ present: ["pnpm-lock.yaml"], updated: [] });
    expect(report.findings).toEqual([
      expect.objectContaining({ approvable: true, ruleId: "PG014", verdict: "review" }),
    ]);
  });

  it("allows correlated manifest and lockfile updates", async () => {
    const root = await repository();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { added: "1.0.0" } }),
    );
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n");
    const result = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "json",
      strict: true,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({
      findings: [],
      lockfiles: { present: ["pnpm-lock.yaml"], updated: ["pnpm-lock.yaml"] },
      verdict: "allow",
    });
  });

  it("PG014 rejects a dependency addition paired only with lockfile deletion", async () => {
    const root = await repository();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { added: "1.0.0" } }),
    );
    await unlink(join(root, "pnpm-lock.yaml"));
    const result = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "json",
      strict: true,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      findings: [expect.objectContaining({ ruleId: "PG014" })],
      lockfiles: { present: [], updated: [] },
    });
  });

  it("ignores inherited Git repository redirection variables", async () => {
    const root = await repository();
    const other = await repository();
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { added: "1" } }));
      const result = await diffDependencies({
        base: "HEAD",
        cwd: root,
        format: "json",
        strict: true,
      });
      expect(JSON.parse(result.output).changes).toEqual([
        { kind: "added", name: "added", requestedSpec: "1", section: "dependencies" },
      ]);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
    }
  });

  it("rejects a root package.json symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-symlink-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "agenthawk-external-"));
    const external = join(externalRoot, "outside.json");
    roots.push(root, externalRoot);
    await writeFile(external, JSON.stringify({ dependencies: { escaped: "1" } }));
    try {
      await symlink(external, join(root, "package.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const result = await inventoryDependencies({ cwd: root, format: "json" });
    expect(result.exitCode).toBe(2);
  });

  it("allows an unchanged manifest and renders terminal review output safely", async () => {
    const root = await repository();
    const unchanged = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "json",
      strict: true,
    });
    expect(JSON.parse(unchanged.output)).toMatchObject({ changes: [], verdict: "allow" });

    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { "bad\u001b[31m": "1" } }),
    );
    const changed = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "terminal",
      strict: false,
    });
    expect(changed.exitCode).toBe(0);
    expect(changed.output).toContain("PG014");
    expect(changed.output).toContain("\\u001b[31m");
    expect(changed.output).not.toContain("\u001b");
  });

  it.each(["missing-ref", "--help", "bad\nref"])(
    "fails clearly for invalid base %j",
    async (base) => {
      const root = await repository();
      const result = await diffDependencies({ base, cwd: root, format: "json", strict: true });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.output)).toMatchObject({ error: { code: "invalid_input" } });
    },
  );

  it.each(["", "x".repeat(513), "bad\0ref", "bad\rref", "bad\u001bref"])(
    "rejects unsafe base input %j before Git",
    async (base) => {
      const root = await repository();
      let contacted = false;
      const result = await diffDependencies(
        { base, cwd: root, format: "json", strict: true },
        {
          git: {
            run: async () => {
              contacted = true;
              return "";
            },
          },
        },
      );
      expect(contacted).toBe(false);
      expect(result.exitCode).toBe(2);
    },
  );

  it("rejects invalid Git root, commit, and base manifest output", async () => {
    const root = await repository();
    const cases = [
      ["relative", "a".repeat(40), "{}"],
      [root, "not-a-commit", "{}"],
      [root, "a".repeat(40), "not json"],
    ] as const;
    for (const [gitRoot, commit, baseManifest] of cases) {
      const result = await diffDependencies(
        { base: "HEAD", cwd: root, format: "json", strict: true },
        {
          git: {
            run: async (args) => {
              if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return gitRoot;
              if (args[0] === "rev-parse") return commit;
              if (args[0] === "show") return baseManifest;
              return "unknown.lock\0";
            },
          },
        },
      );
      expect(result.exitCode).toBe(2);
    }
  });

  it("redacts unexpected injected Git failures", async () => {
    const root = await repository();
    const result = await diffDependencies(
      { base: "HEAD", cwd: root, format: "terminal", strict: true },
      { git: { run: async () => Promise.reject(new Error("secret git detail")) } },
    );
    expect(result.output).toContain("failed safely");
    expect(result.output).not.toContain("secret");
  });

  it("fails safely outside a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-no-git-"));
    roots.push(root);
    const result = await diffDependencies({
      base: "HEAD",
      cwd: root,
      format: "terminal",
      strict: true,
    });
    expect(result).toMatchObject({ exitCode: 2 });
    expect(result.output).toContain("Git operation failed");
  });
});

describe("parseManifest", () => {
  it("rejects duplicate keys, invalid JSON, malformed dependency values, and oversized input", () => {
    expect(() => parseManifest('{"dependencies":{},"dependencies":{"x":"1"}}')).toThrow();
    expect(() => parseManifest("dependencies:\n  x: 1")).toThrow();
    expect(() => parseManifest('{"dependencies":{"x":1}}')).toThrow();
    expect(() => parseManifest(" ".repeat(1_048_577))).toThrow();
  });
});

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
