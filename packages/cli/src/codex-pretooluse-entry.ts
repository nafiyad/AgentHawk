#!/usr/bin/env node

import type { Writable } from "node:stream";
import { runCodexPreToolUse } from "./codex-pretooluse.js";
import { parseCodexProjectHookLaunchArguments } from "./codex-project-hook-format.js";
import { verifyCodexProjectHookInvocation } from "./codex-project-hook-status.js";
import { loadRepositoryAuthority } from "./repository-authority.js";

process.exitCode = await runCodexPreToolUse(
  process.stdin,
  {
    loadAuthority: loadRepositoryAuthority,
    parseProjectLaunchArguments: parseCodexProjectHookLaunchArguments,
    verifyProjectInvocation: verifyCodexProjectHookInvocation,
    writeError: async (text) => await write(process.stderr, text),
    writeOutput: async (text) => await write(process.stdout, text),
  },
  process.argv.slice(2),
);

async function write(stream: Writable, text: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
