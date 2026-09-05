import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureCleanupFence } from "../packages/cli/test/fixture-cleanup-fence.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import {
  createArtifactPreparer,
  executeFixedGpg,
  runArtifactPreparationCommand,
} from "./prepare-claude-host-artifact.mjs";

const roots: string[] = [];
const fence = createFixtureCleanupFence();
beforeEach(({ signal }) => fence.begin(signal));
afterEach(async () => {
  vi.useRealTimers();
  spawn.mockReset();
  vi.restoreAllMocks();
  await fence.cleanup(roots, async (root) => await fs.rm(root, { recursive: true, force: true }));
});

function hash(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "agenthawk-artifact-preparation-"));
  roots.push(root);
  const output = join(root, "prepared");
  const data: Record<string, Buffer> = {
    "claude-code.asc": Buffer.from("synthetic public key fixture"),
    "manifest.json": Buffer.from("synthetic manifest fixture"),
    "manifest.json.sig": Buffer.from("synthetic signature fixture"),
    "public-key.gpg": Buffer.from("synthetic dearmored fixture"),
    claude: Buffer.from("inert binary fixture: never executable"),
  };
  const item = (file: string) => ({
    file,
    size: data[file].length,
    sha256: hash(data[file]),
    url: `https://downloads.claude.ai/fixture/${file}`,
  });
  const policy = {
    version: "fixture-only",
    platform: "linux-x64",
    signingFingerprint: "fixture-only",
    key: item("claude-code.asc"),
    manifest: item("manifest.json"),
    signature: item("manifest.json.sig"),
    dearmoredKey: item("public-key.gpg"),
    binary: item("claude"),
  };
  const modes = new Map<string, bigint>();
  const opened: { path: string; closed: boolean }[] = [];
  let mutateStat = (_path: string, value: Record<string, unknown>) => value;
  let onWrite = async (_path: string) => {};
  let onSync = async (_path: string) => {};
  let onClose = async (_path: string) => {};
  let onRead = async (_path: string) => {};
  const wrapStat = (path: string, status: Awaited<ReturnType<typeof fs.lstat>>) => {
    // Explicit test seam: exercise Linux ownership rules using real temporary
    // files on all CI hosts. This is not evidence of Windows ACL isolation.
    const adjusted = {
      ...status,
      uid: 10001n,
      mode: modes.get(path) ?? 0o755n,
      isDirectory: () => status.isDirectory(),
      isFile: () => status.isFile(),
      isSymbolicLink: () => status.isSymbolicLink(),
    };
    return mutateStat(path, adjusted);
  };
  const io = {
    realpath: fs.realpath as (path: string) => Promise<string>,
    lstat: async (path: string) => {
      if (path === "/usr/bin/gpg")
        return { isFile: () => true, isSymbolicLink: () => false, uid: 0n, mode: 0o100755n };
      return wrapStat(path, await fs.lstat(path, { bigint: true }));
    },
    mkdir: async (path: string, options: { mode: number }) => {
      await fs.mkdir(path, options);
      modes.set(path, BigInt(options.mode));
    },
    open: async (path: string, flags: number, mode?: number) => {
      const handle = await fs.open(path, flags, mode);
      if (mode !== undefined) modes.set(path, BigInt(mode));
      const observed = { path, closed: false };
      opened.push(observed);
      return {
        stat: async () => wrapStat(path, await handle.stat({ bigint: true })),
        read: async (...args: Parameters<typeof handle.read>) => {
          await onRead(path);
          return await handle.read(...args);
        },
        write: async (...args: Parameters<typeof handle.write>) => {
          await onWrite(path);
          return await handle.write(...args);
        },
        sync: async () => {
          await onSync(path);
          await handle.sync();
        },
        close: async () => {
          await handle.close();
          observed.closed = true;
          await onClose(path);
        },
      };
    },
  };
  const download = vi.fn(
    async (artifact: { file: string }, sink: (chunk: Buffer) => Promise<void>) => {
      await sink(data[artifact.file]);
    },
  );
  const runGpg = vi.fn(async (_root: string, operation: string, _signal?: AbortSignal) => ({
    code: 0,
    stdout:
      operation === "dearmor" ? data["public-key.gpg"] : Buffer.from("synthetic verified status"),
  }));
  const verifyManifest = vi.fn((bytes: Buffer) => bytes.equals(data["manifest.json"]));
  const verifySignature = vi.fn(
    (bytes: Buffer, code: number) =>
      code === 0 && bytes.equals(Buffer.from("synthetic verified status")),
  );
  const dependencies = {
    filesystem: io,
    policy,
    download,
    runGpg,
    verifyManifest,
    verifySignature,
    clock: () => 1_800_000_000_000,
    platform: "linux",
    getUid: () => 10001,
  };
  return {
    root,
    output,
    data,
    policy,
    modes,
    opened,
    io,
    download,
    runGpg,
    verifyManifest,
    verifySignature,
    dependencies,
    prepare: (signal?: AbortSignal) => createArtifactPreparer(dependencies)(output, signal),
    setStat: (next: typeof mutateStat) => {
      mutateStat = next;
    },
    setWrite: (next: typeof onWrite) => {
      onWrite = next;
    },
    setSync: (next: typeof onSync) => {
      onSync = next;
    },
    setClose: (next: typeof onClose) => {
      onClose = next;
    },
    setRead: (next: typeof onRead) => {
      onRead = next;
    },
  };
}

describe("fixed artifact preparation orchestration with synthetic evidence", {
  concurrent: false,
  timeout: 10_000,
}, () => {
  it("authenticates metadata before binary acquisition, verifies stored bytes and returns only a closed receipt", async () => {
    const f = await fixture();
    f.download.mockImplementation(async (artifact, sink) => {
      if (artifact.file === "claude") expect(f.verifySignature).toHaveBeenCalledOnce();
      await sink(f.data[artifact.file]);
    });
    const result = await f.prepare();
    expect(result).toEqual({
      schemaVersion: "1",
      status: "prepared",
      artifact: {
        file: "claude",
        version: "fixture-only",
        platform: "linux-x64",
        size: f.policy.binary.size,
        sha256: f.policy.binary.sha256,
      },
      manifestSha256: f.policy.manifest.sha256,
      signingFingerprint: "fixture-only",
      executed: false,
      nativeSupport: false,
    });
    expect(JSON.parse(await fs.readFile(join(f.output, "preparation.json"), "utf8"))).toEqual(
      result,
    );
    expect(await fs.readFile(join(f.output, "claude"))).toEqual(f.data.claude);
    expect(f.download.mock.calls.map(([artifact]) => artifact.file)).toEqual([
      "claude-code.asc",
      "manifest.json",
      "manifest.json.sig",
      "claude",
    ]);
    expect(f.runGpg.mock.calls.map(([, operation]) => operation)).toEqual(["dearmor", "verify"]);
    expect(f.opened.every(({ closed }) => closed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.root);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses an existing destination without adopting or modifying it", async () => {
    const f = await fixture();
    await fs.mkdir(f.output);
    await fs.writeFile(join(f.output, "owner.txt"), "owner content");
    expect(await f.prepare()).toMatchObject({
      status: "failed",
      reason: "destination_unavailable",
      retainedState: "present_or_uncertain",
    });
    expect(await fs.readFile(join(f.output, "owner.txt"), "utf8")).toBe("owner content");
    expect(f.download).not.toHaveBeenCalled();
  });

  it.each(["win32", "darwin"])(
    "rejects unsupported %s before file creation or acquisition",
    async (platform) => {
      const f = await fixture();
      f.dependencies.platform = platform;
      expect(await f.prepare()).toMatchObject({
        status: "failed",
        reason: "unsupported_host",
        retainedState: "not_created",
      });
      expect(f.download).not.toHaveBeenCalled();
      expect(await fs.readdir(f.root)).toEqual([]);
    },
  );

  it.each([undefined, "", "relative", "/", "private\npath", "x".repeat(4097)])(
    "rejects malformed destinations",
    async (path) => {
      const f = await fixture();
      expect(await createArtifactPreparer(f.dependencies)(path)).toMatchObject({
        status: "failed",
        retainedState: "not_created",
      });
      expect(f.download).not.toHaveBeenCalled();
    },
  );

  it.each(["writable", "foreign", "link"])("rejects a %s staging parent", async (kind) => {
    const f = await fixture();
    f.setStat((path, value) =>
      path !== f.root
        ? value
        : {
            ...value,
            ...(kind === "writable"
              ? { mode: 0o777n }
              : kind === "foreign"
                ? { uid: 20002n }
                : { isSymbolicLink: () => true }),
          },
    );
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "invalid_destination" });
    expect(f.download).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical parent", async () => {
    const f = await fixture();
    f.io.realpath = vi.fn(async () => "a different parent");
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "invalid_destination" });
  });

  it.each(["manifest", "signature"])(
    "does not request binary after rejected %s evidence",
    async (kind) => {
      const f = await fixture();
      if (kind === "manifest") f.verifyManifest.mockReturnValue(false);
      else f.verifySignature.mockReturnValue(false);
      expect(await f.prepare()).toMatchObject({
        status: "failed",
        reason: `${kind}_invalid`,
        retainedState: "present_or_uncertain",
      });
      expect(f.download.mock.calls.some(([artifact]) => artifact.file === "claude")).toBe(false);
      expect(f.opened.every(({ closed }) => closed)).toBe(true);
    },
  );

  it.each(["short", "long", "changed", "empty"])(
    "rejects a %s artifact without receipt or execution",
    async (kind) => {
      const f = await fixture();
      f.download.mockImplementation(async (artifact, sink) => {
        const original = f.data[artifact.file];
        if (artifact.file !== "claude") return await sink(original);
        if (kind === "empty") return;
        const bytes =
          kind === "short"
            ? original.subarray(1)
            : kind === "long"
              ? Buffer.concat([original, Buffer.from("!")])
              : Buffer.alloc(original.length, 1);
        await sink(bytes);
      });
      expect(await f.prepare()).toMatchObject({ status: "failed", reason: "artifact_mismatch" });
      expect((await fs.readdir(f.output)).includes("preparation.json")).toBe(false);
      expect(f.opened.every(({ closed }) => closed)).toBe(true);
    },
  );

  it.each(["write", "sync", "read", "close"])(
    "handles %s failure with redaction and retained state",
    async (operation) => {
      const f = await fixture();
      const reject = async () => {
        throw new Error("private diagnostic credential sentinel");
      };
      if (operation === "write") f.setWrite(reject);
      else if (operation === "sync") f.setSync(reject);
      else if (operation === "read") f.setRead(reject);
      else f.setClose(reject);
      const result = await f.prepare();
      expect(result).toMatchObject({
        status: "failed",
        retainedState: "present_or_uncertain",
        executed: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/private|sentinel|diagnostic/);
      expect(f.opened.every(({ closed }) => closed)).toBe(true);
    },
  );

  it("detects mutation of stored metadata during verifier work before binary GET", async () => {
    const f = await fixture();
    f.runGpg.mockImplementation(async (_root, operation) => {
      if (operation === "verify")
        await fs.writeFile(
          join(f.output, "manifest.json"),
          Buffer.alloc(f.policy.manifest.size, 0),
        );
      return {
        code: 0,
        stdout:
          operation === "dearmor"
            ? f.data["public-key.gpg"]
            : Buffer.from("synthetic verified status"),
      };
    });
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "artifact_mismatch" });
    expect(f.download.mock.calls.some(([artifact]) => artifact.file === "claude")).toBe(false);
  });

  it.each(["mode", "owner", "links", "identity"])("detects stored-file %s drift", async (kind) => {
    const f = await fixture();
    let changed = false;
    f.setStat((path, value) => {
      if (!changed || path !== join(f.output, "claude-code.asc")) return value;
      return {
        ...value,
        ...(kind === "mode"
          ? { mode: 0o644n }
          : kind === "owner"
            ? { uid: 20002n }
            : kind === "links"
              ? { nlink: 2n }
              : { ino: 999999999n }),
      };
    });
    f.runGpg.mockImplementation(async (_root, operation) => {
      changed = true;
      return {
        code: 0,
        stdout:
          operation === "dearmor"
            ? f.data["public-key.gpg"]
            : Buffer.from("synthetic verified status"),
      };
    });
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "ownership_changed" });
  });

  it("does not claim success when receipt creation fails", async () => {
    const f = await fixture();
    f.setWrite(async (path) => {
      if (path.endsWith("preparation.json")) throw new Error("private receipt failure");
    });
    const result = await f.prepare();
    expect(result).toMatchObject({ status: "failed", retainedState: "present_or_uncertain" });
    expect(await fs.readFile(join(f.output, "claude"))).toEqual(f.data.claude);
    expect((await fs.stat(join(f.output, "preparation.json"))).size).toBe(0);
  });

  it("rejects pre-cancellation without side effects", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.prepare(controller.signal)).toMatchObject({
      status: "failed",
      reason: "cancelled",
      retainedState: "not_created",
    });
    expect(f.download).not.toHaveBeenCalled();
  });

  it("closes the writer after cancellation during an awaited write", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.setWrite(async () => {
      controller.abort();
    });
    expect(await f.prepare(controller.signal)).toMatchObject({
      status: "failed",
      reason: "cancelled",
      retainedState: "present_or_uncertain",
    });
    expect(f.opened.every(({ closed }) => closed)).toBe(true);
    expect(f.runGpg).not.toHaveBeenCalled();
  });

  it("redacts a transport error and never invokes verifier", async () => {
    const f = await fixture();
    f.download.mockRejectedValue(new Error("private URL and credentials"));
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "download_failed" });
    expect(f.runGpg).not.toHaveBeenCalled();
  });

  it("reports uncertain creation even when mkdir creates and then rejects", async () => {
    const f = await fixture();
    const mkdir = f.io.mkdir;
    f.io.mkdir = async (path, options) => {
      await mkdir(path, options);
      throw new Error("private creation outcome");
    };
    expect(await f.prepare()).toMatchObject({
      status: "failed",
      reason: "destination_unavailable",
      retainedState: "present_or_uncertain",
    });
    expect((await fs.stat(f.output)).isDirectory()).toBe(true);
    expect(f.download).not.toHaveBeenCalled();
  });

  it("bounds stalled preflight without claiming syscall cancellation or creating files", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let complete!: (path: string) => void;
    f.io.realpath = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = f.prepare();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await pending).toMatchObject({
      status: "failed",
      reason: "closure_unconfirmed",
      retainedState: "not_created",
    });
    complete(f.root);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.download).not.toHaveBeenCalled();
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  it("retains uncertain state and withholds closure until a stalled write actually settles", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let finishWrite!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.setWrite(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finishWrite = resolve;
      });
    });
    vi.useFakeTimers();
    const pending = f.prepare(controller.signal);
    await started;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({
      status: "failed",
      reason: "closure_unconfirmed",
      retainedState: "present_or_uncertain",
    });
    expect(f.opened[0].closed).toBe(false);
    // The original syscall can still write later. Explicitly await its close
    // before the test cleanup fence permits fixture deletion.
    let closed!: () => void;
    const closure = new Promise<void>((resolve) => {
      closed = resolve;
    });
    f.setClose(async () => {
      closed();
    });
    finishWrite();
    await closure;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.opened.every(({ closed: complete }) => complete)).toBe(true);
    expect(f.runGpg).not.toHaveBeenCalled();
    expect((await fs.readdir(f.output)).includes("preparation.json")).toBe(false);
  });

  it("rejects malformed cancellation input without mutation", async () => {
    const f = await fixture();
    expect(await f.prepare({} as AbortSignal)).toMatchObject({
      status: "failed",
      reason: "invalid_destination",
      retainedState: "not_created",
    });
    expect(f.download).not.toHaveBeenCalled();
  });

  it("aborts the aggregate operation deadline and cannot promote late verifier output", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.runGpg.mockImplementation(async (_root, _operation, signal) => {
      entered();
      return await new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => resolve({ code: 0, stdout: f.data["public-key.gpg"] }),
          { once: true },
        );
      });
    });
    const pending = f.prepare();
    await started;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await pending).toMatchObject({
      status: "failed",
      reason: "deadline_exceeded",
      retainedState: "present_or_uncertain",
    });
    expect(f.verifySignature).not.toHaveBeenCalled();
    expect(f.download.mock.calls.some(([artifact]) => artifact.file === "claude")).toBe(false);
    expect(f.opened.every(({ closed }) => closed)).toBe(true);
  });

  it.each(["link", "foreign", "writable", "not executable"])(
    "rejects %s GPG binary metadata",
    async (kind) => {
      const f = await fixture();
      const lstat = f.io.lstat;
      f.io.lstat = async (path) => {
        const value = await lstat(path);
        if (path !== "/usr/bin/gpg") return value;
        return {
          ...value,
          ...(kind === "link"
            ? { isSymbolicLink: () => true }
            : kind === "foreign"
              ? { uid: 10001n }
              : { mode: kind === "writable" ? 0o777n : 0o644n }),
        };
      };
      expect(await f.prepare()).toMatchObject({
        status: "failed",
        reason: "verifier_failed",
        retainedState: "not_created",
      });
      expect(f.download).not.toHaveBeenCalled();
    },
  );

  it("does not request binary when dearmor exits nonzero", async () => {
    const f = await fixture();
    f.runGpg.mockResolvedValue({ code: 1, stdout: Buffer.from("private diagnostics") });
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "verifier_failed" });
    expect(f.verifySignature).not.toHaveBeenCalled();
    expect(f.download.mock.calls.some(([artifact]) => artifact.file === "claude")).toBe(false);
  });

  it("preserves uncertain network closure as failure", async () => {
    const f = await fixture();
    f.download.mockRejectedValue(new Error("download_cleanup_unconfirmed"));
    expect(await f.prepare()).toMatchObject({ status: "failed", reason: "closure_unconfirmed" });
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit("close", null, "SIGKILL"));
    return true;
  });
  spawn.mockReturnValue(child);
  return child;
}

describe("fixed GPG process boundary", { concurrent: false }, () => {
  it.each(["dearmor", "verify"])(
    "uses only trusted GPG and minimal environment for %s",
    async (operation) => {
      const child = fakeChild();
      const controller = new AbortController();
      const pending = executeFixedGpg("/fixture", operation, controller.signal);
      const [file, args, options] = spawn.mock.calls[0];
      expect(file).toBe("/usr/bin/gpg");
      expect(args).toContain("--no-options");
      expect(args).toContain("--no-default-keyring");
      expect(args).toContain("--no-autostart");
      expect(args).toContain("--disable-dirmngr");
      expect(options.shell).toBe(false);
      expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
      expect(Object.keys(options.env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]);
      child.stdout.write("fixture output");
      child.stderr.write("discarded private stderr");
      child.emit("close", 0, null);
      expect(await pending).toEqual({ code: 0, stdout: Buffer.from("fixture output") });
      expect(child.kill).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown operations and pre-cancellation without spawn", async () => {
    const controller = new AbortController();
    await expect(executeFixedGpg("/fixture", "install", controller.signal)).rejects.toThrow(
      "verifier_failed",
    );
    controller.abort();
    await expect(executeFixedGpg("/fixture", "verify", controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["abort", "overflow", "error", "stdout error", "stderr error", "timeout"])(
    "kills and waits for confirmed closure after %s",
    async (kind) => {
      vi.useFakeTimers();
      const child = fakeChild();
      const controller = new AbortController();
      const pending = executeFixedGpg("/fixture", "verify", controller.signal);
      const rejected = expect(pending).rejects.toThrow(
        kind === "abort" ? "cancelled" : "verifier_failed",
      );
      if (kind === "abort") controller.abort();
      else if (kind === "overflow") child.stdout.write(Buffer.alloc(65_537));
      else if (kind === "error") child.emit("error", new Error("private child failure"));
      else if (kind === "stdout error")
        child.stdout.emit("error", new Error("private stdout error"));
      else if (kind === "stderr error")
        child.stderr.emit("error", new Error("private stderr error"));
      else await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("reports unconfirmed closure rather than treating a kill request as success", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementation(() => true);
    const controller = new AbortController();
    const pending = executeFixedGpg("/fixture", "verify", controller.signal);
    const rejected = expect(pending).rejects.toThrow("closure_unconfirmed");
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    child.emit("close", null, "SIGKILL");
  });

  it("redacts synchronous spawn failure", async () => {
    spawn.mockImplementation(() => {
      throw new Error("private spawn detail");
    });
    await expect(
      executeFixedGpg("/fixture", "verify", new AbortController().signal),
    ).rejects.toThrow("verifier_failed");
  });

  it.each([null, 0.5, "0"])("rejects invalid exit status %s", async (code) => {
    const child = fakeChild();
    const pending = executeFixedGpg("/fixture", "verify", new AbortController().signal);
    child.emit("close", code, null);
    await expect(pending).rejects.toThrow("verifier_failed");
  });

  it("keeps a throwing kill request failed until bounded unconfirmed closure", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementation(() => {
      throw new Error("private kill error");
    });
    const controller = new AbortController();
    const pending = executeFixedGpg("/fixture", "verify", controller.signal);
    const rejected = expect(pending).rejects.toThrow("closure_unconfirmed");
    controller.abort();
    child.stdout.emit("error", new Error("late private pipe error"));
    child.stdout.write("late non-authoritative output");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });
});

describe("preparation command contract", { concurrent: false }, () => {
  it("prints fixed help without spawning or acquiring an artifact", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runArtifactPreparationCommand(["--help"]);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Does not execute Claude"));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects override-like arguments, emits closed JSON, and removes signal handlers", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = process.exitCode;
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    try {
      await runArtifactPreparationCommand(["--url", "https://private.invalid/credential"]);
      const result = JSON.parse(String(output.mock.calls[0][0]));
      expect(result).toMatchObject({
        status: "failed",
        retainedState: "not_created",
        executed: false,
        nativeSupport: false,
      });
      expect(JSON.stringify(result)).not.toMatch(/private|credential/);
      expect(process.exitCode).toBe(1);
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      process.exitCode = code;
    }
  });

  it("handles a command cancellation through its registered signal boundary", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = process.exitCode;
    try {
      const pending = runArtifactPreparationCommand([]);
      process.emit("SIGINT");
      await pending;
      expect(JSON.parse(String(output.mock.calls[0][0]))).toMatchObject({
        status: "failed",
        reason: "cancelled",
        retainedState: "not_created",
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      process.exitCode = code;
    }
  });
});
