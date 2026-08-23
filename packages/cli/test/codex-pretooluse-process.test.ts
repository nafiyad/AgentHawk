import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CODEX_EMERGENCY_DENIAL } from "../src/codex-pretooluse.js";

const entry = resolve("packages/cli/src/codex-pretooluse-entry.ts");
const root = resolve(".");
const tsxCli = createRequire(resolve("packages/cli/package.json")).resolve("tsx/cli");

describe("Codex PreToolUse process boundary", () => {
  it("returns the constant blocking exit-2 result for malformed stdin", async () => {
    const result = await runEntry("not-json");
    expect(result).toEqual({ exitCode: 2, stderr: CODEX_EMERGENCY_DENIAL, stdout: "" });
  });

  it("emits no auto-allow result for an unrelated command", async () => {
    const result = await runEntry(JSON.stringify(payload("git status")));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain('"allow"');
    expect(result.stdout).not.toContain("updatedInput");
  });
});

async function runEntry(input: string): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolvePromise({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

function payload(command: string) {
  return {
    cwd: root,
    hook_event_name: "PreToolUse",
    model: "gpt-5",
    permission_mode: "default",
    session_id: "session-process-fixture",
    tool_input: { command },
    tool_name: "Bash",
    tool_use_id: "tool-process-fixture",
    transcript_path: null,
    turn_id: "turn-process-fixture",
  };
}
