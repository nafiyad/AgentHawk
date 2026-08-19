import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const roots: string[] = [];
const workspace = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("AgentHawk workflow", () => {
  it("uses a read-only unprivileged trigger and immutable third-party action pins", async () => {
    const source = await readFile(join(workspace, ".github/workflows/agenthawk.yml"), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    const workflow = document.toJS() as Record<string, unknown>;
    expect(workflow).toMatchObject({ permissions: { contents: "read" } });
    expect(source).toContain("pull_request:");
    expect(source).not.toContain("pull_request_target");
    expect(source).toContain("persist-credentials: false");
    expect(source).not.toMatch(/uses:\s*[^\s@]+@(main|master|v\d+)\s*$/mu);
    expect(source).not.toMatch(/run:[^\n]*\$\{\{\s*github\.event/iu);
  });

  it("isolates optional write permission in a non-executing workflow_run commenter", async () => {
    const source = await readFile(
      join(workspace, ".github/workflows/agenthawk-comment.yml"),
      "utf8",
    );
    const document = parseDocument(source, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    expect(source).toContain("workflow_run:");
    expect(source).toContain("pull-requests: write");
    expect(source).toContain("vars.AGENTHAWK_PR_COMMENT == 'true'");
    expect(source).not.toContain("actions/checkout");
    expect(source).not.toContain("pull_request_target");
    expect(source).not.toMatch(/^\s+run:/mu);
    expect(source).toContain("github-actions[bot]");
    expect(source).toContain("issues.updateComment");
    expect(source).toContain("Untrusted diagnostic:");
    expect(source).not.toContain("github.paginate");
    expect(source).toContain("page <= 5");
  });
});

describe("GitHub summary renderer", () => {
  it("escapes hostile report fields and bounds rendered Markdown", async () => {
    const root = await temporaryRoot();
    const report = join(root, "report.json");
    const summary = join(root, "summary.md");
    await writeFile(
      report,
      JSON.stringify({
        schemaVersion: "1.0",
        verdict: "review<script>",
        changes: Array.from({ length: 64 }, (_, index) => ({
          kind: "added|row",
          name: `bad<script>${index}\u001b[31m`,
          requestedSpec:
            index === 0
              ? "` [injected](https://attacker.invalid)\u0085\u061c\u200e"
              : "x".repeat(2_048),
          section: "dependencies\nheading",
        })),
        findings: [{ ruleId: "PG014", message: "bad </details>|row\nnext" }],
      }),
    );
    await render(report, summary);
    const output = await readFile(summary, "utf8");
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65_537);
    expect(output).toContain("&lt;script&gt;");
    expect(output).toContain("\\|row");
    expect(output).not.toContain("<script>");
    expect(output).toContain("\\\\u001b\\[31m");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("[injected](https://attacker.invalid)");
    expect(output).toContain("\\\\u0085\\\\u061c\\\\u200e");
    expect(output).not.toContain("\u0085");
    expect(output).not.toContain("\nnext");
  });

  it.each([
    ["invalid schema", Buffer.from('{"schemaVersion":"2.0"}')],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["oversized", Buffer.alloc(2_097_153, 0x20)],
  ])("rejects %s without writing a summary", async (_label, content) => {
    const root = await temporaryRoot();
    const report = join(root, "report.json");
    const summary = join(root, "summary.md");
    await writeFile(report, content);
    await expect(render(report, summary)).rejects.toThrow();
    await expect(readFile(summary)).rejects.toThrow();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenthawk-action-"));
  roots.push(root);
  return root;
}

async function render(report: string, summary: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(
      process.execPath,
      [join(workspace, "scripts/render-github-summary.mjs"), report, summary],
      { windowsHide: true },
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}
