import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseStrictJson } from "../packages/cli/src/hook-json.js";
import { spawnBoundedJsonl, validateProtocolMessage } from "./bounded-jsonl-process.mjs";
import { HostHarnessError } from "./verify-codex-host.mjs";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function fakeProcess(source: string) {
  const root = await mkdtemp(join(tmpdir(), "agenthawk-jsonl-test-"));
  roots.push(root);
  const entry = join(root, "fake.mjs");
  await writeFile(entry, source, "utf8");
  return { entry, root };
}

function client(entry: string, root: string, overrides = {}) {
  return spawnBoundedJsonl(entry, [], {
    cwd: root,
    env: process.env,
    parseJson: JSON.parse,
    timeoutMs: 5_000,
    ...overrides,
  });
}

describe("bounded app-server JSONL transport", () => {
  it("handles fragmented UTF-8, CRLF, and interleaved notifications", async () => {
    const fixture = await fakeProcess(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\\n");
  while (newline !== -1) {
    const request = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (request.id === "one") {
      const notification = Buffer.from(JSON.stringify({method:"fixture/event",params:{text:"hawk 🦅"}}) + "\\r\\n");
      process.stdout.write(notification.subarray(0, notification.length - 3));
      setTimeout(() => {
        process.stdout.write(notification.subarray(notification.length - 3));
        process.stdout.write(JSON.stringify({id:"one",result:{ok:true}}) + "\\r\\n");
      }, 5);
    }
    newline = input.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`);
    const transport = client(fixture.entry, fixture.root);
    const response = transport.request("one", "fixture/request", {});
    await expect(transport.waitForNotification("fixture/event")).resolves.toEqual({
      text: "hawk 🦅",
    });
    await expect(response).resolves.toEqual({ ok: true });
    await transport.close();
  });

  it.each([
    [
      "invalid UTF-8",
      "process.stdout.write(Buffer.from([0xff, 0x0a])); setInterval(() => {}, 1000);",
      "app_server_utf8_invalid",
    ],
    [
      "a server request",
      'process.stdout.write(JSON.stringify({id:"server",method:"approval/request",params:{}}) + "\\n"); setInterval(() => {}, 1000);',
      "app_server_server_request_unexpected",
    ],
    [
      "an unknown response",
      'process.stdout.write(JSON.stringify({id:"other",result:{}}) + "\\n"); setInterval(() => {}, 1000);',
      "app_server_response_id_unexpected",
    ],
    [
      "a partial final frame",
      'process.stdout.write("{\\"id\\":\\"one\\"");',
      "app_server_partial_frame",
    ],
  ])("fails closed on %s", async (_label, source, code) => {
    const fixture = await fakeProcess(source);
    const transport = client(fixture.entry, fixture.root);
    await expect(transport.request("one", "fixture/request", {})).rejects.toThrowError(
      new HostHarnessError(code),
    );
    await transport.abort();
  });

  it("bounds line, total, message, and stderr growth", async () => {
    const cases = [
      {
        source: 'process.stdout.write("x".repeat(33)); setInterval(() => {}, 1000);',
        options: { maxLineBytes: 32 },
        code: "app_server_line_too_large",
      },
      {
        source: 'process.stdout.write("{}\\n{}\\n"); setInterval(() => {}, 1000);',
        options: { maxTotalBytes: 4 },
        code: "app_server_output_too_large",
      },
      {
        source:
          'process.stdout.write("{\\"method\\":\\"one\\",\\"params\\":{}}\\n{\\"method\\":\\"two\\",\\"params\\":{}}\\n"); setInterval(() => {}, 1000);',
        options: { maxMessages: 1 },
        code: "app_server_message_limit",
      },
      {
        source: 'process.stderr.write("x".repeat(33)); setInterval(() => {}, 1000);',
        options: { maxStderrBytes: 32 },
        code: "app_server_stderr_too_large",
      },
    ];
    for (const item of cases) {
      const fixture = await fakeProcess(item.source);
      const transport = client(fixture.entry, fixture.root, item.options);
      await expect(transport.request("one", "fixture/request", {})).rejects.toThrowError(
        new HostHarnessError(item.code),
      );
      await transport.abort();
    }
  });

  it("uses the caller's strict parser to reject duplicate keys", async () => {
    const fixture = await fakeProcess(
      'process.stdout.write("{\\"id\\":\\"one\\",\\"result\\":{},\\"result\\":{}}\\n"); setInterval(() => {}, 1000);',
    );
    const transport = spawnBoundedJsonl(fixture.entry, [], {
      cwd: fixture.root,
      env: process.env,
      timeoutMs: 5_000,
      parseJson: parseStrictJson,
    });
    await expect(transport.request("one", "fixture/request", {})).rejects.toThrowError(
      new HostHarnessError("app_server_json_invalid"),
    );
    await transport.abort();
  });

  it("rejects duplicate client request identifiers", async () => {
    const fixture = await fakeProcess("setInterval(() => {}, 1000);");
    const transport = client(fixture.entry, fixture.root);
    const first = transport.request("one", "fixture/request", {});
    const firstRejection = expect(first).rejects.toThrowError();
    await expect(transport.request("one", "fixture/request", {})).rejects.toThrowError(
      new HostHarnessError("app_server_request_id_duplicate"),
    );
    await transport.abort();
    await firstRejection;
  });

  it("times out and terminates an unresponsive process", async () => {
    const fixture = await fakeProcess("setInterval(() => {}, 1000);");
    const transport = client(fixture.entry, fixture.root, { timeoutMs: 100 });
    await expect(transport.request("one", "fixture/request", {})).rejects.toThrowError(
      new HostHarnessError("app_server_process_timeout"),
    );
    await transport.abort();
  });

  it("fails when a completed protocol process does not exit after EOF", async () => {
    const fixture = await fakeProcess(`
process.stdin.setEncoding("utf8");
process.stdin.on("data", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id:request.id,result:{ok:true}}) + "\\n");
});
process.stdin.on("end", () => setInterval(() => {}, 1000));
`);
    const transport = client(fixture.entry, fixture.root, { closeTimeoutMs: 100 });
    await expect(transport.request("one", "fixture/request", {})).resolves.toEqual({ ok: true });
    await expect(transport.close()).rejects.toThrowError(
      new HostHarnessError("app_server_close_timeout"),
    );
    await transport.abort();
  });

  it("waits for the process tree to be gone before abort returns", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenthawk-jsonl-tree-test-"));
    roots.push(root);
    const marker = join(root, "descendant-ran");
    const pidFile = join(root, "descendant.pid");
    const descendant = join(root, "descendant.mjs");
    const parent = join(root, "parent.mjs");
    await writeFile(
      descendant,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "ran"), 800);`,
      "utf8",
    );
    await writeFile(
      parent,
      `import { spawn } from "node:child_process"; spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const transport = client(parent, root);
    const pending = transport.request("one", "fixture/request", {});
    const pendingRejection = expect(pending).rejects.toThrowError();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        await access(pidFile);
        break;
      } catch {
        await delay(25);
      }
    }
    const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await transport.abort();
    await pendingRejection;
    expect(() => process.kill(descendantPid, 0)).toThrow();
    await delay(1_000);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")(
    "terminates the captured process group after its leader exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "agenthawk-jsonl-orphan-test-"));
      roots.push(root);
      const marker = join(root, "orphan-ran");
      const pidFile = join(root, "orphan.pid");
      const descendant = join(root, "orphan.mjs");
      const parent = join(root, "exited-parent.mjs");
      await writeFile(
        descendant,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "ran"), 800); setInterval(() => {}, 1000);`,
        "utf8",
      );
      await writeFile(
        parent,
        `import { spawn } from "node:child_process"; const child = spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: "ignore" }); child.once("spawn", () => setTimeout(() => process.exit(0), 100));`,
        "utf8",
      );
      const transport = client(parent, root);
      const pending = transport.request("one", "fixture/request", {});
      const pendingRejection = expect(pending).rejects.toThrowError(
        new HostHarnessError("app_server_process_closed_early"),
      );
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await access(pidFile);
          break;
        } catch {
          await delay(25);
        }
      }
      const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      await pendingRejection;
      await transport.abort();
      expect(() => process.kill(descendantPid, 0)).toThrow();
      await delay(1_000);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "treats EPERM as evidence that the process group still exists",
    async () => {
      const fixture = await fakeProcess("setInterval(() => {}, 1000);");
      const transport = client(fixture.entry, fixture.root);
      const pending = transport.request("one", "fixture/request", {});
      const pendingRejection = expect(pending).rejects.toThrowError();
      const originalKill = process.kill;
      let groupProbeCount = 0;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0 && groupProbeCount++ === 0) {
          const error = new Error("operation not permitted");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        return originalKill(pid, signal);
      });
      try {
        await transport.abort();
      } finally {
        killSpy.mockRestore();
      }
      await pendingRejection;
      expect(groupProbeCount).toBeGreaterThan(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when EPERM prevents the process-group kill",
    async () => {
      const fixture = await fakeProcess("setInterval(() => {}, 1000);");
      const transport = client(fixture.entry, fixture.root);
      const pending = transport.request("one", "fixture/request", {});
      const pendingRejection = expect(pending).rejects.toThrowError();
      const originalKill = process.kill;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") {
          const error = new Error("operation not permitted");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        return originalKill(pid, signal);
      });
      try {
        await expect(transport.abort()).rejects.toThrowError(
          new HostHarnessError("app_server_termination_group_kill_failed"),
        );
      } finally {
        killSpy.mockRestore();
      }
      await pendingRejection;
    },
  );

  it.skipIf(process.platform === "win32")(
    "times out fail-closed while a process-group probe remains indeterminate",
    async () => {
      const fixture = await fakeProcess("setInterval(() => {}, 1000);");
      const transport = client(fixture.entry, fixture.root, { terminationGroupTimeoutMs: 25 });
      const pending = transport.request("one", "fixture/request", {});
      const pendingRejection = expect(pending).rejects.toThrowError();
      const originalKill = process.kill;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0) {
          const error = new Error("operation not permitted");
          Object.assign(error, { code: "EPERM" });
          throw error;
        }
        return originalKill(pid, signal);
      });
      try {
        await expect(transport.abort()).rejects.toThrowError(
          new HostHarnessError("app_server_termination_group_timeout"),
        );
      } finally {
        killSpy.mockRestore();
      }
      await pendingRejection;
    },
  );
});

describe("app-server protocol framing", () => {
  it("accepts only object messages without JSON-RPC decoration", () => {
    expect(validateProtocolMessage({ method: "initialized", params: {} })).toEqual({
      method: "initialized",
      params: {},
    });
    expect(() => validateProtocolMessage([])).toThrowError(
      new HostHarnessError("app_server_message_invalid"),
    );
    expect(() => validateProtocolMessage({ jsonrpc: "2.0", id: "one", result: {} })).toThrowError(
      new HostHarnessError("app_server_jsonrpc_field_unexpected"),
    );
  });
});
