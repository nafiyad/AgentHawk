import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixtureRuntimeRelocator,
  runRuntimeRelocationCommand,
} from "./relocate-fixture-runtime.mjs";

const PRIVATE = "private-repository-and-credential-detail";
const FLAGS = { executed: false, portableRuntime: false, nativeSupport: false };
type Outcome = { status: string; reason?: string; retainedState?: string };
type Inspection = {
  status: string;
  reason?: string;
  parentIdentity?: { dev: bigint; ino: bigint };
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  const destination = resolve("fixture-relocated");
  const prepared = { status: "assembled" };
  const plan = Object.freeze({ fixture: true });
  const snapshots = Array.from({ length: 4 }, (_, id) => Object.freeze({ id, status: "measured" }));
  const digest = "a".repeat(64);
  const description = {
    schemaVersion: 1,
    sourceBinding: "caller_observation_only",
    source: {
      commit: "b".repeat(40),
      tree: "c".repeat(40),
      lockfileSha256: "d".repeat(64),
      nodeVersion: "v24.20.0",
      pnpmVersion: "10.34.5",
      typescriptVersion: "7.0.2",
    },
    packages: [],
    fileCount: 6,
    fileBytes: 60,
    plannedTreeSha256: digest,
    ...FLAGS,
  };
  const inspected = { status: "available", parentIdentity: { dev: 1n, ino: 2n } };
  const inspect = vi.fn(async (_input: unknown): Promise<Inspection> => inspected);
  const prepare = vi.fn(
    async (_destination: string, _signal?: AbortSignal): Promise<Outcome> => prepared,
  );
  const planFor = vi.fn((value: unknown) => (value === prepared ? plan : undefined));
  const describePlan = vi.fn((value: unknown) => (value === plan ? description : undefined));
  let index = 0;
  const read = vi.fn(async (_input: unknown): Promise<Outcome> => snapshots[index++]);
  const descriptionFor = { sourceTreeSha256: digest, fileCount: 6, fileBytes: 60, ...FLAGS };
  const describeSnapshot = vi.fn((value: unknown): Record<string, unknown> | undefined =>
    snapshots.includes(value as (typeof snapshots)[number]) ? descriptionFor : undefined,
  );
  const matches = vi.fn(() => true);
  const disjoint = vi.fn(() => true);
  const write = vi.fn(async (_input: unknown): Promise<Outcome> => ({ status: "assembled" }));
  const overrides = {
    platform: "linux",
    inspect,
    prepare,
    planFor,
    describePlan,
    read,
    describe: describeSnapshot,
    matches,
    disjoint,
    write,
  };
  return {
    destination,
    prepared,
    plan,
    snapshots,
    digest,
    description,
    inspected,
    inspect,
    prepare,
    planFor,
    describePlan,
    read,
    describeSnapshot,
    matches,
    disjoint,
    write,
    overrides,
    run: (signal?: AbortSignal) => createFixtureRuntimeRelocator(overrides)(destination, signal),
  };
}
function rejected(result: unknown, reason: string, retained = true) {
  expect(result).toEqual({
    schemaVersion: 1,
    status: "failed",
    reason,
    retainedState: retained ? "present_or_uncertain" : "not_created",
    ...FLAGS,
  });
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}

describe("non-executing fresh runtime relocation orchestration", () => {
  it("preflights all fresh siblings then rereads, copies and fences both actual trees", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toEqual({
      ...f.description,
      sourceBinding: "observed_fresh_build",
      status: "relocated",
      sourceTreeSha256: f.digest,
      destinationTreeSha256: f.digest,
    });
    expect(
      f.inspect.mock.calls.map(([input]) => (input as { destination: string }).destination),
    ).toEqual([f.destination, `${f.destination}.source`, `${f.destination}.source.build`]);
    expect(f.prepare).toHaveBeenCalledWith(`${f.destination}.source`, expect.any(AbortSignal));
    expect(f.planFor).toHaveBeenCalledWith(f.prepared);
    expect(f.write).toHaveBeenCalledWith({
      destination: f.destination,
      plan: f.plan,
      sourceSnapshot: f.snapshots[0],
      signal: expect.any(AbortSignal),
    });
    expect(f.read.mock.calls.map(([input]) => (input as { source: string }).source)).toEqual([
      `${f.destination}.source`,
      f.destination,
      `${f.destination}.source`,
      f.destination,
    ]);
    expect(f.matches.mock.calls).toEqual([
      [f.snapshots[0], f.snapshots[2]],
      [f.snapshots[1], f.snapshots[3]],
    ]);
    expect(f.disjoint).toHaveBeenCalledWith(f.snapshots[2], f.snapshots[3]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(f.destination);
  });

  it.each(["win32", "darwin", "other"])("rejects %s without preparation", async (platform) => {
    const f = fixture();
    rejected(
      await createFixtureRuntimeRelocator({ ...f.overrides, platform })(f.destination),
      "unsupported_host",
      false,
    );
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each(["", ".", "relative", "/a\nline", "/a\u007fline", "x".repeat(4001), null, 42])(
    "rejects malformed destination %s before I/O",
    async (destination) => {
      const f = fixture();
      rejected(
        await createFixtureRuntimeRelocator(f.overrides)(destination),
        "invalid_destination",
        false,
      );
      expect(f.inspect).not.toHaveBeenCalled();
    },
  );
  it("rejects filesystem root and noncanonical aliases", async () => {
    const f = fixture();
    for (const destination of [resolve("/"), `${f.destination}/../alias`]) {
      rejected(
        await createFixtureRuntimeRelocator(f.overrides)(destination),
        "invalid_destination",
        false,
      );
    }
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it("rejects a non-signal or prior cancellation", async () => {
    const f = fixture();
    rejected(
      await createFixtureRuntimeRelocator(f.overrides)(f.destination, {}),
      "invalid_destination",
      false,
    );
    rejected(await f.run(AbortSignal.abort()), "cancelled", false);
    expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2])("refuses collision at preflight %s before any writes", async (position) => {
    const f = fixture();
    for (let i = 0; i < position; i++) f.inspect.mockResolvedValueOnce(f.inspected);
    f.inspect.mockResolvedValueOnce({
      status: "rejected",
      reason: "destination_unavailable",
    });
    rejected(await f.run(), "destination_unavailable", false);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("refuses changed parent identity between preflights", async () => {
    const f = fixture();
    f.inspect
      .mockResolvedValueOnce(f.inspected)
      .mockResolvedValueOnce({ ...f.inspected, parentIdentity: { dev: 1n, ino: 99n } });
    rejected(await f.run(), "ownership_changed", false);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(["not_created", "present_or_uncertain"])(
    "retains preparation failure state %s",
    async (retainedState) => {
      const f = fixture();
      f.prepare.mockResolvedValue({ status: "failed", reason: "source_changed", retainedState });
      rejected(await f.run(), "source_changed", retainedState !== "not_created");
      expect(f.read).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("does not trust a serialized or copied success result", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue({ ...f.prepared });
    rejected(await f.run(), "invalid_preparation");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects a missing branded plan description", async () => {
    const f = fixture();
    f.describePlan.mockReturnValue(undefined);
    rejected(await f.run(), "invalid_preparation");
  });
  it.each([0, 1, 2, 3])("stops at failed tree read %s", async (position) => {
    const f = fixture();
    for (let i = 0; i < position; i++) f.read.mockResolvedValueOnce(f.snapshots[i]);
    f.read.mockResolvedValueOnce({ status: "rejected", reason: "tree_mismatch" });
    rejected(await f.run(), "tree_mismatch");
    expect(f.read).toHaveBeenCalledTimes(position + 1);
    if (position === 0) expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["sourceTreeSha256", "fileCount", "fileBytes"])(
    "requires matching measured %s",
    async (field) => {
      const f = fixture();
      f.describeSnapshot.mockReturnValue({
        sourceTreeSha256: f.digest,
        fileCount: 6,
        fileBytes: 60,
        [field]: "mismatch",
      });
      rejected(await f.run(), "tree_mismatch");
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it("requires a privately branded read rather than an asserted measured status", async () => {
    const f = fixture();
    f.read.mockResolvedValue({ ...f.snapshots[0] });
    rejected(await f.run(), "storage_failed");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("preserves write failure and does not continue final reads", async () => {
    const f = fixture();
    f.write.mockResolvedValue({ status: "rejected", reason: "closure_unconfirmed" });
    rejected(await f.run(), "closure_unconfirmed");
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])("rejects changed final snapshot %s", async (position) => {
    const f = fixture();
    if (position === 1) f.matches.mockReturnValueOnce(true);
    f.matches.mockReturnValueOnce(false);
    rejected(await f.run(), "snapshot_changed");
    expect(f.disjoint).not.toHaveBeenCalled();
  });
  it("rejects shared file identities or overlapping roots", async () => {
    const f = fixture();
    f.disjoint.mockReturnValue(false);
    rejected(await f.run(), "snapshot_overlap");
  });
  it.each(["inspect", "prepare", "read", "write"])("redacts thrown %s errors", async (stage) => {
    const f = fixture();
    f[stage as "inspect"].mockRejectedValue(new Error(PRIVATE));
    rejected(await f.run(), "storage_failed", stage !== "inspect");
  });
  it.each(["inspect", "prepare", "read", "write", "disjoint"])(
    "stops after cancellation during %s",
    async (stage) => {
      const f = fixture();
      const controller = new AbortController();
      const original = f[stage as "inspect"].getMockImplementation();
      if (!original) throw new Error("Missing fixture implementation");
      f[stage as "inspect"].mockImplementation((...args: unknown[]) => {
        const value = Reflect.apply(original, undefined, args);
        controller.abort();
        return value;
      });
      rejected(await f.run(controller.signal), "cancelled", stage !== "inspect");
      if (stage === "inspect") expect(f.prepare).not.toHaveBeenCalled();
      if (stage === "prepare" || stage === "read") expect(f.write).not.toHaveBeenCalled();
    },
  );
  it.each(["prepare", "read", "write"])(
    "keeps closure_unconfirmed over cancellation at %s",
    async (stage) => {
      const f = fixture();
      const controller = new AbortController();
      f[stage as "prepare"].mockImplementation(async () => {
        controller.abort();
        return {
          status: "failed",
          reason: "closure_unconfirmed",
          retainedState: "present_or_uncertain",
        };
      });
      rejected(await f.run(controller.signal), "closure_unconfirmed");
    },
  );
  it.each(
    [0, 1, 2, 3].flatMap((position) =>
      [false, true].map((closeFailed) => ({ position, closeFailed })),
    ),
  )(
    "stops at cancelled read $position and preserves closure failure $closeFailed",
    async ({ position, closeFailed }) => {
      const f = fixture();
      const controller = new AbortController();
      let index = 0;
      f.read.mockImplementation(async () => {
        const current = index++;
        if (current === position) {
          controller.abort();
          if (closeFailed) return { status: "rejected", reason: "closure_unconfirmed" };
        }
        return f.snapshots[current];
      });
      rejected(await f.run(controller.signal), closeFailed ? "closure_unconfirmed" : "cancelled");
      expect(f.read).toHaveBeenCalledTimes(position + 1);
      expect(f.write).toHaveBeenCalledTimes(position === 0 ? 0 : 1);
      expect(f.matches).not.toHaveBeenCalled();
      expect(f.disjoint).not.toHaveBeenCalled();
    },
  );
  it.each(["prepare", "read", "write"])(
    "preserves unconfirmed %s closure returned after the aggregate deadline",
    async (stage) => {
      vi.useFakeTimers();
      const f = fixture();
      let settle: (result: Outcome) => void = () => {};
      const nested = new Promise<Outcome>((resolve) => {
        settle = resolve;
      });
      f[stage as "prepare"].mockImplementation(async () => await nested);
      let completed = false;
      const pending = f.run().then((result) => {
        completed = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1_200_001);
      expect(completed).toBe(false);
      settle({
        status: "failed",
        reason: "closure_unconfirmed",
        retainedState: "present_or_uncertain",
      });
      rejected(await pending, "closure_unconfirmed");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(["cancelled", "deadline_exceeded"])(
    "keeps first stop reason %s while final-read cleanup spans both stop causes",
    async (firstReason) => {
      vi.useFakeTimers();
      const f = fixture();
      const controller = new AbortController();
      let settle: (result: Outcome) => void = () => {};
      const nested = new Promise<Outcome>((resolve) => {
        settle = resolve;
      });
      for (const snapshot of f.snapshots.slice(0, 3)) f.read.mockResolvedValueOnce(snapshot);
      f.read.mockImplementation(async () => await nested);
      const pending = f.run(controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.read).toHaveBeenCalledTimes(4);
      if (firstReason === "cancelled") controller.abort();
      await vi.advanceTimersByTimeAsync(1_200_001);
      if (firstReason === "deadline_exceeded") controller.abort();
      // Even a late successful measurement cannot undo either sticky stop.
      settle(f.snapshots[3]);
      rejected(await pending, firstReason);
      expect(f.matches).not.toHaveBeenCalled();
      expect(f.disjoint).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("bounds aggregate work and removes cancellation listeners", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    f.prepare.mockImplementation(
      async (_destination, signal) =>
        await new Promise((resolve) => {
          if (!signal) throw new Error("Missing fixture signal");
          signal.addEventListener(
            "abort",
            () =>
              resolve({
                status: "failed",
                reason: "cancelled",
                retainedState: "present_or_uncertain",
              }),
            { once: true },
          );
        }),
    );
    const pending = f.run(controller.signal);
    await vi.advanceTimersByTimeAsync(1_200_001);
    rejected(await pending, "deadline_exceeded");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("maps unexpected reason strings to a closed error", async () => {
    const f = fixture();
    f.prepare.mockResolvedValue({ status: "failed", reason: PRIVATE });
    rejected(await f.run(), "storage_failed");
  });
  it("preserves default unsupported-host behavior without external actions", async () => {
    if (process.platform === "linux") return;
    rejected(
      await createFixtureRuntimeRelocator()(resolve("unused-fixture")),
      "unsupported_host",
      false,
    );
  });
});

describe("closed relocation command framing", () => {
  it("rejects malformed input through the real entrypoint without preparation", () => {
    const child = spawnSync(
      process.execPath,
      [resolve("scripts/relocate-fixture-runtime.mjs"), "--force"],
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16384,
        env:
          process.platform === "win32"
            ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
            : {},
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({
      schemaVersion: 1,
      status: "failed",
      reason: "invalid_destination",
      retainedState: "not_created",
      ...FLAGS,
    });
  });
  it.each([[], ["--force"], ["one", "two"], [null], [3], null, {}].map((args) => [args]))(
    "rejects malformed args %#",
    async (args) => {
      const relocate = vi.fn();
      expect(await runRuntimeRelocationCommand(args, relocate)).toMatchObject({
        exitCode: 2,
        result: { reason: "invalid_destination", ...FLAGS },
      });
      expect(relocate).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["relocated", 0],
    ["failed", 1],
  ])("maps %s to exit %s", async (status, exitCode) => {
    const result = { status, ...FLAGS };
    const relocate = vi.fn(async () => result);
    expect(await runRuntimeRelocationCommand(["/fixture"], relocate)).toEqual({ exitCode, result });
    expect(relocate).toHaveBeenCalledWith("/fixture");
  });
});
