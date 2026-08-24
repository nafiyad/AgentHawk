import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { commandForEntry, HostHarnessError, terminateChild } from "./verify-codex-host.mjs";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 256;
const DEFAULT_MAX_STDERR_BYTES = 128 * 1024;
const CLOSE_TIMEOUT_MS = 5_000;
const TERMINATION_CLOSE_TIMEOUT_MS = 5_000;
const TERMINATION_GROUP_TIMEOUT_MS = 5_000;

function protocolError(code) {
  return new HostHarnessError(`app_server_${code}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateProtocolMessage(value) {
  if (!isRecord(value)) throw protocolError("message_invalid");
  if (Object.hasOwn(value, "jsonrpc")) throw protocolError("jsonrpc_field_unexpected");
  if (Object.hasOwn(value, "id") && typeof value.id !== "string") {
    throw protocolError("response_id_invalid");
  }
  if (Object.hasOwn(value, "method") && typeof value.method !== "string") {
    throw protocolError("method_invalid");
  }
  return value;
}

export function spawnBoundedJsonl(entry, args, options) {
  const command = commandForEntry(entry, args);
  const parseJson = options.parseJson;
  if (typeof parseJson !== "function") throw protocolError("parser_missing");
  const child = spawn(command.file, command.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const processGroupId =
    process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0
      ? child.pid
      : undefined;
  const maximumLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maximumTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maximumMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maximumStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = [];
  let stdoutBuffer = Buffer.alloc(0);
  let totalBytes = 0;
  let messageCount = 0;
  let stderrBytes = 0;
  let failure;
  let closing = false;
  let termination;
  let timer;
  let resolveClosed;
  const closed = new Promise((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const waitForProcessGroupExit = async () => {
    if (process.platform === "win32" || !processGroupId) return;
    const deadline =
      performance.now() + (options.terminationGroupTimeoutMs ?? TERMINATION_GROUP_TIMEOUT_MS);
    while (true) {
      try {
        process.kill(-processGroupId, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
        // macOS reports EPERM when any member of an existing group cannot be
        // probed. That still proves the group exists, so keep waiting rather
        // than mistaking it for quiescence or failing before the bounded poll.
        if (error?.code !== "EPERM") throw protocolError("termination_group_check_failed");
      }
      if (performance.now() >= deadline) throw protocolError("termination_group_timeout");
      await delay(10);
    }
  };

  const signalProcessGroup = () => {
    if (process.platform === "win32" || !processGroupId) return;
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw protocolError("termination_group_kill_failed");
    }
  };

  const terminateAndWait = () => {
    if (!termination) {
      termination = (async () => {
        let groupKillError;
        try {
          signalProcessGroup();
        } catch (error) {
          groupKillError = error;
        }
        await terminateChild(child);
        let terminationTimer;
        try {
          await Promise.race([
            closed,
            new Promise((_, rejectTermination) => {
              terminationTimer = setTimeout(
                () => rejectTermination(protocolError("termination_close_timeout")),
                options.terminationCloseTimeoutMs ?? TERMINATION_CLOSE_TIMEOUT_MS,
              );
              terminationTimer.unref();
            }),
          ]);
        } finally {
          if (terminationTimer) clearTimeout(terminationTimer);
        }
        if (groupKillError) throw groupKillError;
        await waitForProcessGroupExit();
      })();
      void termination.catch(() => undefined);
    }
    return termination;
  };

  const rejectConsumers = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    for (const waiter of notificationWaiters.splice(0)) waiter.reject(error);
  };

  const fail = (error) => {
    if (failure) return;
    failure = error instanceof HostHarnessError ? error : protocolError("unexpected_failure");
    rejectConsumers(failure);
    void terminateAndWait();
  };

  const dispatchNotification = (message) => {
    for (let index = 0; index < notificationWaiters.length; index += 1) {
      const waiter = notificationWaiters[index];
      if (waiter.method === message.method && waiter.predicate(message.params)) {
        notificationWaiters.splice(index, 1);
        waiter.resolve(message.params);
        return;
      }
    }
    notifications.push(message);
  };

  const dispatch = (rawMessage) => {
    const message = validateProtocolMessage(rawMessage);
    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasId && hasMethod) throw protocolError("server_request_unexpected");
    if (hasId) {
      const request = pending.get(message.id);
      if (!request) throw protocolError("response_id_unexpected");
      pending.delete(message.id);
      if (Object.hasOwn(message, "error")) {
        request.reject(protocolError("response_error"));
        return;
      }
      if (!Object.hasOwn(message, "result")) throw protocolError("response_result_missing");
      request.resolve(message.result);
      return;
    }
    if (!hasMethod || !Object.hasOwn(message, "params")) {
      throw protocolError("notification_invalid");
    }
    dispatchNotification(message);
  };

  const consumeLine = (line) => {
    if (line.length > 0 && line.at(-1) === 0x0d) line = line.subarray(0, -1);
    if (line.length === 0) throw protocolError("line_empty");
    if (line.length > maximumLineBytes) throw protocolError("line_too_large");
    if (line.includes(0)) throw protocolError("line_has_nul");
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(line);
    } catch {
      throw protocolError("utf8_invalid");
    }
    let value;
    try {
      value = parseJson(text);
    } catch {
      throw protocolError("json_invalid");
    }
    messageCount += 1;
    if (messageCount > maximumMessages) throw protocolError("message_limit");
    dispatch(value);
  };

  child.stdout.on("data", (chunk) => {
    if (failure) return;
    try {
      totalBytes += chunk.length;
      if (totalBytes > maximumTotalBytes) throw protocolError("output_too_large");
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      let newline = stdoutBuffer.indexOf(0x0a);
      while (newline !== -1) {
        const line = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        consumeLine(line);
        newline = stdoutBuffer.indexOf(0x0a);
      }
      if (stdoutBuffer.length > maximumLineBytes) throw protocolError("line_too_large");
    } catch (error) {
      fail(error);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > maximumStderrBytes) fail(protocolError("stderr_too_large"));
  });
  child.once("error", () => fail(protocolError("process_start_failed")));
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    if (failure) {
      resolveClosed();
      return;
    }
    if (stdoutBuffer.length !== 0) {
      const error = protocolError("partial_frame");
      failure = error;
      rejectConsumers(error);
      resolveClosed();
      return;
    }
    if (!closing) {
      const error = protocolError("process_closed_early");
      failure = error;
      rejectConsumers(error);
      resolveClosed();
      return;
    }
    if (code !== 0 || signal !== null) {
      const error = protocolError("process_exit_failed");
      failure = error;
      rejectConsumers(error);
      resolveClosed();
      return;
    }
    resolveClosed();
  });
  timer = setTimeout(
    () => fail(protocolError("process_timeout")),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  timer.unref();

  const writeMessage = async (message) => {
    if (failure) throw failure;
    if (closing || child.stdin.destroyed) throw protocolError("stdin_closed");
    const bytes = `${JSON.stringify(message)}\n`;
    await new Promise((resolveWrite, rejectWrite) => {
      child.stdin.write(bytes, (error) =>
        error ? rejectWrite(protocolError("stdin_write_failed")) : resolveWrite(),
      );
    });
  };

  return {
    async request(id, method, params) {
      if (pending.has(id)) throw protocolError("request_id_duplicate");
      const response = new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      });
      try {
        await writeMessage({ id, method, params });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
      return await response;
    },
    async notify(method, params) {
      const message = params === undefined ? { method } : { method, params };
      await writeMessage(message);
    },
    async waitForNotification(method, predicate = () => true) {
      const index = notifications.findIndex(
        (message) => message.method === method && predicate(message.params),
      );
      if (index !== -1) return notifications.splice(index, 1)[0].params;
      if (failure) throw failure;
      return await new Promise((resolveNotification, rejectNotification) => {
        notificationWaiters.push({
          method,
          predicate,
          resolve: resolveNotification,
          reject: rejectNotification,
        });
      });
    },
    async close() {
      if (failure) throw failure;
      if (pending.size !== 0 || notificationWaiters.length !== 0) {
        throw protocolError("consumers_pending");
      }
      closing = true;
      child.stdin.end();
      let closeTimer;
      try {
        await Promise.race([
          closed,
          new Promise((_, rejectClose) => {
            closeTimer = setTimeout(
              () => rejectClose(protocolError("close_timeout")),
              options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
            );
            closeTimer.unref();
          }),
        ]);
        if (failure) throw failure;
      } catch (error) {
        await terminateAndWait();
        throw error;
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
    },
    async abort() {
      closing = true;
      clearTimeout(timer);
      await terminateAndWait();
    },
  };
}
