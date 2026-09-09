import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const CLOSE_MS = 5_000;
const MAX_OUTPUT = 1_048_576;

/** Development-only trusted process seam. Never receives agent/candidate commands. */
export function createRuntimeBuildRunner(overrides = {}) {
  const launch = overrides.spawn ?? spawn;
  const kill = overrides.kill ?? process.kill;
  const now = overrides.now ?? (() => performance.now());
  const sleep = overrides.delay ?? delay;
  const platform = overrides.platform ?? process.platform;

  /** @param {{cwd: string, env: Record<string, string>, signal?: AbortSignal, timeoutMs?: number}} options */
  const execute = async (file, args, options) => {
    const { cwd, env, signal, timeoutMs = 30_000 } = options;
    if (platform !== "linux" || signal?.aborted) {
      return { status: "failed", reason: signal?.aborted ? "cancelled" : "unsupported_host" };
    }
    let child;
    let group;
    let closed = false;
    let code;
    let reason;
    let bytes = 0;
    const chunks = [];
    let wake;
    const completed = new Promise((resolve) => {
      wake = resolve;
    });
    const stop = (value) => {
      reason ??= value;
      wake();
    };
    const abort = () => stop("cancelled");
    let timer;
    const exists = () => {
      try {
        kill(-group, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        // EPERM and unexpected probe failures never establish quiescence.
        return true;
      }
    };
    const waitGone = async () => {
      const deadline = now() + CLOSE_MS;
      while (!closed || (group !== undefined && exists())) {
        if (now() >= deadline) return false;
        await sleep(10);
      }
      return true;
    };
    try {
      child = launch(file, args, {
        cwd,
        env,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      group = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : undefined;
      for (const [stream, capture] of [
        [child.stdout, true],
        [child.stderr, false],
      ]) {
        stream.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_OUTPUT) stop("process_output_limit");
          else if (capture && !reason) chunks.push(Buffer.from(chunk));
        });
        stream.once("error", () => stop("process_failed"));
      }
      child.once("error", () => stop("process_failed"));
      child.once("close", (exitCode, exitSignal) => {
        closed = true;
        code = exitCode;
        if (exitSignal || exitCode !== 0) reason ??= "process_failed";
        wake();
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => stop("process_timeout"), timeoutMs);
      if (group === undefined) stop("process_failed");
      await completed;
      clearTimeout(timer);
      // A successful parent exit is insufficient: do not admit another phase
      // while an owned descendant still exists (including after pipes close).
      if (!reason && !(await waitGone())) reason = "process_failed";
      if (reason) {
        if (group !== undefined) {
          try {
            kill(-group, "SIGKILL");
          } catch (error) {
            if (error?.code !== "ESRCH") return { status: "failed", reason: "closure_unconfirmed" };
          }
        }
        if (!(await waitGone())) return { status: "failed", reason: "closure_unconfirmed" };
        return { status: "failed", reason };
      }
      if (code !== 0) return { status: "failed", reason: "process_failed" };
      return { status: "completed", stdout: Buffer.concat(chunks) };
    } catch {
      // Best-effort termination still applies on unexpected stream/launcher
      // failures. A missing handle is never a manufactured acknowledgement.
      if (group !== undefined) {
        try {
          kill(-group, "SIGKILL");
        } catch {
          /* Closure remains unconfirmed. */
        }
        try {
          await waitGone();
        } catch {
          /* Preserve the closed failure result. */
        }
      }
      return { status: "failed", reason: "closure_unconfirmed" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  return execute;
}

export const runRuntimeBuildProcess = createRuntimeBuildRunner();
