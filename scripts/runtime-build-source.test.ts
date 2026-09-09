import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeRuntimeBuildSource, readRuntimeBuildFile } from "./runtime-build-source.mjs";

const root = resolve("synthetic-build-source");
const ownManifest = (name: string) =>
  readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url));
function stat(size: number) {
  return {
    dev: 1n,
    ino: 2n,
    nlink: 1n,
    mode: 0o100644n,
    size: BigInt(size),
    mtimeNs: 1n,
    ctimeNs: 1n,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}
function fixture() {
  const files = new Map<string, Buffer>([
    ["pnpm-lock.yaml", Buffer.from("synthetic lockfile")],
    ["tsconfig.json", Buffer.from("{}")],
    ...["core", "cli"].flatMap(
      (name) =>
        [
          [`packages/${name}/package.json`, ownManifest(name)],
          [`packages/${name}/tsconfig.json`, Buffer.from("{}")],
          [`packages/${name}/tsconfig.build.json`, Buffer.from("{}")],
          [`packages/${name}/src/index.ts`, Buffer.from("// inert source fixture")],
        ] as [string, Buffer][],
    ),
  ]);
  const original = new Map(files);
  const state = {
    status: "",
    ignored: "",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    oldOutput: false,
    indexOverride: undefined as string | undefined,
    indexCalls: 0,
    changeIndex: false,
    shortRead: false,
    mutateStat: (_path: string, value: ReturnType<typeof stat>) => value,
  };
  const relative = (path: string) => path.slice(root.length + 1).replaceAll("\\", "/");
  const handles: { close: ReturnType<typeof vi.fn> }[] = [];
  const io = {
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async (path: string) =>
      state.mutateStat(path, stat(files.get(relative(path))?.length ?? 0)),
    ),
    lstatIfPresent: vi.fn(async () => (state.oldOutput ? stat(0) : undefined)),
    open: vi.fn(async (path: string) => {
      const bytes = files.get(relative(path));
      if (!bytes) throw new Error("synthetic missing source");
      const handle = {
        stat: vi.fn(async () => state.mutateStat(path, stat(bytes.length))),
        read: vi.fn(async (output: Buffer, offset: number, length: number, position: number) => {
          const count = Math.min(
            state.shortRead ? 1 : length,
            Math.max(0, bytes.length - position),
          );
          bytes.copy(output, offset, position, position + count);
          return { bytesRead: count };
        }),
        close: vi.fn(async () => {}),
      };
      handles.push(handle);
      return handle;
    }),
  };
  const index = () =>
    [...original]
      .map(
        ([path, bytes]) =>
          `100644 ${createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")} 0\t${path}\0`,
      )
      .join("");
  const execute = vi.fn(async (_file: string, args: string[]) => {
    if (args.includes("--show-toplevel")) return Buffer.from(`${root}\n`);
    if (args.includes("rev-parse"))
      return Buffer.from(`${args.includes("HEAD^{tree}") ? state.tree : state.commit}\n`);
    if (args.includes("status")) return Buffer.from(state.status);
    if (args.includes("--ignored")) return Buffer.from(state.ignored);
    if (args.includes("--stage")) {
      state.indexCalls += 1;
      return Buffer.from(
        state.indexOverride ?? (state.changeIndex && state.indexCalls > 1 ? "changed" : index()),
      );
    }
    return Buffer.alloc(0);
  });
  const observe = () => observeRuntimeBuildSource({ root, io, execute, requireFreshOutput: true });
  return { root, files, original, state, handles, io, execute, observe, index };
}

describe("observed fresh-build source boundary", () => {
  it("hashes tracked content and returns only measured identifiers", async () => {
    const f = fixture();
    expect(await f.observe()).toEqual({
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      lockfileSha256: createHash("sha256").update("synthetic lockfile").digest("hex"),
    });
    expect(f.handles.every((handle) => handle.close.mock.calls.length === 1)).toBe(true);
    expect(
      f.execute.mock.calls.every(
        ([file, args]) => file === "git" && args.includes("core.fsmonitor=false"),
      ),
    ).toBe(true);
  });
  it("bounds and handles short reads", async () => {
    const f = fixture();
    f.state.shortRead = true;
    expect(await f.observe()).toHaveProperty("commit", "a".repeat(40));
  });
  it.each(["status", "ignored"] as const)(
    "rejects %s dirt before reading build inputs",
    async (key) => {
      const f = fixture();
      f.state[key] = "synthetic ignored/untracked source\0";
      await expect(f.observe()).rejects.toHaveProperty("reason", "source_dirty");
      expect(f.io.open).not.toHaveBeenCalled();
    },
  );
  it("detects changed bytes even when Git's stat cache reports clean", async () => {
    const f = fixture();
    f.files.set("packages/core/src/index.ts", Buffer.from("// modified ignored-by-index source"));
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_dirty");
  });
  it("rejects old ignored dist instead of deleting it", async () => {
    const f = fixture();
    f.state.oldOutput = true;
    await expect(f.observe()).rejects.toHaveProperty("reason", "output_exists");
  });
  it("detects index drift during source inspection", async () => {
    const f = fixture();
    f.state.changeIndex = true;
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_dirty");
  });
  it.each(["invalid", "A".repeat(40), "a".repeat(64)])(
    "rejects unsupported source identity %s",
    async (commit) => {
      const f = fixture();
      f.state.commit = commit;
      await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
    },
  );
  it.each([
    "",
    `100644 ${"a".repeat(40)} 0\t../escape\0`,
    `120000 ${"a".repeat(40)} 0\tlinked\0`,
    `100644 ${"a".repeat(40)} 2\tconflicted\0`,
    `100644 ${"a".repeat(40)} 0\tbad//path\0`,
    `100644 ${"a".repeat(40)} 0\tbad/./path\0`,
    `100644 ${"a".repeat(40)} 0\tunicode-é\0`,
  ])("rejects malformed or nonregular index inventory %#", async (index) => {
    const f = fixture();
    f.state.indexOverride = index;
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
  });
  it("rejects duplicate index paths", async () => {
    const f = fixture();
    f.state.indexOverride = f.index() + f.index();
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
  });
  it("rejects excessive index entries before filesystem reads", async () => {
    const f = fixture();
    f.state.indexOverride = "x\0".repeat(2049);
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
    expect(f.io.open).not.toHaveBeenCalled();
  });
  it.each(["pnpm-lock.yaml", "tsconfig.json", "packages/core/tsconfig.build.json"])(
    "requires tracked %s",
    async (path) => {
      const f = fixture();
      f.files.delete(path);
      f.original.delete(path);
      await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
    },
  );
  it("rejects malformed own manifests before any own build", async () => {
    const f = fixture();
    const bytes = Buffer.from("{");
    f.files.set("packages/core/package.json", bytes);
    f.original.set("packages/core/package.json", bytes);
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
  });
  it("rejects canonical source-root aliases", async () => {
    const f = fixture();
    f.io.realpath.mockImplementation(async () => "/another-root");
    await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
  });
  it.each(["hardlink", "symlink", "writable", "oversized", "invalid inode"])(
    "rejects %s source files",
    async (kind) => {
      const f = fixture();
      f.state.mutateStat = (_path, value) => ({
        ...value,
        ...(kind === "hardlink" ? { nlink: 2n } : {}),
        ...(kind === "symlink" ? { isSymbolicLink: () => true } : {}),
        ...(kind === "writable" ? { mode: 0o100666n } : {}),
        ...(kind === "oversized" ? { size: 2_097_153n } : {}),
        ...(kind === "invalid inode" ? { ino: 0n } : {}),
      });
      await expect(f.observe()).rejects.toHaveProperty("reason", "source_invalid");
    },
  );
  it("supports empty tracked files with regular identity", async () => {
    const f = fixture();
    f.files.set("empty", Buffer.alloc(0));
    f.original.set("empty", Buffer.alloc(0));
    expect(await f.observe()).toHaveProperty("commit");
  });
  it("rejects premature EOF and closes the reader", async () => {
    const f = fixture();
    const open = f.io.open.getMockImplementation();
    if (!open) throw new Error("fixture reader missing");
    f.io.open.mockImplementation(async (path) => {
      const handle = await open(path);
      handle.read.mockResolvedValue({ bytesRead: 0 });
      return handle;
    });
    await expect(
      readRuntimeBuildFile(f.io, join(root, "pnpm-lock.yaml"), 100),
    ).rejects.toHaveProperty("reason", "source_invalid");
    expect(f.handles[0]?.close).toHaveBeenCalledOnce();
  });
  it("rejects readback identity replacement", async () => {
    const f = fixture();
    let calls = 0;
    f.state.mutateStat = (_path, value) => ({ ...value, ino: ++calls > 1 ? 3n : 2n });
    await expect(
      readRuntimeBuildFile(f.io, join(root, "pnpm-lock.yaml"), 100),
    ).rejects.toHaveProperty("reason", "source_invalid");
    expect(f.handles[0]?.close).toHaveBeenCalledOnce();
  });
});
