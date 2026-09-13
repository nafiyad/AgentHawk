import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeFilesystem } from "./claude-artifact-storage.mjs";
import type { ImageLayer } from "./fixture-image-layer-policy.mjs";
import {
  createImageLayerVerifier,
  fixtureImageLayerInputs,
  runImageLayerCommand,
  verifyFixtureImageLayers,
} from "./verify-fixture-image-layers.mjs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const PRIVATE = "fixture-private-error-not-for-output";
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
type Entry = {
  data: Buffer;
  directory: boolean;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  nlink: bigint;
  modified: bigint;
};
type Operation = { name: string; path: string; position?: number };
function world() {
  const destination = "/owned/verified";
  const base = Object.freeze({ fixture: true });
  const blobs = Array.from({ length: 8 }, (_, index) => Buffer.from(`inert layer ${index}`));
  const plan: ImageLayer[] = blobs.map((data) => ({
    digest: hash(data),
    size: data.length,
    file: `${hash(data).slice(7)}.blob`,
  }));
  const entries = new Map<string, Entry>();
  let inode = 1n;
  const make = (directory: boolean, mode: bigint): Entry => ({
    data: Buffer.alloc(0),
    directory,
    ino: inode++,
    mode,
    uid: 10001n,
    nlink: 1n,
    modified: 1n,
  });
  entries.set("/", make(true, 0o755n));
  entries.set("/owned", make(true, 0o700n));
  const calls: Operation[] = [];
  const handles: { path: string; closed: boolean; directory: boolean }[] = [];
  let before = async (_operation: Operation) => {};
  let statTransform = (_path: string, stat: BigIntStats, _handle: boolean) => stat;
  let chunkTransform = (data: Buffer): unknown => data;
  let writeCount: number | undefined;
  let readCount: number | undefined;
  let extraNames: string[] = [];
  let layerHook = async (_index: number, _signal: AbortSignal) => {};
  const record = async (name: string, path: string, position?: number) => {
    const operation = { name, path, position };
    calls.push(operation);
    await before(operation);
  };
  const get = (path: string) => {
    const entry = entries.get(path);
    if (!entry) throw Object.assign(new Error(PRIVATE), { code: "ENOENT" });
    return entry;
  };
  const changedParent = (path: string) => {
    get(posix.dirname(path)).modified++;
  };
  const status = (path: string, entry: Entry, handle = false) =>
    statTransform(
      path,
      {
        dev: 1n,
        ino: entry.ino,
        mode: entry.mode,
        uid: entry.uid,
        nlink: entry.nlink,
        size: BigInt(entry.data.length),
        mtimeNs: entry.modified,
        ctimeNs: entry.modified,
        isDirectory: () => entry.directory,
        isFile: () => !entry.directory,
        isSymbolicLink: () => false,
      } as BigIntStats,
      handle,
    );
  const io: RuntimeFilesystem = {
    realpath: async (path) => {
      await record("realpath", path);
      get(path);
      return path;
    },
    lstat: async (path) => {
      await record("lstat", path);
      return status(path, get(path));
    },
    mkdir: async (path, options) => {
      await record("mkdir", path);
      if (entries.has(path)) throw new Error(PRIVATE);
      expect(options).toEqual({ mode: 0o700 });
      get(posix.dirname(path));
      entries.set(path, make(true, BigInt(options.mode)));
      changedParent(path);
    },
    open: async (path, flags, mode) => {
      await record("open", path);
      const writing = Boolean(flags & constants.O_CREAT);
      if (writing) {
        expect(flags).toBe(
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
        );
        expect(mode).toBe(0o600);
        if (entries.has(path)) throw new Error(PRIVATE);
        entries.set(path, make(false, BigInt(mode ?? 0)));
        changedParent(path);
      } else expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const entry = get(path);
      const tracked = { path, closed: false, directory: false };
      handles.push(tracked);
      return {
        stat: async () => {
          await record("fstat", path);
          return status(path, entry, true);
        },
        write: async (buffer, offset, length, position) => {
          await record("write", path, position);
          expect(writing).toBe(true);
          expect(tracked.closed).toBe(false);
          const amount = writeCount === undefined ? length : Math.min(writeCount, length);
          if (!Number.isInteger(amount) || amount <= 0) return { bytesWritten: amount };
          const data = Buffer.alloc(Math.max(entry.data.length, position + amount));
          entry.data.copy(data);
          buffer.copy(data, position, offset, offset + amount);
          entry.data = data;
          entry.modified++;
          return {
            bytesWritten: writeCount !== undefined && writeCount > length ? writeCount : amount,
          };
        },
        read: async (buffer, offset, length, position) => {
          await record("read", path, position);
          expect(writing).toBe(false);
          expect(tracked.closed).toBe(false);
          if (
            readCount !== undefined &&
            (!Number.isInteger(readCount) || readCount < 0 || readCount > length)
          )
            return { bytesRead: readCount };
          const amount = Math.max(
            0,
            Math.min(length, entry.data.length - position, readCount ?? length),
          );
          entry.data.copy(buffer, offset, position, position + amount);
          return { bytesRead: amount };
        },
        sync: async () => {
          await record("sync", path);
        },
        close: async () => {
          await record("close", path);
          tracked.closed = true;
        },
      };
    },
    opendir: async (path, options) => {
      await record("opendir", path);
      expect(options).toEqual({ bufferSize: 1 });
      const names = [...entries.keys()]
        .filter((entry) => entry !== path && posix.dirname(entry) === path)
        .map((entry) => posix.basename(entry));
      names.push(...extraNames);
      const tracked = { path, closed: false, directory: true };
      handles.push(tracked);
      let index = 0;
      return {
        read: async () => {
          await record("readdir", path);
          const name = names[index++];
          if (name === undefined) return null;
          return {
            name,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          } as Dirent;
        },
        close: async () => {
          await record("dirclose", path);
          tracked.closed = true;
        },
      };
    },
  };
  const downloader = {
    metadata: vi.fn(async (_signal: AbortSignal): Promise<unknown> => base),
    layer: vi.fn(
      async (
        _base: unknown,
        index: number,
        sink: (chunk: unknown) => Promise<void>,
        signal: AbortSignal,
      ) => {
        expect(_base).toBe(base);
        await layerHook(index, signal);
        const bytes = blobs[index];
        if (!bytes) throw new Error("fixture missing");
        await sink(chunkTransform(Buffer.from(bytes)));
      },
    ),
  };
  const overrides = {
    filesystem: io,
    downloader,
    platform: "linux",
    getUid: () => 10001,
    planFor: (value: unknown) => (value === base ? plan : undefined),
  };
  const verifier = createImageLayerVerifier(overrides);
  return {
    destination,
    base,
    plan,
    blobs,
    entries,
    calls,
    handles,
    io,
    downloader,
    overrides,
    verifier,
    run: (signal?: AbortSignal) => verifier.verify(destination, signal),
    setBefore: (value: typeof before) => {
      before = value;
    },
    setStat: (value: typeof statTransform) => {
      statTransform = value;
    },
    setChunk: (value: typeof chunkTransform) => {
      chunkTransform = value;
    },
    setWrite: (value: number) => {
      writeCount = value;
    },
    setRead: (value: number) => {
      readCount = value;
    },
    setExtraNames: (value: string[]) => {
      extraNames = value;
    },
    setLayer: (value: typeof layerHook) => {
      layerHook = value;
    },
  };
}
function rejected(result: unknown, reason?: string) {
  expect(result).toMatchObject({
    status: "failed",
    layersVerified: false,
    imagePrepared: false,
    executed: false,
    isolated: false,
    portableRuntime: false,
    nativeSupport: false,
  });
  if (reason) expect(result).toHaveProperty("reason", reason);
  expect(fixtureImageLayerInputs(result)).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
  expect(JSON.stringify(result)).not.toContain("/owned");
}

describe("bounded independently reread image layer store", { concurrent: false }, () => {
  it("streams eight inert blobs, reopens every file twice, observes EOF and isolates all synthetic evidence", async () => {
    const f = world();
    const result = await f.run();
    expect(result).toMatchObject({
      status: "verified_layers",
      layersVerified: true,
      layerCount: 8,
      compressedBytes: f.blobs.reduce((sum, bytes) => sum + bytes.length, 0),
      imagePrepared: false,
      executed: false,
      isolated: false,
      portableRuntime: false,
      nativeSupport: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.downloader.layer).toHaveBeenCalledTimes(8);
    expect(f.handles).toHaveLength(26);
    expect(f.handles.every((handle) => handle.closed)).toBe(true);
    expect(f.calls.filter((call) => call.name === "readdir")).toHaveLength(18);
    expect(f.calls.filter((call) => call.name === "read")).toHaveLength(32);
    for (const [index, layer] of f.plan.entries())
      expect(f.entries.get(`${f.destination}/${layer.file}`)?.data).toEqual(f.blobs[index]);
    const evidence = f.verifier.inputs(result);
    expect(evidence?.files).toHaveLength(8);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(
      evidence?.files.every((file) => Object.isFrozen(file) && Object.isFrozen(file.observation)),
    ).toBe(true);
    expect(fixtureImageLayerInputs(result)).toBeUndefined();
    expect(createImageLayerVerifier(f.overrides).inputs(result)).toBeUndefined();
    for (const value of [
      { ...result },
      JSON.parse(JSON.stringify(result)),
      new Proxy(result, {}),
      undefined,
      null,
      1,
    ])
      expect(f.verifier.inputs(value)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(f.destination);
  });
  it("copies nonzero-offset byte views before asynchronous writes and does not invoke shadowed properties", async () => {
    const f = world();
    let original: Uint8Array | undefined;
    f.setChunk((data) => {
      const backing = Buffer.concat([Buffer.from("outside"), data, Buffer.from("outside")]);
      original = new Uint8Array(backing.buffer, backing.byteOffset + 7, data.length);
      for (const name of ["length", "byteLength", "buffer"])
        Object.defineProperty(original, name, {
          get() {
            throw new Error(PRIVATE);
          },
        });
      Object.defineProperty(original, Symbol.iterator, {
        value() {
          throw new Error(PRIVATE);
        },
      });
      return original;
    });
    f.setBefore(async ({ name }) => {
      if (name === "write") original?.fill(0);
    });
    expect(await f.run()).toHaveProperty("status", "verified_layers");
  });
  it("handles short positive writes and reads with explicit EOF", async () => {
    const f = world();
    f.setWrite(1);
    f.setRead(1);
    expect(await f.run()).toHaveProperty("status", "verified_layers");
    expect(f.calls.filter((call) => call.name === "write").length).toBeGreaterThan(8);
  });
  it.each([0, -1, 0.5, Number.NaN, 500])(
    "rejects invalid write progress %s and retains bounded private state",
    async (count) => {
      const f = world();
      f.setWrite(count);
      const result = await f.run();
      rejected(result, "storage_failed");
      expect(result).toHaveProperty("retainedState", "present_or_uncertain");
      expect(f.downloader.layer).toHaveBeenCalledTimes(1);
      expect(f.handles.every((entry) => entry.closed)).toBe(true);
    },
  );
  it.each([0, -1, 0.5, Number.NaN, 500])("rejects invalid read progress %s", async (count) => {
    const f = world();
    f.setRead(count);
    rejected(await f.run(), count === 0 ? "layer_mismatch" : "storage_failed");
    expect(f.downloader.layer).toHaveBeenCalledTimes(1);
  });
  it.each(
    [
      undefined,
      null,
      {},
      "bytes",
      Buffer.alloc(0),
      Buffer.alloc(65537),
      new Uint16Array(8),
      new DataView(new ArrayBuffer(12)),
      new Proxy(Buffer.from("bytes"), {}),
      runInNewContext("new Uint8Array(12)"),
      new Uint8Array(new SharedArrayBuffer(12)),
    ].map((chunk, index) => [index, chunk] as const),
  )("rejects hostile or unbounded chunk case %i", async (_index, chunk) => {
    const f = world();
    f.setChunk(() => chunk);
    rejected(await f.run());
    expect(f.calls.some((call) => call.name === "write")).toBe(false);
  });
  it("rejects shared memory and wrong typed elements even when prototype-forged", async () => {
    for (const chunk of [
      Object.setPrototypeOf(new Uint8Array(new SharedArrayBuffer(12)), Buffer.prototype),
      Object.setPrototypeOf(new Uint16Array(6), Uint8Array.prototype),
      Object.setPrototypeOf(new SharedArrayBuffer(12), ArrayBuffer.prototype),
    ]) {
      const f = world();
      f.setChunk(() => chunk);
      rejected(await f.run());
    }
  });
  it("rejects a detached input buffer", async () => {
    const f = world();
    const bytes = new Uint8Array(12);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    f.setChunk(() => bytes);
    rejected(await f.run());
  });
  it.each(["short", "extra", "digest"])(
    "rejects %s streamed bytes before any next layer",
    async (kind) => {
      const f = world();
      f.setChunk((bytes) =>
        kind === "short"
          ? bytes.subarray(1)
          : kind === "extra"
            ? Buffer.concat([bytes, Buffer.from("x")])
            : Buffer.alloc(bytes.length),
      );
      rejected(await f.run(), "layer_mismatch");
      expect(f.downloader.layer).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects public metadata before output creation or layer request", async () => {
    const f = world();
    f.downloader.metadata.mockResolvedValue({ ...f.base });
    rejected(await f.run(), "invalid_plan");
    expect(f.downloader.layer).not.toHaveBeenCalled();
    expect(f.entries.has(f.destination)).toBe(false);
    const strict = createImageLayerVerifier({ ...f.overrides, planFor: undefined });
    rejected(await strict.verify(f.destination, undefined), "invalid_plan");
  });
  it.each(["short", "name", "duplicate", "size", "total", "digest"])(
    "rejects malformed synthetic plan %s",
    async (kind) => {
      const f = world();
      const plan = f.plan.map((entry) => ({ ...entry }));
      const first = plan[0];
      if (!first) throw new Error("fixture");
      if (kind === "short") plan.pop();
      if (kind === "name") first.file = "../escape";
      if (kind === "duplicate") plan[1] = { ...first };
      if (kind === "size") first.size = 211662336;
      if (kind === "total") for (const entry of plan) entry.size = 211662335;
      if (kind === "digest") first.digest = "sha256:bad";
      rejected(
        await createImageLayerVerifier({ ...f.overrides, planFor: () => plan }).verify(
          f.destination,
          undefined,
        ),
        "invalid_plan",
      );
      expect(f.entries.has(f.destination)).toBe(false);
    },
  );
  it.each([
    "",
    "/",
    "relative",
    "/owned/../escape",
    "/owned//alias",
    "/owned/trailing/",
    "/owned/back\\slash",
    "/owned/secret\n",
    `/${"a/".repeat(64)}final`,
    `/owned/${"é".repeat(2048)}`,
  ])("rejects noncanonical/bounded destination %s without requests", async (path) => {
    const f = world();
    rejected(await f.verifier.verify(path, undefined), "invalid_destination");
    expect(f.downloader.metadata).not.toHaveBeenCalled();
  });
  it("rejects unsupported host, UID and preexisting output without downloads", async () => {
    const f = world();
    rejected(
      await createImageLayerVerifier({ ...f.overrides, platform: "win32" }).verify(
        f.destination,
        undefined,
      ),
      "unsupported_host",
    );
    rejected(
      await createImageLayerVerifier({ ...f.overrides, getUid: () => -1 }).verify(
        f.destination,
        undefined,
      ),
      "unsupported_host",
    );
    f.entries.set(f.destination, { ...f.entries.get("/owned") } as Entry);
    rejected(await f.run(), "destination_unavailable");
    expect(f.downloader.metadata).not.toHaveBeenCalled();
  });
  it.each([
    "parent-owner",
    "ancestor-owner",
    "parent-write",
    "ancestor-sticky",
    "symlink",
    "alias",
  ])("rejects unsafe ancestor %s", async (kind) => {
    const f = world();
    f.setStat((path, status) => {
      if (
        (kind === "parent-owner" && path === "/owned") ||
        (kind === "ancestor-owner" && path === "/")
      )
        return { ...status, uid: 10002n };
      if (kind === "parent-write" && path === "/owned") return { ...status, mode: 0o777n };
      if (kind === "ancestor-sticky" && path === "/") return { ...status, mode: 0o1777n };
      if (kind === "symlink" && path === "/owned") return { ...status, isSymbolicLink: () => true };
      return status;
    });
    if (kind === "alias") f.io.realpath = async () => "/elsewhere";
    rejected(await f.run(), "invalid_destination");
    expect(f.downloader.metadata).not.toHaveBeenCalled();
  });
  it("permits root-owned safe higher ancestors but not root-owned immediate parent", async () => {
    const f = world();
    const ancestor = f.entries.get("/");
    if (!ancestor) throw new Error("fixture");
    ancestor.uid = 0n;
    expect(await f.run()).toHaveProperty("status", "verified_layers");
  });
  it.each(["uid", "mode", "link", "identity", "symlink", "type", "timestamp", "size"])(
    "rejects changed file %s on independent reopen",
    async (kind) => {
      const f = world();
      let afterClose = false;
      f.setBefore(async ({ name }) => {
        if (name === "close") afterClose = true;
      });
      f.setStat((path, status) => {
        if (!afterClose || !path.endsWith(".blob")) return status;
        if (kind === "uid") return { ...status, uid: 10002n };
        if (kind === "mode") return { ...status, mode: 0o644n };
        if (kind === "link") return { ...status, nlink: 2n };
        if (kind === "identity") return { ...status, ino: status.ino + 100n };
        if (kind === "symlink") return { ...status, isSymbolicLink: () => true };
        if (kind === "type") return { ...status, isFile: () => false };
        if (kind === "timestamp") return { ...status, ctimeNs: status.ctimeNs + 1n };
        return { ...status, size: status.size + 1n };
      });
      rejected(await f.run(), "ownership_changed");
      expect(f.downloader.layer).toHaveBeenCalledTimes(1);
    },
  );
  it("detects bytes changed without observable stat changes on reread", async () => {
    const f = world();
    f.setBefore(async ({ name, path }) => {
      if (name === "close") f.entries.get(path)?.data.fill(0);
    });
    rejected(await f.run(), "layer_mismatch");
  });
  it("detects extra stored EOF bytes even when all stat sizes lie", async () => {
    const f = world();
    let changed = false;
    f.setBefore(async ({ name, path }) => {
      if (name === "close" && !changed) {
        const entry = f.entries.get(path);
        if (entry) entry.data = Buffer.concat([entry.data, Buffer.from("x")]);
        changed = true;
      }
    });
    f.setStat((path, stat) =>
      path.endsWith(".blob") && changed ? { ...stat, size: BigInt(f.blobs[0]?.length ?? 0) } : stat,
    );
    rejected(await f.run(), "layer_mismatch");
  });
  it.each(["extra.blob", "assembly-record.json"])(
    "rejects extra inventory %s with bounded enumeration",
    async (extra) => {
      const f = world();
      f.setExtraNames([extra]);
      rejected(await f.run(), "layer_mismatch");
      expect(f.calls.filter((call) => call.name === "readdir").length).toBeLessThanOrEqual(9);
    },
  );
  it("rejects duplicate inventory entries", async () => {
    const f = world();
    f.setExtraNames([f.plan[0]?.file ?? "missing"]);
    rejected(await f.run(), "layer_mismatch");
  });
  it("detects missing inventory, root and ancestor replacements during later layer work", async () => {
    for (const kind of ["missing", "root", "ancestor"]) {
      const f = world();
      f.setLayer(async (index) => {
        if (index !== 7) return;
        if (kind === "missing") f.entries.delete(`${f.destination}/${f.plan[0]?.file}`);
        else {
          const entry = f.entries.get(kind === "root" ? f.destination : "/owned");
          if (entry) entry.ino += 100n;
        }
      });
      rejected(await f.run(), kind === "missing" ? "layer_mismatch" : "ownership_changed");
    }
  });
  it("fences earlier files again after a later final reread closes", async () => {
    const f = world();
    let reads = 0;
    f.setBefore(async ({ name }) => {
      if (name === "open" && f.downloader.layer.mock.calls.length === 8) reads++;
      if (reads === 9 && name === "close") {
        const first = f.entries.get(`${f.destination}/${f.plan[0]?.file}`);
        if (first) first.ino += 10n;
      }
    });
    rejected(await f.run(), "ownership_changed");
  });
  it("retains uncertain creation after a rejected mkdir", async () => {
    const f = world();
    f.io.mkdir = async () => {
      throw new Error(PRIVATE);
    };
    const result = await f.run();
    rejected(result, "storage_failed");
    expect(result).toHaveProperty("retainedState", "present_or_uncertain");
  });
  it("never starts work for a preaborted or forged signal and ignores shadowed signal methods", async () => {
    const f = world();
    const controller = new AbortController();
    controller.abort();
    rejected(await f.run(controller.signal), "cancelled");
    expect(f.calls).toHaveLength(0);
    for (const signal of [
      Object.create(AbortSignal.prototype),
      new Proxy(new AbortController().signal, {}),
    ])
      rejected(await f.run(signal));
    const fresh = new AbortController();
    Object.defineProperties(fresh.signal, {
      addEventListener: {
        value() {
          throw new Error(PRIVATE);
        },
      },
      removeEventListener: {
        value() {
          throw new Error(PRIVATE);
        },
      },
    });
    expect(await f.run(fresh.signal)).toHaveProperty("status", "verified_layers");
  });
  it("cancels after an admitted write settles and starts no next layer", async () => {
    const f = world();
    const controller = new AbortController();
    f.setBefore(async ({ name }) => {
      if (name === "write") controller.abort();
    });
    rejected(await f.run(controller.signal), "cancelled");
    expect(f.downloader.layer).toHaveBeenCalledTimes(1);
    expect(f.handles.every((entry) => entry.closed)).toBe(true);
  });
  it.each(["close", "dirclose"])("reports failed %s as unconfirmed closure", async (name) => {
    const f = world();
    f.setBefore(async (operation) => {
      if (operation.name === name) throw new Error(PRIVATE);
    });
    rejected(await f.run(), "closure_unconfirmed");
  });
  it("preserves transport cleanup uncertainty ahead of cancellation", async () => {
    const f = world();
    const controller = new AbortController();
    f.setLayer(async () => {
      controller.abort();
      throw new Error("download_cleanup_unconfirmed");
    });
    rejected(await f.run(controller.signal), "closure_unconfirmed");
  });
  it.each([
    ["download_timeout", "deadline_exceeded"],
    ["download_cancelled", "cancelled"],
    ["download_invalid_input", "download_failed"],
    ["download_cleanup_unconfirmed", "closure_unconfirmed"],
  ])("maps %s without misreporting a storage failure", async (transportCode, expected) => {
    for (const resource of ["metadata", "layer"] as const) {
      const f = world();
      f.downloader[resource].mockRejectedValue(new Error(transportCode));
      rejected(await f.run(), expected);
      expect(f.handles.every((entry) => entry.closed)).toBe(true);
      expect(f.downloader.layer).toHaveBeenCalledTimes(resource === "metadata" ? 0 : 1);
      expect(f.entries.has(f.destination)).toBe(resource === "layer");
    }
  });
  it("keeps the first failure ahead of a later cancellation during close", async () => {
    const f = world();
    const controller = new AbortController();
    f.setChunk(() => Buffer.alloc(0));
    f.setBefore(async ({ name }) => {
      if (name === "close") controller.abort();
    });
    rejected(await f.run(controller.signal), "layer_mismatch");
  });
  it("keeps first cancellation sticky if the total deadline fires during settlement", async () => {
    vi.useFakeTimers();
    const f = world();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    f.downloader.metadata.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_199_990));
      return f.base;
    });
    f.setBefore(async ({ name }) => {
      if (name === "write") {
        controller.abort();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const pending = f.run(controller.signal);
    await vi.advanceTimersByTimeAsync(1_199_991);
    await vi.advanceTimersByTimeAsync(9);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    rejected(await pending, "cancelled");
  });
  it("enforces the total deadline and starts no output after metadata cancellation", async () => {
    vi.useFakeTimers();
    const f = world();
    f.downloader.metadata.mockImplementation(async (signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("download_failed")), {
          once: true,
        }),
      );
      return f.base;
    });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(1_200_001);
    rejected(await pending, "deadline_exceeded");
    expect(f.entries.has(f.destination)).toBe(false);
    expect(f.downloader.layer).not.toHaveBeenCalled();
  });
  it("preserves the first local sink failure through transport error redaction", async () => {
    const f = world();
    f.setWrite(0);
    f.downloader.layer.mockImplementation(async (_base, _index, sink) => {
      try {
        await sink(Buffer.from("inert layer 0"));
      } catch {
        throw new Error("download_failed");
      }
    });
    rejected(await f.run(), "storage_failed");
  });
  it("retains unconfirmed late writes, closes only after write settlement and never mints success", async () => {
    vi.useFakeTimers();
    const f = world();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    f.setBefore(async ({ name }) => {
      if (name === "write") {
        controller.abort();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    const pending = f.run(controller.signal);
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    rejected(result, "closure_unconfirmed");
    expect(f.handles[0]?.closed).toBe(false);
    expect(f.downloader.layer).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.handles[0]?.closed).toBe(true);
    expect(f.verifier.inputs(result)).toBeUndefined();
  });
  // Harness deadlines allow full-suite/coverage contention; production limits
  // and actual operation-count assertions remain unchanged.
  it("enforces chunk count independently of byte totals", { timeout: 30_000 }, async () => {
    const f = world();
    const large = Buffer.alloc(65537, 1);
    f.blobs[0] = large;
    f.plan[0] = { digest: hash(large), size: large.length, file: `${hash(large).slice(7)}.blob` };
    f.downloader.layer.mockImplementation(async (_base, _index, sink) => {
      for (let count = 0; count < 65537; count++) await sink(Buffer.from([1]));
    });
    rejected(await f.run(), "layer_mismatch");
    expect(f.downloader.layer).toHaveBeenCalledTimes(1);
  });
  it("enforces the aggregate attempted-I/O budget before pathological read progress", {
    timeout: 30_000,
  }, async () => {
    const f = world();
    const large = Buffer.alloc(262144, 1);
    f.blobs[0] = large;
    f.plan[0] = { digest: hash(large), size: large.length, file: `${hash(large).slice(7)}.blob` };
    f.downloader.layer.mockImplementation(async (_base, _index, sink) => {
      for (let offset = 0; offset < large.length; offset += 65536)
        await sink(large.subarray(offset, offset + 65536));
    });
    f.setRead(1);
    rejected(await f.run(), "storage_failed");
    expect(f.calls.length).toBeLessThanOrEqual(262144);
    expect(f.handles.every((handle) => handle.closed)).toBe(true);
  });
  it("has a closed one-destination command and redacts unexpected verifier errors", async () => {
    const f = world();
    for (const args of [null, [], ["--url"], ["/one", "/two"], [5]])
      expect(await runImageLayerCommand(args, f.verifier.verify)).toHaveProperty("exitCode", 2);
    expect(await runImageLayerCommand([f.destination], f.verifier.verify)).toHaveProperty(
      "exitCode",
      0,
    );
    const bad = await runImageLayerCommand(["/fresh"], async () => {
      throw new Error(PRIVATE);
    });
    rejected(bad.result, "closure_unconfirmed");
    if (process.platform !== "linux")
      rejected(await verifyFixtureImageLayers("/fresh", undefined), "unsupported_host");
  });
});
