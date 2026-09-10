import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureCleanupFence } from "../packages/cli/test/fixture-cleanup-fence.js";

const inputs = vi.hoisted(() => ({ describe: vi.fn(), files: vi.fn(), snapshotFiles: vi.fn() }));
vi.mock("./runtime-assembly-inputs.mjs", () => ({
  describeRuntimeAssemblyPlan: inputs.describe,
  runtimeAssemblyFiles: inputs.files,
}));
vi.mock("./runtime-tree-reader.mjs", () => ({ runtimeTreeSnapshotFiles: inputs.snapshotFiles }));

import { createRuntimeDestinationInspector, createRuntimeTreeWriter } from "./runtime-tree.mjs";

const PRIVATE = "fixture-private-path-and-provider-error";
const roots: string[] = [];
const fence = createFixtureCleanupFence();
beforeEach(({ signal }) => {
  fence.begin(signal);
  inputs.describe.mockReset();
  inputs.files.mockReset();
  inputs.snapshotFiles.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await fence.cleanup(roots, async (root) => await fs.rm(root, { recursive: true, force: true }));
});
function hash(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}
type Entry = { path: string; data: Buffer; size: number; sha256: string };
type Observation = { path: string; closed: boolean; directory: boolean };

async function fixture() {
  const created = await fs.mkdtemp(join(tmpdir(), "agenthawk-runtime-tree-"));
  const index = roots.push(created) - 1;
  const root = await fs.realpath(created);
  roots[index] = root;
  const destination = join(root, "prepared");
  const names = ["@agenthawk/cli", "@agenthawk/core", "commander", "semver", "yaml", "zod"];
  const files: Entry[] = names.map((name) => {
    const data = Buffer.from(`inert synthetic fixture for ${name}`);
    return {
      path: `runtime/node_modules/${name}/package.json`,
      size: data.length,
      sha256: hash(data),
      data,
    };
  });
  files.push({
    path: "runtime/node_modules/zod/subdir/empty.txt",
    size: 0,
    sha256: hash(""),
    data: Buffer.alloc(0),
  });
  const plan = Object.freeze({ fixture: true });
  const description = {
    schemaVersion: 1,
    sourceBinding: "caller_observation_only",
    source: { fixture: true },
    packages: names.map((name) => ({ name, version: "fixture-only" })),
    fileCount: files.length,
    fileBytes: files.reduce((total, file) => total + file.size, 0),
    plannedTreeSha256: hash(
      JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
    ),
    executed: false,
    portableRuntime: false,
    nativeSupport: false,
  };
  inputs.describe.mockImplementation((value) => (value === plan ? description : undefined));
  inputs.files.mockImplementation((value) =>
    value === plan ? files.map((file) => ({ ...file, data: Buffer.from(file.data) })) : undefined,
  );
  const modes = new Map<string, bigint>();
  const opened: Observation[] = [];
  const directoryReads = new Map<string, number>();
  let mutateStat = (_path: string, status: Record<string, unknown>) => status;
  let onWrite = async (_path: string) => {};
  let onRead = async (_path: string) => {};
  let onClose = async (_path: string, _directory: boolean) => {};
  let onDirectoryRead = async (_path: string) => {};
  let writeCount: number | undefined;
  let readCount: number | undefined;
  const wrapStat = (path: string, status: Awaited<ReturnType<typeof fs.lstat>>) => {
    // Synthetic Linux ownership/mode seam on real temporary files; not Windows ACL evidence.
    return mutateStat(path, {
      ...status,
      uid: 10001n,
      mode: modes.get(path) ?? 0o755n,
      isDirectory: () => status.isDirectory(),
      isFile: () => status.isFile(),
      isSymbolicLink: () => status.isSymbolicLink(),
    });
  };
  const io = {
    realpath: vi.fn(async (path: string) => await fs.realpath(path)),
    lstat: vi.fn(async (path: string) => wrapStat(path, await fs.lstat(path, { bigint: true }))),
    mkdir: vi.fn(async (path: string, options: { mode: number }) => {
      await fs.mkdir(path, options);
      modes.set(path, BigInt(options.mode));
    }),
    open: vi.fn(async (path: string, flags: number, mode?: number) => {
      const handle = await fs.open(path, flags, mode);
      if (mode !== undefined) modes.set(path, BigInt(mode));
      const observed = { path, closed: false, directory: false };
      opened.push(observed);
      return {
        stat: async () => wrapStat(path, await handle.stat({ bigint: true })),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await onRead(path);
          if (
            readCount !== undefined &&
            (readCount < 0 || readCount > length || !Number.isInteger(readCount))
          )
            return { bytesRead: readCount };
          return await handle.read(
            buffer,
            offset,
            readCount === undefined ? length : Math.min(length, readCount),
            position,
          );
        },
        write: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await onWrite(path);
          if (
            writeCount !== undefined &&
            (writeCount <= 0 || writeCount > length || !Number.isInteger(writeCount))
          )
            return { bytesWritten: writeCount };
          return await handle.write(
            buffer,
            offset,
            writeCount === undefined ? length : Math.min(length, writeCount),
            position,
          );
        },
        sync: async () => await handle.sync(),
        close: async () => {
          await handle.close();
          observed.closed = true;
          await onClose(path, false);
        },
      };
    }),
    opendir: vi.fn(async (path: string, options: { bufferSize: number }) => {
      const handle = await fs.opendir(path, options);
      const observed = { path, closed: false, directory: true };
      opened.push(observed);
      return {
        read: async () => {
          directoryReads.set(path, (directoryReads.get(path) ?? 0) + 1);
          await onDirectoryRead(path);
          return await handle.read();
        },
        close: async () => {
          await handle.close();
          observed.closed = true;
          await onClose(path, true);
        },
      };
    }),
  };
  const dependencies = { filesystem: io, platform: "linux", getUid: () => 10001 };
  return {
    root,
    destination,
    plan,
    files,
    description,
    modes,
    opened,
    directoryReads,
    io,
    dependencies,
    run: (signal?: AbortSignal) =>
      createRuntimeTreeWriter(dependencies)({ destination, plan, signal }),
    inspect: () => createRuntimeDestinationInspector(dependencies)({ destination }),
    setStat: (next: typeof mutateStat) => {
      mutateStat = next;
    },
    setWrite: (next: typeof onWrite) => {
      onWrite = next;
    },
    setRead: (next: typeof onRead) => {
      onRead = next;
    },
    setClose: (next: typeof onClose) => {
      onClose = next;
    },
    setDirectoryRead: (next: typeof onDirectoryRead) => {
      onDirectoryRead = next;
    },
    setWriteCount: (next: number) => {
      writeCount = next;
    },
    setReadCount: (next: number) => {
      readCount = next;
    },
  };
}

function rejected(result: unknown, reason?: string) {
  expect(result).toMatchObject({
    status: "rejected",
    executed: false,
    portableRuntime: false,
    nativeSupport: false,
  });
  if (reason) expect(result).toHaveProperty("reason", reason);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}

describe("contained fixture runtime tree with synthetic input boundary", {
  concurrent: false,
  timeout: 10_000,
}, () => {
  it("creates exactly six physical package trees, privately stores and independently remeasures bytes", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      status: "assembled",
      storedTreeSha256: f.description.plannedTreeSha256,
      ...f.description,
    });
    expect(await fs.readdir(f.destination)).toEqual(["assembly-record.json", "runtime"]);
    for (const file of f.files)
      expect(await fs.readFile(join(f.destination, ...file.path.split("/")))).toEqual(file.data);
    expect(
      JSON.parse(await fs.readFile(join(f.destination, "assembly-record.json"), "utf8")),
    ).toEqual(result);
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
    expect(f.opened.filter((entry) => entry.directory).length).toBeGreaterThan(6);
    for (const [, options] of f.io.opendir.mock.calls) expect(options).toEqual({ bufferSize: 1 });
    for (const [path, mode] of f.modes)
      expect(mode).toBe((await fs.lstat(path)).isDirectory() ? 0o700n : 0o600n);
    expect(JSON.stringify(result)).not.toContain(f.root);
  });

  it("offers read-only canonical destination preflight with internal parent identity", async () => {
    const f = await fixture();
    const result = await f.inspect();
    expect(result).toMatchObject({
      status: "available",
      parentIdentity: { dev: expect.any(BigInt), ino: expect.any(BigInt) },
    });
    expect(f.io.mkdir).not.toHaveBeenCalled();
    expect(f.io.open).not.toHaveBeenCalled();
    expect(f.io.opendir).not.toHaveBeenCalled();
  });

  it("uses only plan-bound independently reread snapshot bytes for relocation", async () => {
    const f = await fixture();
    const snapshot = Object.freeze({ fixtureSnapshot: true });
    inputs.snapshotFiles.mockImplementation((value, plan) =>
      value === snapshot && plan === f.plan
        ? f.files.map((file) => ({ ...file, data: Buffer.from(file.data) }))
        : undefined,
    );
    inputs.files.mockImplementation(() => {
      throw new Error("archive bytes must not substitute for rereads");
    });
    const result = await createRuntimeTreeWriter(f.dependencies)({
      destination: f.destination,
      plan: f.plan,
      sourceSnapshot: snapshot,
    });
    expect(result).toMatchObject({
      status: "assembled",
      storedTreeSha256: f.description.plannedTreeSha256,
    });
    expect(inputs.snapshotFiles).toHaveBeenCalledWith(snapshot, f.plan);
    expect(inputs.files).not.toHaveBeenCalled();
    for (const file of f.files)
      expect(await fs.readFile(join(f.destination, ...file.path.split("/")))).toEqual(file.data);
  });

  it.each([undefined, null, {}, { status: "measured" }])(
    "rejects a supplied unbranded snapshot without falling back",
    async (sourceSnapshot) => {
      const f = await fixture();
      rejected(
        await createRuntimeTreeWriter(f.dependencies)({
          destination: f.destination,
          plan: f.plan,
          sourceSnapshot,
        }),
        "invalid_plan",
      );
      expect(inputs.files).not.toHaveBeenCalled();
      expect(f.io.mkdir).not.toHaveBeenCalled();
    },
  );

  it.each(["bytes", "digest", "path", "count"])(
    "rechecks snapshot %s against the opaque plan before writes",
    async (field) => {
      const f = await fixture();
      const files = f.files.map((file) => ({ ...file, data: Buffer.from(file.data) }));
      if (field === "bytes") files[0].data[0] ^= 1;
      if (field === "digest") files[0].sha256 = "0".repeat(64);
      if (field === "path") files[0].path += ".different";
      if (field === "count") files.pop();
      inputs.snapshotFiles.mockReturnValue(files);
      rejected(
        await createRuntimeTreeWriter(f.dependencies)({
          destination: f.destination,
          plan: f.plan,
          sourceSnapshot: {},
        }),
        "invalid_plan",
      );
      expect(f.io.mkdir).not.toHaveBeenCalled();
    },
  );

  it.each(["win32", "darwin"])("rejects unsupported host %s before I/O", async (platform) => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeWriter({ ...f.dependencies, platform })({
        destination: f.destination,
        plan: f.plan,
      }),
      "unsupported_host",
    );
    expect(f.io.lstat).not.toHaveBeenCalled();
  });

  it.each(["", "relative/path", "/contains\nnewline", "/contains\u007fdel", 12, null])(
    "rejects malformed destination %s",
    async (destination) => {
      const f = await fixture();
      rejected(
        await createRuntimeTreeWriter(f.dependencies)({ destination, plan: f.plan }),
        "invalid_destination",
      );
      expect(f.io.mkdir).not.toHaveBeenCalled();
    },
  );

  it("rejects an existing destination and never resumes or deletes it", async () => {
    const f = await fixture();
    await fs.mkdir(f.destination);
    await fs.writeFile(join(f.destination, "owner.txt"), "owner data");
    rejected(await f.run(), "destination_unavailable");
    expect(await fs.readFile(join(f.destination, "owner.txt"), "utf8")).toBe("owner data");
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it("rejects aliased or inaccessible parents", async () => {
    const f = await fixture();
    f.io.realpath.mockResolvedValueOnce(`${f.root}-different`);
    rejected(await f.run(), "invalid_destination");
    f.io.realpath.mockRejectedValueOnce(new Error(PRIVATE));
    rejected(await f.run(), "storage_failed");
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it.each(["mode", "uid", "symlink"])("rejects unsafe parent %s", async (field) => {
    const f = await fixture();
    f.setStat((path, stat) =>
      path === f.root
        ? {
            ...stat,
            ...(field === "mode"
              ? { mode: 0o777n }
              : field === "uid"
                ? { uid: 99n }
                : { isSymbolicLink: () => true }),
          }
        : stat,
    );
    rejected(await f.run(), "invalid_destination");
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it("rejects a forged plan before destination mutation", async () => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeWriter(f.dependencies)({
        destination: f.destination,
        plan: { ...f.plan },
      }),
      "invalid_plan",
    );
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it.each(["hash", "count", "total", "tree", "path", "duplicate"])(
    "defensively rejects incoherent input-plan %s",
    async (mutation) => {
      const f = await fixture();
      const first = f.files[0];
      if (!first) throw new Error("missing fixture file");
      if (mutation === "hash") first.sha256 = "0".repeat(64);
      if (mutation === "count") f.description.fileCount += 1;
      if (mutation === "total") f.description.fileBytes += 1;
      if (mutation === "tree") f.description.plannedTreeSha256 = "0".repeat(64);
      if (mutation === "path") first.path = "runtime/node_modules/zod/../escape";
      if (mutation === "duplicate") f.files.push({ ...first });
      rejected(await f.run(), "invalid_plan");
      expect(f.io.mkdir).not.toHaveBeenCalled();
    },
  );

  it("snapshots verified input bytes before any filesystem writer callback can mutate originals", async () => {
    const f = await fixture();
    inputs.files.mockReturnValue(f.files);
    f.setWrite(async () => {
      for (const file of f.files) file.data.fill(0);
    });
    expect(await f.run()).toMatchObject({ status: "assembled" });
    expect(
      (
        await fs.readFile(join(f.destination, "runtime/node_modules/@agenthawk/cli/package.json"))
      ).toString(),
    ).toContain("inert synthetic fixture");
  });

  it("supports bounded short writes and reads including empty files", async () => {
    const f = await fixture();
    f.setWriteCount(1);
    f.setReadCount(1);
    expect(await f.run()).toMatchObject({ status: "assembled" });
  });

  it.each([0, -1, 0.5, Number.NaN, 999_999])(
    "rejects invalid write progress %s and closes retained handles",
    async (count) => {
      const f = await fixture();
      f.setWriteCount(count);
      rejected(await f.run(), "storage_failed");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
      expect(await fs.readdir(f.destination)).toContain("runtime");
    },
  );

  it.each([-1, 0.5, Number.NaN, 999_999])("rejects invalid read progress %s", async (count) => {
    const f = await fixture();
    f.setReadCount(count);
    rejected(await f.run(), "storage_failed");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("rejects truncated independent reads", async () => {
    const f = await fixture();
    f.setReadCount(0);
    rejected(await f.run(), "tree_mismatch");
  });

  it.each(["hardlink", "executable", "replacement"])(
    "rejects file identity/permission violation %s",
    async (kind) => {
      const f = await fixture();
      f.setStat((path, stat) =>
        path.endsWith("package.json")
          ? {
              ...stat,
              ...(kind === "hardlink"
                ? { nlink: 2n }
                : kind === "executable"
                  ? { mode: 0o700n }
                  : { ino: 0n }),
            }
          : stat,
      );
      rejected(await f.run(), "ownership_changed");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
    },
  );

  it("detects replacement of a nested intermediate directory before continuing writes", async () => {
    const f = await fixture();
    let changed = false;
    f.setWrite(async () => {
      changed = true;
    });
    const nested = join(f.destination, "runtime", "node_modules", "@agenthawk");
    f.setStat((path, stat) =>
      changed && path === nested ? { ...stat, ino: (stat.ino as bigint) + 1n } : stat,
    );
    rejected(await f.run(), "ownership_changed");
  });

  it("detects ancestor replacement even after its canonical preflight", async () => {
    const f = await fixture();
    let changed = false;
    f.setWrite(async () => {
      changed = true;
    });
    f.setStat((path, stat) =>
      changed && path === f.root ? { ...stat, ino: (stat.ino as bigint) + 1n } : stat,
    );
    rejected(await f.run(), "ownership_changed");
  });

  it("detects stored growth during independent remeasurement", async () => {
    const f = await fixture();
    let injected = false;
    f.setRead(async (path) => {
      if (!injected) {
        injected = true;
        await fs.appendFile(path, "unexpected growth");
      }
    });
    rejected(await f.run());
  });

  it("rejects a destination created between absence preflight and exclusive mkdir", async () => {
    const f = await fixture();
    const original = f.io.mkdir.getMockImplementation();
    if (!original) throw new Error("missing fixture mkdir");
    f.io.mkdir.mockImplementationOnce(async (path, options) => {
      await fs.mkdir(path, options);
      await fs.writeFile(join(path, "owner.txt"), "owner data from racing creation");
      return await original(path, options);
    });
    const result = await f.run();
    rejected(result, "destination_unavailable");
    expect(result).toHaveProperty("retainedState", "present_or_uncertain");
    expect(await fs.readFile(join(f.destination, "owner.txt"), "utf8")).toBe(
      "owner data from racing creation",
    );
    expect(f.io.open).not.toHaveBeenCalled();
  });

  it("rejects a newly created directory whose observed permissions are not private", async () => {
    const f = await fixture();
    f.setStat((path, stat) => (path === f.destination ? { ...stat, mode: 0o755n } : stat));
    rejected(await f.run(), "ownership_changed");
    expect(f.io.open).not.toHaveBeenCalled();
  });

  it("detects file modification after writer closure and before independent reopening", async () => {
    const f = await fixture();
    let changed = false;
    f.setClose(async (path, directory) => {
      if (!changed && !directory) {
        changed = true;
        await fs.appendFile(path, "late changed bytes");
      }
    });
    rejected(await f.run(), "ownership_changed");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("detects an added hard link at the post-write identity fence", async () => {
    const f = await fixture();
    let written = false;
    f.setWrite(async () => {
      written = true;
    });
    f.setStat((path, stat) =>
      written && path.endsWith("package.json") ? { ...stat, nlink: 2n } : stat,
    );
    rejected(await f.run(), "ownership_changed");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it.each(["type", "symlink", "missing", "duplicate"])(
    "rejects a bounded directory entry with %s mismatch and closes its handle",
    async (kind) => {
      const f = await fixture();
      const original = f.io.opendir.getMockImplementation();
      if (!original) throw new Error("missing fixture opendir");
      f.io.opendir.mockImplementationOnce(async (path, options) => {
        const handle = await original(path, options);
        let first: Awaited<ReturnType<typeof handle.read>>;
        return {
          ...handle,
          read: async () => {
            if (kind === "missing") return null;
            const entry = kind === "duplicate" && first ? first : await handle.read();
            first ??= entry;
            if (!entry || kind === "duplicate") return entry;
            return Object.assign(entry, {
              isSymbolicLink: () => kind === "symlink",
              isDirectory: () => false,
              isFile: () => false,
            });
          },
        };
      });
      rejected(await f.run(), "tree_mismatch");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
      expect(f.directoryReads.get(f.destination) ?? 0).toBeLessThanOrEqual(2);
    },
  );

  it.each(["file", "directory"])("rejects an extra %s in the completed tree", async (kind) => {
    const f = await fixture();
    let injected = false;
    f.setClose(async (path) => {
      if (!injected && path.endsWith("assembly-record.json")) {
        injected = true;
        const extra = join(f.destination, kind === "file" ? ".hidden-extra" : "extra-dir");
        if (kind === "file") await fs.writeFile(extra, "inert extra");
        else await fs.mkdir(extra);
      }
    });
    rejected(await f.run(), "tree_mismatch");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
    expect(f.directoryReads.get(f.destination)).toBeLessThanOrEqual(3);
  });

  it("rejects directory growth during bounded enumeration", async () => {
    const f = await fixture();
    let injected = false;
    f.setDirectoryRead(async (path) => {
      if (!injected) {
        injected = true;
        await fs.writeFile(join(path, "late-extra"), "extra");
      }
    });
    rejected(await f.run());
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("reports unconfirmed closure even when a file close error contains private data", async () => {
    const f = await fixture();
    f.setClose(async () => {
      throw new Error(PRIVATE);
    });
    rejected(await f.run(), "closure_unconfirmed");
  });

  it("accounts for failed directory closure", async () => {
    const f = await fixture();
    f.setClose(async (_path, directory) => {
      if (directory) throw new Error(PRIVATE);
    });
    rejected(await f.run(), "closure_unconfirmed");
  });

  it("cancels before admission without writes and stops mid-write with retained state", async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort(new Error(PRIVATE));
    rejected(await f.run(before.signal), "cancelled");
    expect(f.io.mkdir).not.toHaveBeenCalled();
    const during = new AbortController();
    f.setWrite(async () => {
      during.abort(new Error(PRIVATE));
    });
    const result = await f.run(during.signal);
    rejected(result, "cancelled");
    expect(result).toHaveProperty("retainedState", "present_or_uncertain");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("rejects malformed external cancellation and destination root", async () => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeWriter(f.dependencies)({
        destination: f.destination,
        plan: f.plan,
        signal: {},
      }),
      "invalid_destination",
    );
    let root = f.root;
    while (dirname(root) !== root) root = dirname(root);
    rejected(
      await createRuntimeTreeWriter(f.dependencies)({ destination: root, plan: f.plan }),
      "invalid_destination",
    );
  });
});
