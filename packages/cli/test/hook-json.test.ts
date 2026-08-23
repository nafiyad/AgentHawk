import { PassThrough, Readable } from "node:stream";
import { DeadlineExceededError } from "@agenthawk/core";
import { describe, expect, it } from "vitest";
import {
  HookInputError,
  maximumHookInputBytes,
  parseStrictJson,
  readBoundedJsonInput,
} from "../src/hook-json.js";

describe("hook JSON framing", () => {
  it("accepts exactly 65536 bytes across adversarial chunk boundaries", async () => {
    const source = `${JSON.stringify({ value: 1 })}${" ".repeat(maximumHookInputBytes - 11)}`;
    expect(Buffer.byteLength(source)).toBe(maximumHookInputBytes);
    await expect(
      readBoundedJsonInput(
        Readable.from([Buffer.from(source.slice(0, 65_535)), Buffer.from(source.slice(65_535))]),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ value: 1 });
  });

  it("rejects 65537 bytes before retaining the over-limit chunk", async () => {
    const stream = Readable.from([Buffer.alloc(maximumHookInputBytes, 0x20), Buffer.from("{")]);
    await expect(readBoundedJsonInput(stream, new AbortController().signal)).rejects.toBeInstanceOf(
      HookInputError,
    );
    expect(stream.destroyed).toBe(true);
  });

  it.each([
    ["empty input", ""],
    ["BOM", "\ufeff{}"],
    ["truncated JSON", '{"value":'],
    ["trailing JSON", "{}{}"],
    ["duplicate key", '{"value":1,"value":2}'],
    ["nested duplicate key", '{"outer":{"value":1,"value":2}}'],
    ["escaped-equivalent duplicate key", '{"value":1,"\\u0076alue":2}'],
  ])("rejects %s", (_label, source) => {
    expect(() => parseStrictJson(source)).toThrow(HookInputError);
  });

  it("rejects invalid UTF-8", async () => {
    await expect(
      readBoundedJsonInput(
        Readable.from([Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])]),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HookInputError);
  });

  it("rejects a UTF-8 BOM through the raw byte framing path", async () => {
    await expect(
      readBoundedJsonInput(
        Readable.from([Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])]),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HookInputError);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byte limit %s",
    async (maximumBytes) => {
      await expect(
        readBoundedJsonInput(Readable.from(["{}"]), new AbortController().signal, maximumBytes),
      ).rejects.toBeInstanceOf(HookInputError);
    },
  );

  it("preserves a cancellation that predates input reading", async () => {
    const controller = new AbortController();
    controller.abort(new DeadlineExceededError());
    await expect(
      readBoundedJsonInput(Readable.from(["{}"]), controller.signal),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it("maps an input stream failure to a fixed framing error", async () => {
    const stream = new PassThrough();
    const pending = readBoundedJsonInput(stream, new AbortController().signal);
    stream.destroy(new Error("private stream failure"));
    await expect(pending).rejects.toEqual(new HookInputError());
  });

  it("cancels stalled input with the caller's redacted deadline error", async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const pending = readBoundedJsonInput(stream, controller.signal);
    controller.abort(new DeadlineExceededError());
    await expect(pending).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(stream.destroyed).toBe(true);
  });
});
