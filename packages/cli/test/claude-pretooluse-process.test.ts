import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_EMERGENCY_DENIAL } from "../src/claude-pretooluse.js";

const entry = resolve("packages/cli/src/claude-pretooluse-entry.ts");
const root = resolve(".");
const tsxCli = createRequire(resolve("packages/cli/package.json")).resolve("tsx/cli");

describe("Claude Code PreToolUse process boundary", () => {
  it("returns the constant exit-2 emergency result for malformed stdin", async () => {
    expect(await runEntry("not-json")).toEqual({
      exitCode: 2,
      stderr: CLAUDE_EMERGENCY_DENIAL,
      stdout: "",
    });
  });

  it("emits zero stdout bytes for an unrelated Bash command", async () => {
    const result = await runEntry(JSON.stringify(payload("git status")));
    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
  });

  it("fails closed for malformed project launch arguments", async () => {
    expect(
      await runEntry(JSON.stringify(payload("git status")), ["--deployment-trust", "project"]),
    ).toEqual({ exitCode: 2, stderr: CLAUDE_EMERGENCY_DENIAL, stdout: "" });
  });

  it("fails closed before providers when a declared project pair is absent", async () => {
    const result = await runEntry(JSON.stringify(payload("npm add private-package@1.0.0")), [
      "--deployment-trust",
      "project",
      "--installation-id",
      "ab".repeat(32),
      "--root-binding",
      "cd".repeat(32),
    ]);
    expect(result).toEqual({ exitCode: 2, stderr: CLAUDE_EMERGENCY_DENIAL, stdout: "" });
    expect(result.stderr).not.toContain("private-package");
  });

  it("denies a PowerShell dependency-like command without disclosing input", async () => {
    const privateCommand = "npm add private-package@1.0.0";
    const result = await runEntry(
      JSON.stringify({ ...payload(privateCommand), tool_name: "PowerShell" }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(result.stdout).not.toContain(privateCommand);
    expect(result.stdout).not.toMatch(/"(?:allow|ask|defer)"|updatedInput/u);
  });
});

async function runEntry(
  input: string,
  launchArguments: readonly string[] = [],
): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxCli, entry, ...launchArguments], {
      cwd: root,
      env: { ...process.env, PRIVATE_SENTINEL: "must-not-appear" },
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
      const result = {
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      expect(`${result.stdout}${result.stderr}`).not.toContain("must-not-appear");
      resolvePromise(result);
    });
    child.stdin.end(input);
  });
}

function payload(command: string) {
  return {
    cwd: root,
    hook_event_name: "PreToolUse",
    permission_mode: "default",
    session_id: "session-private",
    tool_input: { command },
    tool_name: "Bash",
    tool_use_id: "tool-private",
    transcript_path: resolve("private-transcript.jsonl"),
  };
}
