#!/usr/bin/env node

import type { Writable } from "node:stream";
import { runCodexPreToolUse } from "./codex-pretooluse.js";

process.exitCode = await runCodexPreToolUse(process.stdin, {
  writeError: async (text) => await write(process.stderr, text),
  writeOutput: async (text) => await write(process.stdout, text),
});

async function write(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
