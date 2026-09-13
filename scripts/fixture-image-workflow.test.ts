import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// Use the already pinned CLI YAML dependency; add no workflow-test dependency.
const require = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const yaml = require("yaml") as {
  parseDocument(
    text: string,
    options: { uniqueKeys: boolean },
  ): {
    errors: unknown[];
    toJS(): unknown;
  };
};
type Workflow = {
  name: string;
  on: { pull_request: { paths: string[] }; push: { branches: string[]; paths: string[] } };
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      name: string;
      "runs-on": string;
      "timeout-minutes": number;
      steps: Array<{
        name: string;
        uses?: string;
        with?: Record<string, unknown>;
        shell?: string;
        run?: string;
      }>;
    }
  >;
};

function workflow(): Workflow {
  const parsed = yaml.parseDocument(
    readFileSync(new URL("../.github/workflows/fixture-image-layers.yml", import.meta.url), "utf8"),
    { uniqueKeys: true },
  );
  expect(parsed.errors).toEqual([]);
  return parsed.toJS() as Workflow;
}

describe("fixed layer hosted verification boundary", () => {
  it("uses only unprivileged PR/main triggers and identical relevant path filters", () => {
    const value = workflow();
    expect(Object.keys(value).sort()).toEqual(["jobs", "name", "on", "permissions"]);
    expect(Object.keys(value.on).sort()).toEqual(["pull_request", "push"]);
    expect(value.on.push.branches).toEqual(["main"]);
    expect(value.permissions).toEqual({ contents: "read" });
    expect(value.on.pull_request.paths).toEqual(value.on.push.paths);
    expect(value.on.push.paths).toEqual([
      ".github/workflows/fixture-image-layers.yml",
      "scripts/fixture-image-*.mjs",
      "scripts/fixture-image-*.test.ts",
      "scripts/verify-fixture-image-layers.mjs",
      "scripts/verify-fixture-image-layers.test.ts",
      "scripts/fixtures/image-base-metadata.mjs",
      "scripts/claude-artifact-storage.mjs",
      "scripts/claude-artifact-storage.test.ts",
    ]);
  });

  it("pins actions, checks exact source, and has no cache, upload or privileged step", () => {
    const value = workflow();
    expect(Object.keys(value.jobs)).toEqual(["fixed-layer-bytes"]);
    const job = value.jobs["fixed-layer-bytes"];
    expect(Object.keys(job).sort()).toEqual(["name", "runs-on", "steps", "timeout-minutes"]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.steps).toHaveLength(3);
    expect(job.steps[0]).toEqual({
      name: "Check out exact source without retained credentials",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: `\${{ github.event.pull_request.head.sha || github.sha }}`,
        "persist-credentials": false,
      },
    });
    expect(job.steps[1]).toEqual({
      name: "Set up Node.js without package caching",
      uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      with: { "node-version": 24, architecture: "x64", "package-manager-cache": false },
    });
  });

  it("guards hosted destination inputs and clears ambient process configuration", () => {
    const step = workflow().jobs["fixed-layer-bytes"].steps[2];
    expect(Object.keys(step).sort()).toEqual(["name", "run", "shell"]);
    expect(step.shell).toBe("bash");
    const run = step.run ?? "";
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain(`"\${RUNNER_ENVIRONMENT:-}" != "github-hosted"`);
    expect(run).toContain(`"\${RUNNER_OS:-}" != "Linux"`);
    expect(run).toContain(`"\${RUNNER_ARCH:-}" != "X64"`);
    expect(run).toContain(`! "\${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$`);
    expect(run).toContain(`! "\${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]{0,19}$`);
    expect(run).toContain(`"\${RUNNER_TEMP:-}" != /*`);
    expect(run).toContain("umask 077");
    expect(run).toContain('exec env -i PATH="$PATH" LANG=C LC_ALL=C');
    expect(run).toContain("node scripts/verify-fixture-image-layers.mjs");
    expect(run).toContain(
      `"$RUNNER_TEMP/agenthawk-image-layers-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"`,
    );
    const commands = run
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(commands).not.toMatch(/\$\{\{|\b(?:sudo|docker|curl|wget|npm|pnpm|yarn|tar|unzip|rm)\b/);
    // Any added command must receive explicit review, not merely evade a denylist.
    expect(commands).toBe(`set -euo pipefail
if [[ "\${RUNNER_ENVIRONMENT:-}" != "github-hosted" || "\${RUNNER_OS:-}" != "Linux" || "\${RUNNER_ARCH:-}" != "X64" ]]; then
  printf '%s\\n' 'Refusing an unsupported runner.' >&2
  exit 1
fi
if [[ ! "\${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]{0,19}$ || ! "\${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]{0,19}$ || "\${RUNNER_TEMP:-}" != /* ]]; then
  printf '%s\\n' 'Refusing an invalid temporary destination.' >&2
  exit 1
fi
umask 077
exec env -i PATH="$PATH" LANG=C LC_ALL=C \\
  node scripts/verify-fixture-image-layers.mjs \\
  "$RUNNER_TEMP/agenthawk-image-layers-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"
`);
  });
});
