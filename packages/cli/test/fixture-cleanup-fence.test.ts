import { describe, expect, it, vi } from "vitest";
import { createFixtureCleanupFence } from "./fixture-cleanup-fence.js";

const FAILURE = "Fixture cleanup withheld; unfinished test activity may remain.";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("sequential fixture cleanup fence", () => {
  it("refuses cleanup before any test has been admitted", async () => {
    const fence = createFixtureCleanupFence();
    const roots = ["fixture-root"];
    const remove = vi.fn(async () => {});
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(remove).not.toHaveBeenCalled();
    expect(roots).toEqual(["fixture-root"]);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
  });

  it("rejects an already-aborted signal before admitting cleanup", async () => {
    const fence = createFixtureCleanupFence();
    const controller = new AbortController();
    controller.abort(new Error("private cancellation diagnostic"));
    const roots = ["fixture-root"];
    const remove = vi.fn(async () => {});
    expect(() => fence.begin(controller.signal)).toThrow(FAILURE);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(remove).not.toHaveBeenCalled();
    expect(roots).toEqual(["fixture-root"]);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
  });

  it("preserves current and later roots when cancellation outlives the test callback", async () => {
    const fence = createFixtureCleanupFence();
    const controller = new AbortController();
    const pendingBody = deferred();
    const roots = ["first-fixture-root"];
    const remove = vi.fn(async () => {});
    fence.begin(controller.signal);
    const body = pendingBody.promise.then(() => {
      roots.push("late-fixture-root");
    });
    controller.abort();
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(roots).toEqual(["first-fixture-root"]);
    pendingBody.resolve();
    await body;
    expect(roots).toEqual(["first-fixture-root", "late-fixture-root"]);
    expect(remove).not.toHaveBeenCalled();
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(roots).toEqual(["first-fixture-root", "late-fixture-root"]);
  });

  it("awaits successful cleanup before admitting the next test", async () => {
    const fence = createFixtureCleanupFence();
    const pendingRemoval = deferred();
    const firstController = new AbortController();
    const roots = ["first-fixture-root", "second-fixture-root"];
    const removed: string[] = [];
    const remove = vi.fn(async (root: string) => {
      if (root === "first-fixture-root") await pendingRemoval.promise;
      removed.push(root);
    });
    fence.begin(firstController.signal);
    const cleanup = fence.cleanup(roots, remove);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([]);
    expect(roots).toEqual(["first-fixture-root", "second-fixture-root"]);
    pendingRemoval.resolve();
    await cleanup;
    expect(roots).toEqual([]);
    expect(removed).toEqual(["first-fixture-root", "second-fixture-root"]);

    const nextController = new AbortController();
    fence.begin(nextController.signal);
    // An old test's signal no longer has authority over a successfully settled successor.
    firstController.abort();
    roots.push("third-fixture-root");
    await fence.cleanup(roots, remove);
    expect(removed).toEqual(["first-fixture-root", "second-fixture-root", "third-fixture-root"]);
    expect(roots).toEqual([]);
  });

  it("allows successful empty cleanup across successive tests", async () => {
    const fence = createFixtureCleanupFence();
    const remove = vi.fn(async () => {});
    for (let test = 0; test < 3; test += 1) {
      fence.begin(new AbortController().signal);
      await fence.cleanup([], remove);
    }
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps a late registration visible until its own removal settles", async () => {
    const fence = createFixtureCleanupFence();
    const firstRemoval = deferred();
    const secondRemoval = deferred();
    const roots = ["first-fixture-root"];
    const remove = vi.fn(async (root: string) => {
      await (root === "first-fixture-root" ? firstRemoval.promise : secondRemoval.promise);
    });
    fence.begin(new AbortController().signal);
    const cleanup = fence.cleanup(roots, remove);
    roots.push("late-fixture-root");
    expect(roots).toEqual(["first-fixture-root", "late-fixture-root"]);
    firstRemoval.resolve();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(roots).toEqual(["late-fixture-root"]);
    secondRemoval.resolve();
    await cleanup;
    expect(remove.mock.calls).toEqual([["first-fixture-root"], ["late-fixture-root"]]);
    expect(roots).toEqual([]);
  });

  it("retains unfinished roots and poisons admission when removal fails", async () => {
    const fence = createFixtureCleanupFence();
    const roots = ["removed-fixture-root", "failed-fixture-root", "later-fixture-root"];
    const remove = vi.fn(async (root: string) => {
      if (root === "failed-fixture-root") throw new Error("private removal diagnostic");
    });
    fence.begin(new AbortController().signal);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(roots).toEqual(["failed-fixture-root", "later-fixture-root"]);
    expect(remove.mock.calls).toEqual([["removed-fixture-root"], ["failed-fixture-root"]]);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("stops after cancellation during removal without pretending completed removal was reversed", async () => {
    const fence = createFixtureCleanupFence();
    const controller = new AbortController();
    const pendingRemoval = deferred();
    const roots = ["first-fixture-root", "untouched-fixture-root"];
    const removed: string[] = [];
    const remove = vi.fn(async (root: string) => {
      await pendingRemoval.promise;
      removed.push(root);
    });
    fence.begin(controller.signal);
    const cleanup = fence.cleanup(roots, remove);
    const rejection = expect(cleanup).rejects.toThrow(FAILURE);
    controller.abort();
    expect(roots).toEqual(["first-fixture-root", "untouched-fixture-root"]);
    pendingRemoval.resolve();
    await rejection;
    expect(removed).toEqual(["first-fixture-root"]);
    expect(roots).toEqual(["untouched-fixture-root"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
  });

  it("does not report success when cancellation occurs during the final removal", async () => {
    const fence = createFixtureCleanupFence();
    const controller = new AbortController();
    const roots = ["fixture-root"];
    fence.begin(controller.signal);
    await expect(
      fence.cleanup(roots, async () => {
        controller.abort();
      }),
    ).rejects.toThrow(FAILURE);
    expect(roots).toEqual([]);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
  });

  it.each(["same signal", "different signal"])(
    "rejects repeated begin with %s and withholds cleanup",
    async (kind) => {
      const fence = createFixtureCleanupFence();
      const controller = new AbortController();
      fence.begin(controller.signal);
      const next = kind === "same signal" ? controller.signal : new AbortController().signal;
      expect(() => fence.begin(next)).toThrow(FAILURE);
      const roots = ["fixture-root"];
      const remove = vi.fn(async () => {});
      await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
      expect(roots).toEqual(["fixture-root"]);
      expect(remove).not.toHaveBeenCalled();
    },
  );

  it("rejects a new test beginning during pending cleanup and stops subsequent removals", async () => {
    const fence = createFixtureCleanupFence();
    const pendingRemoval = deferred();
    const roots = ["first-fixture-root", "untouched-fixture-root"];
    const remove = vi.fn(async () => {
      await pendingRemoval.promise;
    });
    fence.begin(new AbortController().signal);
    const cleanup = fence.cleanup(roots, remove);
    const rejection = expect(cleanup).rejects.toThrow(FAILURE);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
    pendingRemoval.resolve();
    await rejection;
    expect(roots).toEqual(["untouched-fixture-root"]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("preserves changed tracking state when the active root is replaced during cleanup", async () => {
    const fence = createFixtureCleanupFence();
    const roots = ["original-fixture-root", "later-fixture-root"];
    const remove = vi.fn(async () => {
      roots[0] = "replacement-fixture-root";
    });
    fence.begin(new AbortController().signal);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(roots).toEqual(["replacement-fixture-root", "later-fixture-root"]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(() => fence.begin(new AbortController().signal)).toThrow(FAILURE);
  });

  it("rejects a sparse root inventory before passing an unknown target to removal", async () => {
    const fence = createFixtureCleanupFence();
    const roots = new Array<string>(1);
    const remove = vi.fn(async () => {});
    fence.begin(new AbortController().signal);
    await expect(fence.cleanup(roots, remove)).rejects.toThrow(FAILURE);
    expect(roots).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
