import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureCleanupFence } from "../packages/cli/test/fixture-cleanup-fence.js";

const inputs = vi.hoisted(() => ({ describe: vi.fn(), files: vi.fn() }));
vi.mock("./runtime-assembly-inputs.mjs", () => ({
  describeRuntimeAssemblyPlan: inputs.describe,
  runtimeAssemblyFiles: inputs.files,
}));

import { createRuntimeTreeWriter } from "./runtime-tree.mjs";
import {
  createRuntimeTreeReader,
  describeRuntimeTreeSnapshot,
  readRuntimeTree,
  runtimeTreeSnapshotFiles,
  runtimeTreeSnapshotsDisjoint,
  runtimeTreeSnapshotsMatch,
} from "./runtime-tree-reader.mjs";

const PRIVATE = "fixture-private-path-and-provider-error";
const roots: string[] = [];
const fence = createFixtureCleanupFence();
beforeEach(({ signal }) => {
  fence.begin(signal);
  inputs.describe.mockReset();
  inputs.files.mockReset();
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
  const created = await fs.mkdtemp(join(tmpdir(), "agenthawk-runtime-reader-"));
  const index = roots.push(created) - 1;
  const root = await fs.realpath(created);
  roots[index] = root;
  const source = join(root, "prepared");
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
  const first = files[0];
  if (!first) throw new Error("missing fixture entry");
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
  let mutateStat = (_path: string, status: Record<string, unknown>, _handle: boolean) => status;
  let onRead = async (_path: string, _position: number) => {};
  let onClose = async (_path: string, _directory: boolean) => {};
  let onDirectoryRead = async (_path: string) => {};
  let readCount: number | undefined;
  let writesAllowed = false;
  const wrapStat = (
    path: string,
    status: Awaited<ReturnType<typeof fs.lstat>>,
    handle: boolean,
  ) => {
    // Linux ownership/mode seam on real tempfiles; never evidence of Windows ACL enforcement.
    return mutateStat(
      path,
      {
        ...status,
        uid: 10001n,
        mode: modes.get(path) ?? 0o755n,
        isDirectory: () => status.isDirectory(),
        isFile: () => status.isFile(),
        isSymbolicLink: () => status.isSymbolicLink(),
      },
      handle,
    );
  };
  const makeTree = async (destination: string) => {
    await fs.mkdir(destination);
    modes.set(destination, 0o700n);
    const outcome = {
      ...description,
      status: "assembled",
      storedTreeSha256: description.plannedTreeSha256,
    };
    for (const file of [
      ...files,
      { path: "assembly-record.json", data: Buffer.from(`${JSON.stringify(outcome)}\n`) },
    ]) {
      const path = join(destination, ...file.path.split("/"));
      await fs.mkdir(dirname(path), { recursive: true });
      for (let parent = dirname(path); parent !== destination; parent = dirname(parent))
        modes.set(parent, 0o700n);
      await fs.writeFile(path, file.data);
      modes.set(path, 0o600n);
    }
  };
  await makeTree(source);
  const io = {
    realpath: vi.fn(async (path: string) => await fs.realpath(path)),
    lstat: vi.fn(async (path: string) =>
      wrapStat(path, await fs.lstat(path, { bigint: true }), false),
    ),
    mkdir: vi.fn(async (path: string, options: { mode: number }) => {
      if (!writesAllowed) throw new Error("reader must never write");
      await fs.mkdir(path, options);
      modes.set(path, BigInt(options.mode));
    }),
    open: vi.fn(async (path: string, flags: number, mode?: number) => {
      const handle = await fs.open(path, flags, mode);
      if (mode !== undefined) modes.set(path, BigInt(mode));
      const observed = { path, closed: false, directory: false };
      opened.push(observed);
      return {
        stat: async () => wrapStat(path, await handle.stat({ bigint: true }), true),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          await onRead(path, position);
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
          if (!writesAllowed) throw new Error("reader must never write");
          return await handle.write(buffer, offset, length, position);
        },
        sync: async () => {
          if (!writesAllowed) throw new Error("reader must never sync");
          await handle.sync();
        },
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
    source,
    plan,
    description,
    files,
    modes,
    opened,
    directoryReads,
    io,
    dependencies,
    makeTree,
    first,
    firstPath: join(source, ...first.path.split("/")),
    run: (signal?: AbortSignal, path = source) =>
      createRuntimeTreeReader(dependencies)({ source: path, plan, signal }),
    setStat: (next: typeof mutateStat) => {
      mutateStat = next;
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
    setReadCount: (next: number) => {
      readCount = next;
    },
    allowWrites: () => {
      writesAllowed = true;
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
  expect(describeRuntimeTreeSnapshot(result)).toBeUndefined();
  expect(runtimeTreeSnapshotFiles(result, {})).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}

describe("bounded runtime reread and private snapshot capability", {
  concurrent: false,
  timeout: 15_000,
}, () => {
  it("independently reads every byte twice, checks the record and closes every handle", async () => {
    const f = await fixture();
    const token = await f.run();
    expect(token).toEqual({
      schemaVersion: 1,
      status: "measured",
      executed: false,
      portableRuntime: false,
      nativeSupport: false,
    });
    expect(Object.isFrozen(token)).toBe(true);
    const measured = describeRuntimeTreeSnapshot(token);
    expect(measured).toEqual({
      ...f.description,
      status: "measured",
      sourceTreeSha256: f.description.plannedTreeSha256,
    });
    expect(Object.isFrozen(measured)).toBe(true);
    expect(runtimeTreeSnapshotFiles(token, f.plan)).toEqual(f.files);
    expect(f.io.open).toHaveBeenCalledTimes(2 * (f.files.length + 1));
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
    expect(f.io.mkdir).not.toHaveBeenCalled();
    for (const [, options] of f.io.opendir.mock.calls) expect(options).toEqual({ bufferSize: 1 });
    expect(JSON.stringify(measured)).not.toContain(f.root);
  });

  it("composes the real reader and writer with exact-plan byte copies and independent destination rereads", async () => {
    const f = await fixture();
    const sourceSnapshot = await f.run();
    const destination = join(f.root, "relocated");
    const exposed = runtimeTreeSnapshotFiles(sourceSnapshot, f.plan);
    for (const file of exposed) file.data.fill(0);
    f.allowWrites();
    const outcome = await createRuntimeTreeWriter(f.dependencies)({
      destination,
      plan: f.plan,
      sourceSnapshot,
    });
    expect(outcome).toMatchObject({
      status: "assembled",
      storedTreeSha256: f.description.plannedTreeSha256,
    });
    const destinationSnapshot = await f.run(undefined, destination);
    const sourceAfter = await f.run();
    expect(runtimeTreeSnapshotsMatch(sourceSnapshot, sourceAfter)).toBe(true);
    expect(runtimeTreeSnapshotsDisjoint(sourceAfter, destinationSnapshot)).toBe(true);
    expect(runtimeTreeSnapshotFiles(destinationSnapshot, f.plan)).toEqual(f.files);
    for (const file of f.files)
      expect(await fs.readFile(join(destination, ...file.path.split("/")))).toEqual(file.data);
    const forgedDestination = join(f.root, "forged");
    rejected(
      await createRuntimeTreeWriter(f.dependencies)({
        destination: forgedDestination,
        plan: f.plan,
        sourceSnapshot: { ...sourceSnapshot },
      }),
      "invalid_plan",
    );
    await expect(fs.lstat(forgedDestination)).rejects.toHaveProperty("code", "ENOENT");
    const other = Object.freeze({ fixture: "equivalent-but-distinct" });
    inputs.describe.mockImplementation((plan) => (plan === other ? f.description : undefined));
    inputs.files.mockImplementation((plan) => (plan === other ? f.files : undefined));
    rejected(
      await createRuntimeTreeWriter(f.dependencies)({
        destination: forgedDestination,
        plan: other,
        sourceSnapshot,
      }),
      "invalid_plan",
    );
    await expect(fs.lstat(forgedDestination)).rejects.toHaveProperty("code", "ENOENT");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("rejects cloned, serialized, failed and forged snapshots and mismatched exact plans", async () => {
    const f = await fixture();
    const token = await f.run();
    for (const forged of [
      new Proxy(token, {
        get() {
          throw new Error(PRIVATE);
        },
      }),
      { ...token },
      JSON.parse(JSON.stringify(token)),
      {},
      null,
      undefined,
      1,
    ]) {
      expect(describeRuntimeTreeSnapshot(forged)).toBeUndefined();
      expect(runtimeTreeSnapshotFiles(forged, f.plan)).toBeUndefined();
      expect(runtimeTreeSnapshotsMatch(token, forged)).toBe(false);
      expect(runtimeTreeSnapshotsDisjoint(forged, token)).toBe(false);
    }
    expect(runtimeTreeSnapshotFiles(token, { ...f.plan })).toBeUndefined();
    const copy = runtimeTreeSnapshotFiles(token, f.plan);
    copy[0].data.fill(0);
    copy[0].path = "outside";
    copy.pop();
    expect(runtimeTreeSnapshotFiles(token, f.plan)).toEqual(f.files);
  });

  it("snapshots actual rereads, even if source plan buffers change during filesystem callbacks", async () => {
    const f = await fixture();
    const original = f.files.map((file) => ({ ...file, data: Buffer.from(file.data) }));
    inputs.files.mockReturnValue(f.files);
    f.setRead(async () => {
      for (const file of f.files) file.data.fill(0);
    });
    const token = await f.run();
    expect(runtimeTreeSnapshotFiles(token, f.plan)).toEqual(original);
  });

  it("matches repeated unchanged tree observations but requires disjoint physical copies", async () => {
    const f = await fixture();
    const first = await f.run();
    const second = await f.run();
    expect(runtimeTreeSnapshotsMatch(first, second)).toBe(true);
    expect(runtimeTreeSnapshotsDisjoint(first, second)).toBe(false);
    const relocated = join(f.root, "relocated");
    await f.makeTree(relocated);
    const third = await f.run(undefined, relocated);
    expect(runtimeTreeSnapshotsMatch(first, third)).toBe(false);
    expect(runtimeTreeSnapshotsDisjoint(first, third)).toBe(true);
    expect(runtimeTreeSnapshotsDisjoint(third, first)).toBe(true);
  });

  it.each(["file-time", "directory-time", "file-identity"])(
    "rejects a changed %s in cross-read comparison",
    async (kind) => {
      const f = await fixture();
      const first = await f.run();
      const target = kind === "directory-time" ? join(f.source, "runtime") : f.firstPath;
      f.setStat((path, stat) =>
        path === target
          ? {
              ...stat,
              ...(kind === "file-identity"
                ? { ino: (stat.ino as bigint) + 500n }
                : { mtimeNs: (stat.mtimeNs as bigint) + 1n }),
            }
          : stat,
      );
      const second = await f.run();
      expect(second).toHaveProperty("status", "measured");
      expect(runtimeTreeSnapshotsMatch(first, second)).toBe(false);
    },
  );

  it("rejects shared file identity even under different canonical roots", async () => {
    const f = await fixture();
    const relocated = join(f.root, "relocated");
    await f.makeTree(relocated);
    const status = await fs.lstat(f.firstPath, { bigint: true });
    const first = await f.run();
    f.setStat((path, stat) =>
      path === join(relocated, ...f.first.path.split("/"))
        ? { ...stat, dev: status.dev, ino: status.ino }
        : stat,
    );
    const second = await f.run(undefined, relocated);
    expect(second).toHaveProperty("status", "measured");
    expect(runtimeTreeSnapshotsDisjoint(first, second)).toBe(false);
  });

  it.each(["win32", "darwin"])("rejects unsupported host %s without I/O", async (platform) => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeReader({ ...f.dependencies, platform })({
        source: f.source,
        plan: f.plan,
      }),
      "unsupported_host",
    );
    expect(f.io.realpath).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "relative/path",
    "/contains\nnewline",
    "/contains\u007fdel",
    12,
    null,
    "x".repeat(4097),
  ])("rejects invalid source %s", async (source) => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeReader(f.dependencies)({ source, plan: f.plan }),
      "invalid_source",
    );
    expect(f.io.realpath).not.toHaveBeenCalled();
  });

  it("rejects roots, dot paths, negative owner IDs and malformed signals", async () => {
    const f = await fixture();
    for (const source of [parse(f.source).root, `${f.source}/../prepared`])
      rejected(
        await createRuntimeTreeReader(f.dependencies)({ source, plan: f.plan }),
        "invalid_source",
      );
    rejected(
      await createRuntimeTreeReader({ ...f.dependencies, getUid: () => -1 })({
        source: f.source,
        plan: f.plan,
      }),
      "invalid_source",
    );
    rejected(
      await createRuntimeTreeReader(f.dependencies)({ source: f.source, plan: f.plan, signal: {} }),
      "invalid_source",
    );
    rejected(await createRuntimeTreeReader(f.dependencies)(), "invalid_source");
  });

  it("rejects aliased roots and inaccessible parents without exposing errors", async () => {
    const f = await fixture();
    f.io.realpath.mockResolvedValueOnce(`${f.source}-alias`);
    rejected(await f.run(), "invalid_source");
    f.io.realpath.mockRejectedValueOnce(new Error(PRIVATE));
    rejected(await f.run(), "storage_failed");
    f.io.realpath
      .mockImplementationOnce(async () => f.source)
      .mockResolvedValueOnce(`${f.root}-alias`);
    rejected(await f.run(), "invalid_source");
  });

  it.each(["mode", "uid", "symlink", "type"])("rejects unsafe parent %s", async (field) => {
    const f = await fixture();
    f.setStat((path, stat) =>
      path === f.root
        ? {
            ...stat,
            ...(field === "mode"
              ? { mode: 0o777n }
              : field === "uid"
                ? { uid: 99n }
                : field === "symlink"
                  ? { isSymbolicLink: () => true }
                  : { isDirectory: () => false }),
          }
        : stat,
    );
    rejected(await f.run(), "invalid_source");
    expect(f.io.open).not.toHaveBeenCalled();
  });

  it("permits root-owned non-writable ancestors but not a root-owned immediate parent", async () => {
    const f = await fixture();
    f.setStat((path, stat) => (path === dirname(f.root) ? { ...stat, uid: 0n } : stat));
    expect(await f.run()).toHaveProperty("status", "measured");
    f.setStat((path, stat) => (path === f.root ? { ...stat, uid: 0n } : stat));
    rejected(await f.run(), "invalid_source");
  });

  it("rejects forged plans before opening any filesystem object", async () => {
    const f = await fixture();
    rejected(
      await createRuntimeTreeReader(f.dependencies)({ source: f.source, plan: { ...f.plan } }),
      "invalid_plan",
    );
    expect(f.io.realpath).not.toHaveBeenCalled();
  });

  it.each([
    "hash",
    "count",
    "total",
    "tree",
    "path",
    "duplicate",
    "size",
    "nonbuffer",
    "too-many",
    "empty",
    "record",
  ])("rejects inconsistent trusted-plan fixture %s", async (kind) => {
    const f = await fixture();
    const first = f.first;
    if (kind === "hash") first.sha256 = "0".repeat(64);
    if (kind === "count") f.description.fileCount += 1;
    if (kind === "total") f.description.fileBytes += 1;
    if (kind === "tree") f.description.plannedTreeSha256 = "0".repeat(64);
    if (kind === "path") first.path = "runtime/node_modules/zod/../escape";
    if (kind === "duplicate") f.files.push({ ...first });
    if (kind === "size") first.size = -1;
    if (kind === "nonbuffer")
      inputs.files.mockReturnValue([{ ...first, data: new Uint8Array(first.data) }]);
    if (kind === "too-many")
      inputs.files.mockReturnValue(Array.from({ length: 1401 }, () => first));
    if (kind === "empty") inputs.files.mockReturnValue([]);
    if (kind === "record") f.description.source.fixture = "x".repeat(65536) as unknown as boolean;
    rejected(await f.run(), "invalid_plan");
    expect(f.io.open).not.toHaveBeenCalled();
  });

  it.each(["missing", "extra-file", "extra-directory", "record", "bytes", "length"])(
    "rejects source %s disagreement",
    async (kind) => {
      const f = await fixture();
      if (kind === "missing") await fs.unlink(f.firstPath);
      if (kind === "extra-file") await fs.writeFile(join(f.source, "hidden-extra"), "extra");
      if (kind === "extra-directory") await fs.mkdir(join(f.source, "extra"));
      if (kind === "record")
        await fs.writeFile(join(f.source, "assembly-record.json"), '{"status":"assembled"}\n');
      if (kind === "bytes") await fs.writeFile(f.firstPath, Buffer.alloc(f.first.size));
      if (kind === "length") await fs.appendFile(f.firstPath, "growth");
      rejected(await f.run(), "tree_mismatch");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
    },
  );

  it.each(["mode", "symlink", "owner", "zero-inode", "hardlink", "type"])(
    "rejects private file %s failure",
    async (kind) => {
      const f = await fixture();
      f.setStat((path, stat) =>
        path === f.firstPath
          ? {
              ...stat,
              ...(kind === "mode"
                ? { mode: 0o700n }
                : kind === "symlink"
                  ? { isSymbolicLink: () => true }
                  : kind === "owner"
                    ? { uid: 99n }
                    : kind === "zero-inode"
                      ? { ino: 0n }
                      : kind === "hardlink"
                        ? { nlink: 2n }
                        : { isFile: () => false }),
            }
          : stat,
      );
      rejected(await f.run(), "ownership_changed");
    },
  );

  it("rejects real hard links before exposing source bytes", async () => {
    const f = await fixture();
    await fs.link(f.firstPath, join(f.root, "link"));
    rejected(await f.run(), "ownership_changed");
  });

  it("rejects non-private intermediate directory and malformed identity observation", async () => {
    const f = await fixture();
    const nested = join(f.source, "runtime", "node_modules");
    f.modes.set(nested, 0o755n);
    rejected(await f.run(), "ownership_changed");
    f.modes.set(nested, 0o700n);
    f.setStat((path, stat) => (path === f.root ? { ...stat, dev: 1 } : stat));
    rejected(await f.run(), "ownership_changed");
  });

  it.each(["ancestor", "directory", "file"])(
    "detects %s replacement during reads",
    async (kind) => {
      const f = await fixture();
      let changed = false;
      f.setRead(async () => {
        changed = true;
      });
      const target =
        kind === "ancestor"
          ? f.root
          : kind === "directory"
            ? join(f.source, "runtime", "node_modules")
            : f.firstPath;
      f.setStat((path, stat) =>
        changed && path === target ? { ...stat, ino: (stat.ino as bigint) + 1n } : stat,
      );
      rejected(await f.run(), "ownership_changed");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
    },
  );

  it("detects pathname/open-handle identity disagreement", async () => {
    const f = await fixture();
    f.setStat((path, stat, handle) =>
      path === f.firstPath && handle ? { ...stat, ino: (stat.ino as bigint) + 1n } : stat,
    );
    rejected(await f.run(), "ownership_changed");
  });

  it("detects file mutation on close and a prior file changed during later I/O", async () => {
    const f = await fixture();
    let changed = false;
    f.setClose(async (path, directory) => {
      if (!changed && !directory) {
        changed = true;
        await fs.appendFile(path, "changed-on-close");
      }
    });
    rejected(await f.run(), "ownership_changed");
    await fs.writeFile(f.firstPath, f.first.data);
    f.setClose(async () => {});
    f.setRead(async (path) => {
      if (path.endsWith("assembly-record.json"))
        await fs.appendFile(f.firstPath, "changed-prior-file");
    });
    rejected(await f.run(), "ownership_changed");
  });

  it.each(["growth", "truncate"])("detects file %s while a handle is open", async (kind) => {
    const f = await fixture();
    let changed = false;
    f.setRead(async (path) => {
      if (!changed) {
        changed = true;
        if (kind === "growth") await fs.appendFile(path, "late");
        else await fs.truncate(path, 0);
      }
    });
    rejected(await f.run(), "ownership_changed");
  });

  it("supports bounded short reads and requires an extra EOF read", async () => {
    const f = await fixture();
    f.setReadCount(1);
    const positions: number[] = [];
    f.setRead(async (path, position) => {
      if (path === f.firstPath) positions.push(position);
    });
    expect(await f.run()).toHaveProperty("status", "measured");
    expect(positions.filter((position) => position === f.first.size)).toHaveLength(2);
  });

  it.each([-1, 0.5, Number.NaN, 999999])("rejects invalid read count %s", async (count) => {
    const f = await fixture();
    f.setReadCount(count);
    rejected(await f.run(), "storage_failed");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("rejects early EOF instead of filling missing data from the plan", async () => {
    const f = await fixture();
    f.setReadCount(0);
    rejected(await f.run(), "tree_mismatch");
  });

  it.each(["type", "symlink", "missing", "duplicate", "name", "undefined"])(
    "rejects hostile directory entry %s with bounded enumeration",
    async (kind) => {
      const f = await fixture();
      const original = f.io.opendir.getMockImplementation();
      if (!original) throw new Error("missing fixture directory opener");
      f.io.opendir.mockImplementationOnce(async (path, options) => {
        const handle = await original(path, options);
        let first: Awaited<ReturnType<typeof handle.read>>;
        return {
          ...handle,
          read: async () => {
            if (kind === "missing") return null;
            if (kind === "undefined") return undefined as unknown as null;
            const entry = kind === "duplicate" && first ? first : await handle.read();
            first ??= entry;
            if (!entry || kind === "duplicate") return entry;
            return Object.assign(entry, {
              ...(kind === "name" ? { name: "../outside" } : {}),
              isSymbolicLink: () => kind === "symlink",
              isDirectory: () => false,
              isFile: () => false,
            });
          },
        };
      });
      rejected(await f.run(), "tree_mismatch");
      expect(f.opened.every((entry) => entry.closed)).toBe(true);
      expect(f.directoryReads.get(f.source) ?? 0).toBeLessThanOrEqual(3);
    },
  );

  it("detects directory mutation during enumeration", async () => {
    const f = await fixture();
    let changed = false;
    f.setDirectoryRead(async (path) => {
      if (!changed) {
        changed = true;
        await fs.mkdir(join(path, "late-extra"));
      }
    });
    rejected(await f.run());
  });

  it.each([false, true])(
    "preserves unconfirmed %s directory close failures and redacts details",
    async (directory) => {
      const f = await fixture();
      f.setClose(async (_path, isDirectory) => {
        if (isDirectory === directory) throw new Error(PRIVATE);
      });
      rejected(await f.run(), "closure_unconfirmed");
    },
  );

  it("cancels before I/O and during reads, never minting a snapshot", async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort(PRIVATE);
    rejected(await f.run(before.signal), "cancelled");
    expect(f.io.open).not.toHaveBeenCalled();
    const during = new AbortController();
    f.setRead(async () => {
      during.abort(PRIVATE);
    });
    rejected(await f.run(during.signal), "cancelled");
    expect(f.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("keeps unconfirmed close ahead of external cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.setClose(async () => {
      controller.abort(PRIVATE);
      throw new Error(PRIVATE);
    });
    rejected(await f.run(controller.signal), "closure_unconfirmed");
  });

  it("does not mint a token before the final handle close settles", async () => {
    const f = await fixture();
    let finish: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.setClose(async () => {
      reached?.();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    let complete = false;
    const pending = f.run().then((result) => {
      complete = true;
      return result;
    });
    await gate;
    expect(complete).toBe(false);
    f.setClose(async () => {});
    finish?.();
    expect(await pending).toHaveProperty("status", "measured");
  });

  it("cancels during final enumeration closure and does not grant snapshot authority", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let records = 0;
    f.setClose(async (path, directory) => {
      if (!directory && path.endsWith("assembly-record.json")) records += 1;
      if (directory && records === 2) controller.abort(PRIVATE);
    });
    rejected(await f.run(controller.signal), "cancelled");
  });

  it("rejects overlapping roots and equivalent but different exact plan authorities", async () => {
    const f = await fixture();
    const first = await f.run();
    const nested = join(f.source, "nested");
    await f.makeTree(nested);
    const second = await f.run(undefined, nested);
    expect(second).toHaveProperty("status", "measured");
    expect(runtimeTreeSnapshotsDisjoint(first, second)).toBe(false);
    expect(runtimeTreeSnapshotsDisjoint(second, first)).toBe(false);
    const other = Object.freeze({ fixture: "different-authority" });
    inputs.describe.mockImplementation((plan) => (plan === other ? f.description : undefined));
    inputs.files.mockImplementation((plan) => (plan === other ? f.files : undefined));
    const third = await createRuntimeTreeReader(f.dependencies)({ source: nested, plan: other });
    expect(third).toHaveProperty("status", "measured");
    expect(runtimeTreeSnapshotsMatch(second, third)).toBe(false);
    expect(runtimeTreeSnapshotsDisjoint(first, third)).toBe(false);
    expect(runtimeTreeSnapshotFiles(third, f.plan)).toBeUndefined();
  });

  it("default entrypoint preserves host restrictions before touching a malformed source", async () => {
    rejected(
      await readRuntimeTree({}),
      process.platform === "linux" ? "invalid_source" : "unsupported_host",
    );
  });

  it.each(["aggregate-bytes", "directories", "prefix-collision"])(
    "bounds planned %s before any I/O",
    async (kind) => {
      const f = await fixture();
      const entries =
        kind === "aggregate-bytes"
          ? Array.from({ length: 8 }, (_, index) => ({
              path: `runtime/node_modules/zod/${index}`,
              data: Buffer.alloc(1_000_000),
            }))
          : kind === "directories"
            ? Array.from({ length: 23 }, (_, index) => ({
                path: `runtime/node_modules/zod/b${index}/${"a/".repeat(100)}file`,
                data: Buffer.alloc(0),
              }))
            : [
                { path: "runtime/node_modules/zod/collision", data: Buffer.alloc(0) },
                { path: "runtime/node_modules/zod/collision/child", data: Buffer.alloc(0) },
              ];
      const files = entries
        .map(({ path, data }) => ({ path, size: data.length, sha256: hash(data), data }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      inputs.files.mockReturnValue(files);
      f.description.fileCount = files.length;
      f.description.fileBytes = files.reduce((sum, { size }) => sum + size, 0);
      f.description.plannedTreeSha256 = hash(
        JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
      );
      rejected(await f.run(), "invalid_plan");
      expect(f.io.realpath).not.toHaveBeenCalled();
    },
  );

  it("enforces aggregate deadline while individual operations continue making bounded progress", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const original = f.io.lstat.getMockImplementation();
    if (!original) throw new Error("missing fixture stat");
    f.io.lstat.mockImplementation(async (path) => {
      const observed = await original(path);
      vi.advanceTimersByTime(29_999);
      return observed;
    });
    rejected(await f.run(), "deadline_exceeded");
  });

  it("retains cancellation as first cause when the aggregate deadline subsequently expires", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const controller = new AbortController();
    f.io.realpath.mockImplementationOnce(async (path) => {
      controller.abort(PRIVATE);
      vi.advanceTimersByTime(240_000);
      return path;
    });
    rejected(await f.run(controller.signal), "cancelled");
  });

  it("accounts for late open handles and never mints success after uncertain settlement", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const original = f.io.open.getMockImplementation();
    if (!original) throw new Error("missing fixture opener");
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.io.open.mockImplementationOnce(async (path, flags) => {
      const handle = await original(path, flags);
      reached?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return handle;
    });
    const pending = f.run();
    await gate;
    await vi.advanceTimersByTimeAsync(35_001);
    const result = await pending;
    rejected(result, "closure_unconfirmed");
    release?.();
    vi.useRealTimers();
    await vi.waitFor(() => expect(f.opened.every((entry) => entry.closed)).toBe(true));
    expect(describeRuntimeTreeSnapshot(result)).toBeUndefined();
  });
});
