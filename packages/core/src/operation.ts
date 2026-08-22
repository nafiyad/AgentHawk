export interface OperationContext {
  signal?: AbortSignal | undefined;
}

export class OperationCancelledError extends Error {
  readonly code: "deadline_exceeded" | "operation_cancelled" = "operation_cancelled";

  constructor() {
    super("Operation was cancelled.");
    this.name = "OperationCancelledError";
  }
}

export class DeadlineExceededError extends OperationCancelledError {
  override readonly code = "deadline_exceeded";

  constructor() {
    super();
    this.name = "DeadlineExceededError";
    this.message = "Operation deadline was exceeded.";
  }
}

export function cancellationError(signal: AbortSignal): OperationCancelledError {
  return signal.reason instanceof DeadlineExceededError
    ? new DeadlineExceededError()
    : new OperationCancelledError();
}

export function throwIfCancelled(context: OperationContext = {}): void {
  if (context.signal?.aborted) throw cancellationError(context.signal);
}

export function isOperationCancelled(error: unknown): error is OperationCancelledError {
  return error instanceof OperationCancelledError;
}
