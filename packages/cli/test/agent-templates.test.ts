import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const workspace = resolve(import.meta.dirname, "../../..");
const templatePaths = [
  "templates/codex/AGENTS.md",
  "templates/claude/CLAUDE.md",
  "templates/cursor/.cursor/rules/agenthawk.mdc",
  "templates/generic/AGENT-INSTRUCTIONS.md",
] as const;

describe("agent integration templates", () => {
  it.each(templatePaths)("keeps %s fail-closed and strict", async (path) => {
    const source = await readFile(join(workspace, path), "utf8");
    expect(source).toContain("agenthawk check npm <exact-package-spec> --strict --format json");
    expect(source).toContain("agenthawk scan --strict --format json");
    expect(source.toLowerCase()).toMatch(/malformed|missing/);
    expect(source.toLowerCase()).toMatch(/human/);
    expect(source.toLowerCase()).toMatch(/not (?:a )?security boundary|enforcement boundary/);
    expect(source).not.toMatch(/dangerously-skip-permissions|--force|npm install/iu);
  });

  it("ships an always-applied, valid Cursor project rule", async () => {
    const source = await readFile(
      join(workspace, "templates/cursor/.cursor/rules/agenthawk.mdc"),
      "utf8",
    );
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(source);
    expect(match).not.toBeNull();
    const metadata = parseDocument(match?.[1] ?? "", { uniqueKeys: true });
    expect(metadata.errors).toEqual([]);
    expect(metadata.toJS()).toEqual({
      description: "Require AgentHawk admission checks before npm dependency changes",
      globs: null,
      alwaysApply: true,
    });
  });

  it("documents every copy destination and the advisory trust boundary", async () => {
    const source = await readFile(join(workspace, "docs/agent-integrations.md"), "utf8");
    for (const path of templatePaths) expect(source).toContain(path);
    expect(source).toContain("Instruction files influence agent behavior");
    expect(source).toContain("protected CI");
  });
});
