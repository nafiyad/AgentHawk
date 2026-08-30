#!/usr/bin/env node

import type { Writable } from "node:stream";
import { runClaudePreToolUse } from "./claude-pretooluse.js";
import { parseClaudeProjectHookLaunchArguments } from "./claude-project-hook-format.js";
import { verifyClaudeProjectHookInvocation } from "./claude-project-hook-invocation.js";
import { loadRepositoryAuthority } from "./repository-authority.js";

process.exitCode = await runClaudePreToolUse(
  process.stdin,
  {
    loadAuthority: loadRepositoryAuthority,
    parseProjectLaunchArguments: parseClaudeProjectHookLaunchArguments,
    verifyProjectInvocation: verifyClaudeProjectHookInvocation,
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
