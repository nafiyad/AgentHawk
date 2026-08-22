import { describe, expect, it } from "vitest";
import {
  cancellationError,
  DeadlineExceededError,
  isOperationCancelled,
  OperationCancelledError,
  throwIfCancelled,
} from "../src/operation.js";

describe("operation cancellation", () => {
  it("maps untrusted abort reasons to a fixed redacted error", () => {
    const controller = new AbortController();
    controller.abort(new Error("secret host reason"));

    expect(() => throwIfCancelled({ signal: controller.signal })).toThrow(
      new OperationCancelledError(),
    );
    expect(cancellationError(controller.signal).message).not.toContain("secret");
  });

  it("preserves AgentHawk-owned deadline identity", () => {
    const controller = new AbortController();
    const deadline = new DeadlineExceededError();
    controller.abort(deadline);

    expect(cancellationError(controller.signal)).toBe(deadline);
    expect(isOperationCancelled(deadline)).toBe(true);
    expect(deadline.code).toBe("deadline_exceeded");
  });

  it("does nothing without cancellation", () => {
    expect(() => throwIfCancelled()).not.toThrow();
    expect(isOperationCancelled(new Error("ordinary"))).toBe(false);
  });
});
