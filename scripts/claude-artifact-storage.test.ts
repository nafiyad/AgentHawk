import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedArtifactStorage } from "./claude-artifact-storage.mjs";

const PRIVATE = "fixture-private-storage-path-error";
const IO_NAMES = ["realpath", "lstat", "mkdir", "open"] as const;
const HANDLE_NAMES = ["stat", "read", "write", "sync", "close"] as const;
const signal = () => new AbortController().signal;

function deferred<T = unknown>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rawHandle() {
  return {
    fd: 12,
    stat: vi.fn(async (..._args: unknown[]) => ({ size: 3n })),
    read: vi.fn(async (..._args: unknown[]) => ({ bytesRead: 3 })),
    write: vi.fn(async (..._args: unknown[]) => ({ bytesWritten: 3 })),
    sync: vi.fn(async (..._args: unknown[]) => undefined),
    close: vi.fn(async (..._args: unknown[]) => undefined),
  };
}

function rawFilesystem(handle = rawHandle()) {
  return {
    realpath: vi.fn(async (..._args: unknown[]) => "/fixture"),
    lstat: vi.fn(async (..._args: unknown[]) => ({ size: 3n })),
    mkdir: vi.fn(async (..._args: unknown[]) => undefined),
    open: vi.fn(async (..._args: unknown[]) => handle),
  };
}

async function expectFailure(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(code);
  expect((error as Error).cause).toBeUndefined();
  expect(String(error)).not.toContain(PRIVATE);
}

afterEach(() => vi.useRealTimers());

describe("bounded retained-artifact storage", () => {
  it("exposes only frozen guarded I/O and settlement without native descriptors", async () => {
    const raw = rawHandle();
    const source = rawFilesystem(raw);
    const guard = createBoundedArtifactStorage(source, signal());
    expect(Object.keys(guard).sort()).toEqual(["filesystem", "settle"]);
    expect(Object.keys(guard.filesystem).sort()).toEqual([...IO_NAMES].sort());
    expect(Object.isFrozen(guard)).toBe(true);
    expect(Object.isFrozen(guard.filesystem)).toBe(true);
    const handle = await guard.filesystem.open("/fixture/file", 128, 0o600);
    expect(Object.keys(handle).sort()).toEqual([...HANDLE_NAMES].sort());
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).not.toHaveProperty("fd");
    expect(source.open).toHaveBeenCalledExactlyOnceWith("/fixture/file", 128, 0o600);
    await expect(guard.settle()).resolves.toBe(true);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("passes successful results, exact arguments and original this bindings", async () => {
    const raw = rawHandle();
    const source = rawFilesystem(raw);
    const { filesystem, settle } = createBoundedArtifactStorage(source, signal());
    await expect(filesystem.realpath("/fixture")).resolves.toBe("/fixture");
    await expect(filesystem.lstat("/fixture", { bigint: true })).resolves.toEqual({ size: 3n });
    await expect(filesystem.mkdir("/fixture/new", { mode: 0o700 })).resolves.toBeUndefined();
    const handle = await filesystem.open("/fixture/file", 128, 0o600);
    const bytes = Buffer.from("abc");
    await expect(handle.stat({ bigint: true })).resolves.toEqual({ size: 3n });
    await expect(handle.read(bytes, 0, 3, 0)).resolves.toEqual({ bytesRead: 3 });
    await expect(handle.write(bytes, 0, 3, 0)).resolves.toEqual({ bytesWritten: 3 });
    await expect(handle.sync()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();
    for (const name of IO_NAMES) expect(source[name].mock.contexts[0]).toBe(source);
    for (const name of HANDLE_NAMES) expect(raw[name].mock.contexts[0]).toBe(raw);
    expect(raw.read).toHaveBeenCalledExactlyOnceWith(bytes, 0, 3, 0);
    expect(raw.write).toHaveBeenCalledExactlyOnceWith(bytes, 0, 3, 0);
    await expect(settle()).resolves.toBe(true);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("closes multiple independently opened handles during ordinary settlement", async () => {
    const first = rawHandle();
    const second = rawHandle();
    const source = rawFilesystem(first);
    source.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const guard = createBoundedArtifactStorage(source, signal());
    await guard.filesystem.open("/fixture/one");
    await guard.filesystem.open("/fixture/two");
    const settled = guard.settle();
    expect(guard.settle()).toBe(settled);
    await expect(settled).resolves.toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    await expectFailure(guard.filesystem.mkdir("/fixture/later"), "storage_closed");
    expect(source.mkdir).not.toHaveBeenCalled();
  });

  it("keeps distinct guards independent across successive preparations", async () => {
    const firstSource = rawFilesystem();
    const first = createBoundedArtifactStorage(firstSource, signal());
    await first.filesystem.realpath("/fixture/one");
    await expect(first.settle()).resolves.toBe(true);
    const secondSource = rawFilesystem();
    const second = createBoundedArtifactStorage(secondSource, signal());
    await second.filesystem.realpath("/fixture/two");
    await expect(second.settle()).resolves.toBe(true);
    expect(secondSource.realpath).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, {}, 1, "signal"])(
    "rejects malformed signal %s without I/O",
    (value) => {
      const source = rawFilesystem();
      expect(() => createBoundedArtifactStorage(source, value)).toThrow("storage_invalid_input");
      for (const name of IO_NAMES) expect(source[name]).not.toHaveBeenCalled();
    },
  );

  it.each(IO_NAMES)("rejects a missing trusted filesystem method: %s", (name) => {
    const source: Record<string, unknown> = rawFilesystem();
    delete source[name];
    expect(() => createBoundedArtifactStorage(source, signal())).toThrow("storage_invalid_input");
  });

  it("redacts failures while obtaining trusted methods", () => {
    const source = new Proxy(
      {},
      {
        get() {
          throw new Error(PRIVATE);
        },
      },
    );
    expect(() => createBoundedArtifactStorage(source, signal())).toThrow("storage_invalid_input");
  });

  it("rejects pre-aborted admission and can establish that no work was started", async () => {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE));
    const source = rawFilesystem();
    const guard = createBoundedArtifactStorage(source, controller.signal);
    for (const name of IO_NAMES)
      await expectFailure(guard.filesystem[name]("/fixture"), "storage_cancelled");
    for (const name of IO_NAMES) expect(source[name]).not.toHaveBeenCalled();
    await expect(guard.settle()).resolves.toBe(true);
  });

  it.each(IO_NAMES)(
    "bounds stalled %s at 30s, retains underlying work and stops all new I/O",
    async (name) => {
      vi.useFakeTimers();
      const pending = deferred();
      const source = rawFilesystem();
      source[name].mockImplementation(() => pending.promise as never);
      const guard = createBoundedArtifactStorage(source, signal());
      let responded = false;
      const check = expectFailure(guard.filesystem[name]("/fixture"), "storage_timeout").then(
        () => {
          responded = true;
        },
      );
      await vi.advanceTimersByTimeAsync(29999);
      expect(responded).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await check;
      for (const next of IO_NAMES)
        await expectFailure(guard.filesystem[next]("/fixture/next"), "storage_timeout");
      expect(source[name]).toHaveBeenCalledTimes(1);
      for (const next of IO_NAMES.filter((entry) => entry !== name))
        expect(source[next]).not.toHaveBeenCalled();
      const settlement = guard.settle();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(settlement).resolves.toBe(false);
      // A late outcome remains tracked, but cannot change the delivered failure.
      if (name === "open") {
        const late = rawHandle();
        pending.resolve(late);
        await vi.advanceTimersByTimeAsync(0);
        expect(late.close).toHaveBeenCalledTimes(1);
      } else pending.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      await expect(guard.settle()).resolves.toBe(false);
    },
  );

  it.each(HANDLE_NAMES)(
    "bounds stalled handle.%s and never confuses timeout with closure",
    async (name) => {
      vi.useFakeTimers();
      const pending = deferred();
      const raw = rawHandle();
      raw[name].mockImplementation(() => pending.promise as never);
      const guard = createBoundedArtifactStorage(rawFilesystem(raw), signal());
      const handle = await guard.filesystem.open("/fixture/file");
      const check = expectFailure(handle[name](Buffer.from("abc"), 0, 3, 0), "storage_timeout");
      await vi.advanceTimersByTimeAsync(30000);
      await check;
      await expectFailure(handle.write(Buffer.from("next")), "storage_timeout");
      const settled = guard.settle();
      await vi.advanceTimersByTimeAsync(5000);
      await expect(settled).resolves.toBe(false);
      if (name !== "close") expect(raw.close).not.toHaveBeenCalled();
      pending.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(raw.close).toHaveBeenCalledTimes(1);
      await expect(guard.settle()).resolves.toBe(false);
    },
  );

  it.each(IO_NAMES)("redacts rejected %s and stops subsequent mutations", async (name) => {
    const source = rawFilesystem();
    source[name].mockRejectedValue(new Error(PRIVATE));
    const guard = createBoundedArtifactStorage(source, signal());
    await expectFailure(guard.filesystem[name]("/fixture"), "storage_failed");
    await expectFailure(guard.filesystem.mkdir("/fixture/later"), "storage_failed");
    await expect(guard.settle()).resolves.toBe(true);
  });

  it.each(HANDLE_NAMES)("redacts rejected handle.%s and accounts for closure", async (name) => {
    const raw = rawHandle();
    raw[name].mockRejectedValue(new Error(PRIVATE));
    const guard = createBoundedArtifactStorage(rawFilesystem(raw), signal());
    const handle = await guard.filesystem.open("/fixture/file");
    await expectFailure(handle[name](), "storage_failed");
    await expectFailure(guard.filesystem.mkdir("/fixture/later"), "storage_failed");
    await expect(guard.settle()).resolves.toBe(name !== "close");
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("redacts synchronous filesystem and handle failures", async () => {
    const source = rawFilesystem();
    source.realpath.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    const first = createBoundedArtifactStorage(source, signal());
    await expectFailure(first.filesystem.realpath("/fixture"), "storage_failed");
    await expect(first.settle()).resolves.toBe(true);
    const raw = rawHandle();
    raw.close.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    const second = createBoundedArtifactStorage(rawFilesystem(raw), signal());
    const handle = await second.filesystem.open("/fixture/file");
    await expectFailure(handle.close(), "storage_failed");
    await expect(second.settle()).resolves.toBe(false);
  });

  it("cancellation promptly rejects every pending call and starts no later mutation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const first = deferred();
    const second = deferred();
    const source = rawFilesystem();
    source.realpath.mockImplementation(() => first.promise as never);
    source.mkdir.mockImplementation(() => second.promise as never);
    const guard = createBoundedArtifactStorage(source, controller.signal);
    const one = expectFailure(guard.filesystem.realpath("/fixture"), "storage_cancelled");
    const two = expectFailure(guard.filesystem.mkdir("/fixture/new"), "storage_cancelled");
    controller.abort(new Error(PRIVATE));
    await Promise.all([one, two]);
    await expectFailure(guard.filesystem.open("/fixture/later"), "storage_cancelled");
    expect(source.open).not.toHaveBeenCalled();
    const settle = guard.settle();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(settle).resolves.toBe(false);
    first.reject(new Error(PRIVATE));
    second.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    await expect(guard.settle()).resolves.toBe(false);
  });

  it("does not close a file while its cancelled write is still pending", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = deferred();
    const raw = rawHandle();
    raw.write.mockImplementation(() => pending.promise as never);
    const source = rawFilesystem(raw);
    const guard = createBoundedArtifactStorage(source, controller.signal);
    const handle = await guard.filesystem.open("/fixture/file");
    const write = expectFailure(handle.write(Buffer.from("abc")), "storage_cancelled");
    controller.abort();
    await write;
    expect(raw.close).not.toHaveBeenCalled();
    const settled = guard.settle();
    await vi.advanceTimersByTimeAsync(4999);
    expect(raw.close).not.toHaveBeenCalled();
    pending.resolve({ bytesWritten: 3 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(settled).resolves.toBe(true);
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expectFailure(handle.read(Buffer.alloc(1)), "storage_cancelled");
    expect(raw.read).not.toHaveBeenCalled();
  });

  it("waits for all operations on one handle before closing it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = deferred();
    const write = deferred();
    const raw = rawHandle();
    raw.read.mockImplementation(() => read.promise as never);
    raw.write.mockImplementation(() => write.promise as never);
    const guard = createBoundedArtifactStorage(rawFilesystem(raw), controller.signal);
    const handle = await guard.filesystem.open("/fixture/file");
    const checks = [
      expectFailure(handle.read(), "storage_cancelled"),
      expectFailure(handle.write(), "storage_cancelled"),
    ];
    controller.abort();
    await Promise.all(checks);
    read.resolve({ bytesRead: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.close).not.toHaveBeenCalled();
    write.resolve({ bytesWritten: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expect(guard.settle()).resolves.toBe(true);
  });

  it("queues explicit close behind pending I/O, rejects later I/O and closes once", async () => {
    const pending = deferred();
    const raw = rawHandle();
    raw.write.mockImplementation(() => pending.promise as never);
    const guard = createBoundedArtifactStorage(rawFilesystem(raw), signal());
    const handle = await guard.filesystem.open("/fixture/file");
    const writing = handle.write();
    const closed = handle.close();
    expect(handle.close()).toBe(closed);
    expect(raw.close).not.toHaveBeenCalled();
    await expectFailure(handle.read(), "storage_closed");
    pending.resolve({ bytesWritten: 3 });
    await writing;
    await closed;
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expect(guard.settle()).resolves.toBe(true);
  });

  it("bounds explicit close queued behind an indefinitely pending write", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const raw = rawHandle();
    raw.write.mockImplementation(() => pending.promise as never);
    const guard = createBoundedArtifactStorage(rawFilesystem(raw), signal());
    const handle = await guard.filesystem.open("/fixture/file");
    const writing = expectFailure(handle.write(), "storage_timeout");
    const closed = expectFailure(handle.close(), "storage_timeout");
    await vi.advanceTimersByTimeAsync(30000);
    await Promise.all([writing, closed]);
    expect(raw.close).not.toHaveBeenCalled();
    const settled = guard.settle();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(settled).resolves.toBe(false);
    pending.resolve({ bytesWritten: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("settlement is terminal even when an unfinished open resolves within its grace period", async () => {
    const pending = deferred();
    const raw = rawHandle();
    const source = rawFilesystem(raw);
    source.open.mockImplementation(() => pending.promise as never);
    const guard = createBoundedArtifactStorage(source, signal());
    const opened = expectFailure(guard.filesystem.open("/fixture/file"), "storage_closed");
    const settled = guard.settle();
    await opened;
    pending.resolve(raw);
    await expect(settled).resolves.toBe(true);
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expectFailure(guard.filesystem.open("/fixture/next"), "storage_closed");
    expect(source.open).toHaveBeenCalledTimes(1);
  });

  it("records late-open close failure without unhandled diagnostics or upgrading settlement", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = deferred();
    const raw = rawHandle();
    raw.close.mockRejectedValue(new Error(PRIVATE));
    const source = rawFilesystem(raw);
    source.open.mockImplementation(() => pending.promise as never);
    const guard = createBoundedArtifactStorage(source, controller.signal);
    const opening = expectFailure(guard.filesystem.open("/fixture/file"), "storage_cancelled");
    controller.abort();
    await opening;
    const settled = guard.settle();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(settled).resolves.toBe(false);
    pending.resolve(raw);
    await vi.advanceTimersByTimeAsync(0);
    expect(raw.close).toHaveBeenCalledTimes(1);
    await expect(guard.settle()).resolves.toBe(false);
  });

  it("does not cancel or duplicate an already-started close on global cancellation", async () => {
    const pending = deferred();
    const controller = new AbortController();
    const raw = rawHandle();
    raw.close.mockImplementation(() => pending.promise as never);
    const guard = createBoundedArtifactStorage(rawFilesystem(raw), controller.signal);
    const handle = await guard.filesystem.open("/fixture/file");
    const closing = handle.close();
    controller.abort();
    const settled = guard.settle();
    pending.resolve(undefined);
    await closing;
    await expect(settled).resolves.toBe(true);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, {}, { close: 1 }])(
    "fails closed for malformed opened handle %s",
    async (value) => {
      const source = rawFilesystem();
      source.open.mockResolvedValue(value as never);
      const guard = createBoundedArtifactStorage(source, signal());
      await expectFailure(guard.filesystem.open("/fixture/file"), "storage_failed");
      await expect(guard.settle()).resolves.toBe(false);
    },
  );

  it("does not allow changing the underlying method after guard construction", async () => {
    const source = rawFilesystem();
    const original = source.mkdir;
    const guard = createBoundedArtifactStorage(source, signal());
    source.mkdir = vi.fn(async () => {
      throw new Error(PRIVATE);
    });
    await guard.filesystem.mkdir("/fixture/new", { mode: 0o700 });
    expect(original).toHaveBeenCalledTimes(1);
    expect(source.mkdir).not.toHaveBeenCalled();
    await expect(guard.settle()).resolves.toBe(true);
  });
});
