const OPERATION_MS = 30000;
const SETTLEMENT_MS = 5000;
const IO_METHODS = ["realpath", "lstat", "mkdir", "open"];
const HANDLE_METHODS = ["stat", "read", "write", "sync", "close"];

function fixedError(code) {
  return new Error(code);
}

/**
 * Bound responses to trusted filesystem calls, not the kernel calls themselves.
 * A timed-out syscall may still finish or mutate retained state later. Settlement
 * false explicitly means quiescence/closure was NOT established. No path is ever
 * removed; late handles are only closed, after their own pending I/O settles.
 */
export function createBoundedArtifactStorage(filesystem, signal) {
  let methods;
  try {
    if (!(signal instanceof AbortSignal)) throw fixedError("storage_invalid_input");
    methods = Object.fromEntries(IO_METHODS.map((name) => [name, filesystem[name]]));
    if (IO_METHODS.some((name) => typeof methods[name] !== "function")) {
      throw fixedError("storage_invalid_input");
    }
  } catch {
    throw fixedError("storage_invalid_input");
  }

  const pending = new Set();
  const handles = new Set();
  const observers = new Set();
  let stopped;
  let uncertain = false;
  let settlement;

  function notify() {
    for (const observer of observers) observer();
  }

  function stop(code) {
    stopped ??= code;
    for (const entry of pending) {
      // Closing never admits a new write and remains allowed during shutdown.
      if (!entry.closing) entry.reject(stopped);
    }
    for (const handle of handles) requestClose(handle).catch(() => {});
    notify();
  }

  function begin(call, handle, closing = false, transform = (value) => value) {
    if (stopped && !closing) return Promise.reject(fixedError(stopped));
    if (handle?.closeRequested) return Promise.reject(fixedError("storage_closed"));

    let resolveResponse;
    let rejectResponse;
    let responded = false;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const entry = {
      closing,
      reject(code) {
        if (!responded) {
          responded = true;
          rejectResponse(fixedError(code));
        }
      },
    };
    pending.add(entry);
    if (handle) handle.busy += 1;
    const timer = setTimeout(() => {
      entry.reject("storage_timeout");
      stop("storage_timeout");
    }, OPERATION_MS);

    function complete(ok, value) {
      clearTimeout(timer);
      // Open results must be registered even after the caller was rejected, so a
      // late descriptor cannot escape accounting or closure.
      if (ok) {
        try {
          value = transform(value);
        } catch {
          ok = false;
        }
      }
      pending.delete(entry);
      if (handle) handle.busy -= 1;
      if (!ok) {
        entry.reject("storage_failed");
        stop("storage_failed");
      } else if (!responded) {
        responded = true;
        resolveResponse(value);
      }
      if (handle) maybeClose(handle);
      notify();
    }

    try {
      Promise.resolve(call()).then(
        (value) => complete(true, value),
        () => complete(false),
      );
    } catch {
      complete(false);
    }
    return response;
  }

  function maybeClose(handle) {
    if (!handle.closeRequested || handle.busy !== 0 || handle.closeStarted) return;
    handle.closeStarted = true;
    try {
      Promise.resolve(Reflect.apply(handle.methods.close, handle.raw, [])).then(
        () => {
          handle.closed = true;
          handle.resolveClose();
        },
        () => {
          handle.closeFailed = true;
          handle.rejectClose(fixedError("storage_failed"));
        },
      );
    } catch {
      handle.closeFailed = true;
      handle.rejectClose(fixedError("storage_failed"));
    }
  }

  function requestClose(handle) {
    if (handle.closeResponse) return handle.closeResponse;
    handle.closeRequested = true;
    const completion = new Promise((resolve, reject) => {
      handle.resolveClose = resolve;
      handle.rejectClose = reject;
    });
    handle.closeResponse = begin(() => completion, undefined, true);
    maybeClose(handle);
    return handle.closeResponse;
  }

  function register(raw) {
    let handleMethods;
    try {
      handleMethods = Object.fromEntries(HANDLE_METHODS.map((name) => [name, raw[name]]));
      if (HANDLE_METHODS.some((name) => typeof handleMethods[name] !== "function")) {
        throw fixedError("storage_failed");
      }
    } catch {
      // A malformed trusted implementation cannot establish ownership/closure.
      uncertain = true;
      throw fixedError("storage_failed");
    }
    const state = {
      raw,
      methods: handleMethods,
      busy: 0,
      closeRequested: false,
      closeStarted: false,
      closed: false,
      closeFailed: false,
      closeResponse: undefined,
      resolveClose: undefined,
      rejectClose: undefined,
    };
    handles.add(state);
    const wrapped = Object.freeze(
      Object.fromEntries(
        HANDLE_METHODS.map((name) => [
          name,
          name === "close"
            ? () => requestClose(state)
            : (...args) => begin(() => Reflect.apply(handleMethods[name], raw, args), state),
        ]),
      ),
    );
    if (stopped) requestClose(state).catch(() => {});
    return wrapped;
  }

  const wrapped = Object.freeze(
    Object.fromEntries(
      IO_METHODS.map((name) => [
        name,
        (...args) =>
          begin(
            () => Reflect.apply(methods[name], filesystem, args),
            undefined,
            false,
            name === "open" ? register : undefined,
          ),
      ]),
    ),
  );
  const aborted = () => stop("storage_cancelled");
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) aborted();

  function settle() {
    if (settlement) return settlement;
    stop("storage_closed");
    signal.removeEventListener("abort", aborted);
    settlement = new Promise((resolve) => {
      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        observers.delete(check);
        resolve(value);
      };
      const check = () => {
        if (pending.size !== 0) return;
        finish(!uncertain && [...handles].every((handle) => handle.closed && !handle.closeFailed));
      };
      const timer = setTimeout(() => finish(false), SETTLEMENT_MS);
      observers.add(check);
      check();
    });
    return settlement;
  }

  return Object.freeze({ filesystem: wrapped, settle });
}
