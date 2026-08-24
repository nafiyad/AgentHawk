import { execFile } from "node:child_process";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OperationCancelledError } from "@agenthawk/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRepositoryAuthority,
  loadRepositoryRootAuthority,
  RepositoryAuthorityError,
} from "../src/repository-authority.js";

const roots: string[] = [];
const integrationTimeout = 20_000;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })),
  );
}, integrationTimeout);

describe("loadRepositoryAuthority", { timeout: integrationTimeout }, () => {
  it("loads only canonical root identity without reading repository configuration", async () => {
    const root = await repository();
    await writeFile(join(root, ".agenthawk.yml"), "not: valid: yaml\n");
    await writeFile(join(root, "package.json"), "not-json\n");
    let configurationRead = false;
    const result = await loadRepositoryRootAuthority(
      root,
      {},
      {
        readApprovals: async () => {
          configurationRead = true;
          throw new Error("must not run");
        },
        readPolicy: async () => {
          configurationRead = true;
          throw new Error("must not run");
        },
      },
    );
    const identity = await lstat(root, { bigint: true });
    expect(result).toEqual({
      repositoryRoot: await realpath(root),
      repositoryIdentity: { dev: identity.dev, ino: identity.ino },
    });
    expect(configurationRead).toBe(false);
  });

  it("keeps root-only authority fail-closed for invalid roots and cancellation", async () => {
    const root = await repository();
    const nested = join(root, "nested");
    await mkdir(nested);
    await expect(loadRepositoryRootAuthority(nested)).rejects.toThrow(
      "Action directory must be the canonical Git worktree root.",
    );
    await expect(loadRepositoryRootAuthority("relative/path")).rejects.toThrow(
      "Action directory is invalid.",
    );
    await expect(
      loadRepositoryRootAuthority(root, {}, { runGit: async () => "relative\n" }),
    ).rejects.toBeInstanceOf(RepositoryAuthorityError);

    const controller = new AbortController();
    controller.abort(new Error("private cancellation"));
    await expect(
      loadRepositoryRootAuthority(root, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("loads only co-root defaults and derives direct dependency names", async () => {
    const root = await repository();
    await mkdir(join(root, ".agenthawk"));
    await writeFile(join(root, ".agenthawk.yml"), "version: 1\nmode: review\n");
    await writeFile(join(root, ".agenthawk", "approvals.yml"), "version: 1\napprovals: []\n");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { zod: "4.4.3" }, devDependencies: { vitest: "4.0.0" } }),
    );

    const result = await loadRepositoryAuthority(root);

    expect(result.repositoryRoot).toBe(await realpath(root));
    const rootIdentity = await lstat(root, { bigint: true });
    expect(result.repositoryIdentity).toEqual({ dev: rootIdentity.dev, ino: rootIdentity.ino });
    expect(result.config).toMatchObject({ mode: "review", version: 1 });
    expect(result.approvals).toEqual({ approvals: [], version: 1 });
    expect(result.directDependencyNames).toEqual(["vitest", "zod"]);
  });

  it("uses empty default documents when optional files are absent", async () => {
    const root = await repository();
    const result = await loadRepositoryAuthority(root);
    expect(result.config.version).toBe(1);
    expect(result.approvals).toEqual({ approvals: [], version: 1 });
    expect(result.manifest).toBeUndefined();
    expect(result.directDependencyNames).toEqual([]);
  });

  it("rejects nested action directories even inside the same worktree", async () => {
    const root = await repository();
    const nested = join(root, "packages", "nested");
    await mkdir(nested, { recursive: true });
    await expect(loadRepositoryAuthority(nested)).rejects.toThrow(
      "Action directory must be the canonical Git worktree root.",
    );
  });

  it("treats a linked worktree as an independent co-root authority", async () => {
    const root = await repository();
    const linkedParent = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-worktree-"));
    roots.push(linkedParent);
    const linked = join(linkedParent, "linked");
    await git(root, ["worktree", "add", "-b", `authority-${Date.now()}`, linked]);
    await writeFile(join(root, ".agenthawk.yml"), "version: 1\nmode: review\n");
    await writeFile(join(linked, ".agenthawk.yml"), "version: 1\nmode: strict\n");

    const result = await loadRepositoryAuthority(linked);

    expect(result.repositoryRoot).toBe(await realpath(linked));
    expect(result.config.mode).toBe("strict");
  });

  it("rejects non-repositories and relative action directories with fixed messages", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-authority-no-git-"));
    roots.push(root);
    await expect(loadRepositoryAuthority(root)).rejects.toThrow(
      "Repository authority could not be established.",
    );
    await expect(loadRepositoryAuthority("relative/path")).rejects.toThrow(
      "Action directory is invalid.",
    );
    await expect(loadRepositoryAuthority(`${resolve(root)}\n`)).rejects.toThrow(
      "Action directory is invalid.",
    );
    await expect(loadRepositoryAuthority(`C:\\${"x".repeat(4_097)}`)).rejects.toThrow(
      "Action directory is invalid.",
    );
  });

  it.each(["", "relative", "one\ntwo", "C:\\root\nC:\\other\n"])(
    "rejects invalid Git root output without reading configuration: %j",
    async (output) => {
      const root = await repository();
      let policyRead = false;
      await expect(
        loadRepositoryAuthority(
          root,
          {},
          {
            readPolicy: async () => {
              policyRead = true;
              return undefined;
            },
            runGit: async () => output,
          },
        ),
      ).rejects.toBeInstanceOf(RepositoryAuthorityError);
      expect(policyRead).toBe(false);
    },
  );

  it.each(["\n", "\r\n"])("accepts one Git root terminator: %j", async (terminator) => {
    const root = await repository();
    const canonical = await realpath(root);
    const result = await loadRepositoryAuthority(
      root,
      {},
      {
        runGit: async (args, cwd) => {
          expect(args).toEqual(["rev-parse", "--show-toplevel"]);
          expect(cwd).toBe(canonical);
          return `${canonical}${terminator}`;
        },
      },
    );
    expect(result.repositoryRoot).toBe(canonical);
  });

  it("rejects malformed policy, approvals, and manifest before returning authority", async () => {
    const root = await repository();
    await writeFile(join(root, ".agenthawk.yml"), "version: 1\nbypass: true\n");
    await expect(loadRepositoryAuthority(root)).rejects.toBeInstanceOf(RepositoryAuthorityError);
    await rm(join(root, ".agenthawk.yml"));
    await mkdir(join(root, ".agenthawk"));
    await writeFile(join(root, ".agenthawk", "approvals.yml"), "version: 1\napprovals: any\n");
    await expect(loadRepositoryAuthority(root)).rejects.toBeInstanceOf(RepositoryAuthorityError);
    await rm(join(root, ".agenthawk"), { recursive: true });
    await writeFile(join(root, "package.json"), "{not-json");
    await expect(loadRepositoryAuthority(root)).rejects.toBeInstanceOf(RepositoryAuthorityError);
  });

  it.each(["policy", "approvals"])(
    "does not default a %s file removed between inspection and open",
    async (kind) => {
      const root = await repository();
      const target =
        kind === "policy"
          ? join(root, ".agenthawk.yml")
          : join(root, ".agenthawk", "approvals.yml");
      if (kind === "approvals") await mkdir(join(root, ".agenthawk"));
      await writeFile(
        target,
        kind === "policy" ? "version: 1\nmode: strict\n" : "version: 1\napprovals: []\n",
      );
      const openFile = (async (
        path: Parameters<typeof open>[0],
        flags: Parameters<typeof open>[1],
      ) => {
        if (path.toString() === target) {
          await rm(target);
          throw Object.assign(new Error("removed"), { code: "ENOENT" });
        }
        return await open(path, flags);
      }) as typeof open;
      await expect(loadRepositoryAuthority(root, {}, { openFile })).rejects.toBeInstanceOf(
        RepositoryAuthorityError,
      );
    },
  );

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["oversized", Buffer.alloc(1_048_577, 0x20)],
  ])("rejects a present %s manifest", async (_label, contents) => {
    const root = await repository();
    await writeFile(join(root, "package.json"), contents);
    await expect(loadRepositoryAuthority(root)).rejects.toBeInstanceOf(RepositoryAuthorityError);
  });

  it("deduplicates one package declared in multiple dependency sections", async () => {
    const root = await repository();
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { zod: "4.4.3" }, peerDependencies: { zod: "^4" } }),
    );
    await expect(loadRepositoryAuthority(root)).resolves.toMatchObject({
      directDependencyNames: ["zod"],
    });
  });

  it("fails when the opened manifest identity is unavailable", async () => {
    const root = await repository();
    const path = join(root, "package.json");
    await writeFile(path, "{}\n");
    const stats = await lstat(path);
    const handle = {
      close: async () => undefined,
      stat: async () => ({ ...stats, ino: Number.NaN, isFile: () => true }),
    } as unknown as FileHandle;
    await expect(
      loadRepositoryAuthority(root, {}, { openFile: async () => handle }),
    ).rejects.toThrow("Repository manifest is unsafe.");
  });

  it.each([
    [0n, 0n],
    [-1n, -1n],
  ])("rejects placeholder repository identity values: %s/%s", async (dev, ino) => {
    const root = await repository();
    const inspectIdentity = async (path: string) => {
      const stats = await lstat(path, { bigint: true });
      return Object.assign(stats, { dev, ino });
    };
    await expect(loadRepositoryAuthority(root, {}, { inspectIdentity })).rejects.toThrow(
      "Action directory must be the canonical Git worktree root.",
    );
  });

  it("detects an exact bigint root identity replacement after co-root reads", async () => {
    const root = await repository();
    let identityReads = 0;
    const inspectIdentity = async (path: string) => {
      const stats = await lstat(path, { bigint: true });
      identityReads += 1;
      return identityReads === 3 ? Object.assign(stats, { ino: stats.ino + 2n ** 60n }) : stats;
    };
    await expect(loadRepositoryAuthority(root, {}, { inspectIdentity })).rejects.toThrow(
      "Repository root changed during authority loading.",
    );
    expect(identityReads).toBe(3);
  });

  it("fails closed when opening a present manifest fails", async () => {
    const root = await repository();
    await writeFile(join(root, "package.json"), "{}\n");
    await expect(
      loadRepositoryAuthority(
        root,
        {},
        {
          openFile: async () => {
            throw new Error("host detail");
          },
        },
      ),
    ).rejects.toThrow("Repository manifest could not be read.");
  });

  it("detects a manifest truncated through the opened handle", async () => {
    const root = await repository();
    const path = join(root, "package.json");
    await writeFile(path, "{}\n");
    const stats = await lstat(path);
    const handle = {
      close: async () => undefined,
      read: async () => ({ bytesRead: 0 }),
      stat: async () => stats,
    } as unknown as FileHandle;
    await expect(
      loadRepositoryAuthority(root, {}, { openFile: async () => handle }),
    ).rejects.toThrow("Repository manifest changed while it was being read.");
  });

  it("bounds growth observed through the opened manifest handle", async () => {
    const root = await repository();
    const path = join(root, "package.json");
    await writeFile(path, "{}\n");
    const stats = await lstat(path);
    let sent = false;
    const handle = {
      close: async () => undefined,
      read: async (buffer: Buffer) => {
        if (sent) return { bytesRead: 0 };
        sent = true;
        buffer.fill(0x20);
        return { bytesRead: buffer.length };
      },
      stat: async () => stats,
    } as unknown as FileHandle;
    await expect(
      loadRepositoryAuthority(root, {}, { openFile: async () => handle }),
    ).rejects.toThrow("Repository manifest exceeds the 1 MiB limit.");
  });

  it("fails closed when the manifest descriptor cannot be closed", async () => {
    const root = await repository();
    const path = join(root, "package.json");
    const source = Buffer.from("{}\n");
    await writeFile(path, source);
    const stats = await lstat(path);
    const handle = {
      close: async () => {
        throw new Error("close detail");
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(length, source.length - position);
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      stat: async () => stats,
    } as unknown as FileHandle;
    await expect(
      loadRepositoryAuthority(root, {}, { openFile: async () => handle }),
    ).rejects.toThrow("Repository configuration could not be loaded.");
  });

  it("preserves cancellation that occurs while closing the manifest descriptor", async () => {
    const root = await repository();
    const path = join(root, "package.json");
    const source = Buffer.from("{}\n");
    await writeFile(path, source);
    const stats = await lstat(path);
    const controller = new AbortController();
    const handle = {
      close: async () => {
        controller.abort(new Error("untrusted"));
        throw new Error("close detail");
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(length, source.length - position);
        if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
      },
      stat: async () => stats,
    } as unknown as FileHandle;
    await expect(
      loadRepositoryAuthority(
        root,
        { signal: controller.signal },
        {
          openFile: async () => handle,
        },
      ),
    ).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("rejects a repository-root mismatch before reading co-root files", async () => {
    const root = await repository();
    const other = await repository();
    let read = false;
    await expect(
      loadRepositoryAuthority(
        root,
        {},
        {
          readPolicy: async () => {
            read = true;
            return undefined;
          },
          runGit: async () => `${await realpath(other)}\n`,
        },
      ),
    ).rejects.toThrow("Action directory must be the canonical Git worktree root.");
    expect(read).toBe(false);
  });

  it("rejects an optional policy that appears while defaults are loading", async () => {
    const root = await repository();
    await expect(
      loadRepositoryAuthority(
        root,
        {},
        {
          readPolicy: async (path) => {
            await writeFile(path, "version: 1\n");
            return undefined;
          },
        },
      ),
    ).rejects.toThrow("Policy path changed during authority loading.");
  });

  it("fails closed when optional-path absence cannot be revalidated", async () => {
    const root = await repository();
    const policyPath = join(await realpath(root), ".agenthawk.yml");
    const inspectPath = (async (path: Parameters<typeof lstat>[0]) => {
      if (path.toString() === policyPath) {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return await lstat(path);
    }) as typeof lstat;
    await expect(
      loadRepositoryAuthority(
        root,
        {},
        {
          inspectPath,
          readPolicy: async () => undefined,
        },
      ),
    ).rejects.toThrow("Policy path could not be revalidated.");
  });

  it("waits for sibling reads and gives cancellation precedence", async () => {
    const root = await repository();
    const controller = new AbortController();
    let approvalSettled = false;
    const pending = loadRepositoryAuthority(
      root,
      { signal: controller.signal },
      {
        readApprovals: async () => {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
          approvalSettled = true;
          controller.abort(new Error("untrusted"));
          throw new Error("ordinary approval failure");
        },
        readPolicy: async () => {
          throw new Error("ordinary policy failure");
        },
      },
    );
    await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
    expect(approvalSettled).toBe(true);
  });

  it("rejects manifest symlinks and never reads the external document", async () => {
    const root = await repository();
    const external = await mkdtemp(join(tmpdir(), "agenthawk-authority-external-"));
    roots.push(external);
    const externalManifest = join(external, "package.json");
    await writeFile(externalManifest, JSON.stringify({ dependencies: { attacker: "1.0.0" } }));
    await symlink(externalManifest, join(root, "package.json"), "file");
    await expect(loadRepositoryAuthority(root)).rejects.toThrow("Repository manifest is unsafe.");
  });

  it("rejects an action directory reached through a symbolic alias", async () => {
    const root = await repository();
    const parent = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-authority-alias-"));
    roots.push(parent);
    const alias = join(parent, "repository-link");
    await symlink(root, alias, "junction");
    await expect(loadRepositoryAuthority(alias)).rejects.toThrow(
      "Repository path must not use symbolic redirection.",
    );
  });

  it("propagates pre-cancellation without starting Git", async () => {
    const root = await repository();
    const controller = new AbortController();
    controller.abort(new Error("untrusted"));
    let gitCalled = false;
    await expect(
      loadRepositoryAuthority(
        root,
        { signal: controller.signal },
        {
          runGit: async () => {
            gitCalled = true;
            return root;
          },
        },
      ),
    ).rejects.toBeInstanceOf(OperationCancelledError);
    expect(gitCalled).toBe(false);
  });

  it("starts no realpath or Git work after action-path inspection cancels", async () => {
    const root = await repository();
    const canonical = await realpath(root);
    const controller = new AbortController();
    let realCalls = 0;
    let gitCalls = 0;
    const inspectPath = (async (path: Parameters<typeof lstat>[0]) => {
      const stats = await lstat(path);
      if (path.toString() === canonical) controller.abort(new Error("untrusted"));
      return stats;
    }) as typeof lstat;
    const realPath = (async (path: Parameters<typeof realpath>[0]) => {
      realCalls += 1;
      return await realpath(path);
    }) as typeof realpath;
    await expect(
      loadRepositoryAuthority(
        root,
        { signal: controller.signal },
        {
          inspectPath,
          realPath,
          runGit: async () => {
            gitCalls += 1;
            return `${canonical}\n`;
          },
        },
      ),
    ).rejects.toBeInstanceOf(OperationCancelledError);
    expect(realCalls).toBe(0);
    expect(gitCalls).toBe(0);
  });

  it("does not open a manifest after its final inspection cancels", async () => {
    const root = await repository();
    const manifestPath = join(await realpath(root), "package.json");
    await writeFile(manifestPath, "{}\n");
    const controller = new AbortController();
    let openCalls = 0;
    const inspectPath = (async (path: Parameters<typeof lstat>[0]) => {
      const stats = await lstat(path);
      if (path.toString() === manifestPath) controller.abort(new Error("untrusted"));
      return stats;
    }) as typeof lstat;
    const openFile = (async (
      path: Parameters<typeof open>[0],
      flags: Parameters<typeof open>[1],
    ) => {
      openCalls += 1;
      return await open(path, flags);
    }) as typeof open;
    await expect(
      loadRepositoryAuthority(
        root,
        { signal: controller.signal },
        {
          inspectPath,
          openFile,
          readApprovals: async () => undefined,
          readPolicy: async () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(OperationCancelledError);
    expect(openCalls).toBe(0);
  });

  it("uses fixed co-root paths that cannot be supplied by a hook payload", async () => {
    const root = await repository();
    const policyPaths: string[] = [];
    const approvalPaths: string[] = [];
    const result = await loadRepositoryAuthority(
      root,
      {},
      {
        readApprovals: async (path) => {
          approvalPaths.push(path);
          return undefined;
        },
        readPolicy: async (path) => {
          policyPaths.push(path);
          return undefined;
        },
      },
    );
    expect(policyPaths).toEqual([join(resolve(root), ".agenthawk.yml")]);
    expect(approvalPaths).toEqual([join(resolve(root), ".agenthawk", "approvals.yml")]);
    expect(result.directDependencyNames).toEqual([]);
  });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agenthawk-authority-"));
  roots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "AgentHawk Test"]);
  await git(root, ["config", "user.email", "agenthawk@example.invalid"]);
  await git(root, ["commit", "--allow-empty", "-m", "fixture"]);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
