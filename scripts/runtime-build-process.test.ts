import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeBuildRunner } from "./runtime-build-process.mjs";

afterEach(() => vi.useRealTimers());

function fixture(options: { alive?: boolean; pid?: number; closeOnKill?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: options.pid ?? 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let alive = options.alive ?? false;
  const kill = vi.fn((_pid: number, signal: string | number) => {
    if (signal === "SIGKILL" && options.closeOnKill) {
      alive = false;
      child.emit("close", null, "SIGKILL");
      return true;
    }
    if (!alive)
      throw Object.assign(new Error("synthetic secret never reported"), { code: "ESRCH" });
    return true;
  });
  const launch = vi.fn((_file: string, _args: string[], _options: unknown) => child);
  const runner = createRuntimeBuildRunner({
    spawn: launch,
    kill,
    platform: "linux",
    now: () => Date.now(),
    delay: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  const run = () =>
    runner("fixed-own-builder", ["fixed-argument"], {
      cwd: "/fixture",
      env: { PATH: "/trusted" },
      signal: new AbortController().signal,
    });
  return { child, kill, launch, runner, run };
}

describe("bounded owned Linux build processes", () => {
  it("returns bounded stdout only after both parent and group disappear", async () => {
    const f = fixture();
    const pending = f.run();
    f.child.stdout.write("build-result");
    f.child.stderr.write("discard this synthetic diagnostic");
    f.child.emit("close", 0, null);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.stdout?.toString()).toBe("build-result");
    expect(f.launch.mock.calls[0]?.[0]).toBe("fixed-own-builder");
    expect(f.launch).toHaveBeenCalledWith(
      "fixed-own-builder",
      ["fixed-argument"],
      expect.objectContaining({ shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });
  it.each([1, null])("rejects unsuccessful parent code %s", async (code) => {
    const f = fixture();
    const pending = f.run();
    f.child.emit("close", code, null);
    expect(await pending).toEqual({ status: "failed", reason: "process_failed" });
  });
  it("rejects a successful parent that leaves an owned descendant", async () => {
    vi.useFakeTimers();
    const f = fixture({ alive: true, closeOnKill: true });
    const pending = f.run();
    f.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await pending).toEqual({ status: "failed", reason: "process_failed" });
    expect(f.kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  });
  it("never turns an unclosed group into success", async () => {
    vi.useFakeTimers();
    const f = fixture({ alive: true });
    const pending = f.run();
    f.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await pending).toEqual({ status: "failed", reason: "closure_unconfirmed" });
  });
  it("times out, kills the group and confirms closure before returning", async () => {
    vi.useFakeTimers();
    const f = fixture({ alive: true, closeOnKill: true });
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(30_100);
    expect(await pending).toEqual({ status: "failed", reason: "process_timeout" });
  });
  it("cancels without starting another operation", async () => {
    const f = fixture({ alive: true, closeOnKill: true });
    const controller = new AbortController();
    const pending = f.runner("fixed", [], { cwd: "/fixture", env: {}, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: "failed", reason: "cancelled" });
  });
  it.each(["stdout", "stderr"] as const)(
    "bounds combined %s output without disclosure",
    async (stream) => {
      const f = fixture({ alive: true, closeOnKill: true });
      const pending = f.run();
      f.child[stream].write(Buffer.alloc(1_048_577, 65));
      expect(await pending).toEqual({ status: "failed", reason: "process_output_limit" });
    },
  );
  it.each(["stdout", "stderr"] as const)("contains %s stream failures", async (stream) => {
    const f = fixture({ alive: true, closeOnKill: true });
    const pending = f.run();
    f.child[stream].emit("error", new Error("synthetic private path"));
    expect(await pending).toEqual({ status: "failed", reason: "process_failed" });
  });
  it("contains process start errors without a valid PID", async () => {
    const f = fixture({ pid: 0 });
    const pending = f.run();
    f.child.emit("error", new Error("synthetic"));
    f.child.emit("close", -2, null);
    expect(await pending).toEqual({ status: "failed", reason: "process_failed" });
  });
  it("does not interpret EPERM as absence", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.kill.mockImplementation(() => {
      throw Object.assign(new Error("synthetic"), { code: "EPERM" });
    });
    const pending = f.run();
    f.child.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await pending).toEqual({ status: "failed", reason: "closure_unconfirmed" });
  });
  it("contains a throwing launcher", async () => {
    const run = createRuntimeBuildRunner({
      platform: "linux",
      spawn: () => {
        throw new Error("synthetic credential");
      },
    });
    expect(await run("fixed", [], { cwd: "/fixture", env: {} })).toEqual({
      status: "failed",
      reason: "closure_unconfirmed",
    });
  });
  it("refuses non-Linux execution", async () => {
    const launch = vi.fn();
    const run = createRuntimeBuildRunner({ platform: "win32", spawn: launch });
    expect(await run("fixed", [], { cwd: "/fixture", env: {} })).toEqual({
      status: "failed",
      reason: "unsupported_host",
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it("refuses an already cancelled process", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.runner("fixed", [], { cwd: "/fixture", env: {}, signal: controller.signal }),
    ).toEqual({ status: "failed", reason: "cancelled" });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
