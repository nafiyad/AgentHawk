import type { Readable } from "node:stream";
import { cancellationError } from "@agenthawk/core";
import { parseDocument } from "yaml";

export const maximumHookInputBytes = 65_536;

export class HookInputError extends Error {
  constructor() {
    super("Hook input is invalid.");
    this.name = "HookInputError";
  }
}

export async function readBoundedJsonInput(
  input: Readable,
  signal: AbortSignal,
  maximumBytes = maximumHookInputBytes,
): Promise<unknown> {
  const bytes = await readBoundedInput(input, signal, maximumBytes);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new HookInputError();
  }
  return parseStrictJson(source);
}

export function parseStrictJson(source: string): unknown {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length > 0) throw new HookInputError();
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new HookInputError();
  }
}

async function readBoundedInput(
  input: Readable,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new HookInputError();
  if (signal.aborted) throw cancellationError(signal);
  return await new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown, cancelInput = false) => {
      /* v8 ignore next -- settlement removes every producer and abort listener synchronously */
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelInput && !input.destroyed) input.destroy();
      reject(error);
    };
    const onAbort = () => fail(cancellationError(signal), true);
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) {
        input.pause();
        fail(new HookInputError(), true);
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      /* v8 ignore next -- settlement removes the end listener synchronously */
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(Buffer.concat(chunks, total));
    };
    const onError = () => fail(new HookInputError());
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    /* v8 ignore next -- JavaScript cannot interleave an abort between the check and listener setup */
    if (signal.aborted) onAbort();
  });
}
