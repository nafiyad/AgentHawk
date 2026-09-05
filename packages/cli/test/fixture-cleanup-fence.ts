// For sequential test modules only. A timed-out Vitest callback can continue
// running; cancellation therefore forbids cleanup and later fixture admission.
// This fence does not claim that cancellation has stopped any process.
export function createFixtureCleanupFence() {
  let poisoned = false;
  let active: AbortSignal | undefined;
  const poison = () => {
    poisoned = true;
  };
  const fail = () => new Error("Fixture cleanup withheld; unfinished test activity may remain.");
  const check = () => {
    if (poisoned || !active || active.aborted) {
      poison();
      throw fail();
    }
  };

  return {
    begin(signal: AbortSignal): void {
      if (poisoned || active) {
        poison();
        throw fail();
      }
      active = signal;
      signal.addEventListener("abort", poison, { once: true });
      check();
    },

    async cleanup(roots: string[], remove: (root: string) => Promise<void>): Promise<void> {
      try {
        check();
        while (roots.length > 0) {
          check();
          const root = roots[0];
          if (root === undefined) throw fail();
          await remove(root);
          // Keep unfinished or late registrations visible until deletion settles.
          if (roots[0] !== root) throw fail();
          roots.shift();
        }
        check();
      } catch {
        poison();
        throw fail();
      } finally {
        active?.removeEventListener("abort", poison);
        active = undefined;
      }
    },
  };
}
