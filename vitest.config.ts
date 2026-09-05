import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "scripts/claude-messages-fixture.mjs",
        "packages/core/src/**/*.ts",
        "packages/cli/src/action-evaluation.ts",
        "packages/cli/src/claude-project-hook-format.ts",
        "packages/cli/src/claude-project-hook-invocation.ts",
        "packages/cli/src/claude-project-hook-status.ts",
        "packages/cli/src/claude-project-hook-transaction.ts",
        "packages/cli/src/codex-project-hook-format.ts",
        "packages/cli/src/codex-project-hook-status.ts",
        "packages/cli/src/codex-project-hook-transaction.ts",
        "packages/cli/src/codex-pretooluse.ts",
        "packages/cli/src/doctor.ts",
        "packages/cli/src/hook-json.ts",
        "packages/cli/src/init-content.ts",
        "packages/cli/src/init.ts",
        "packages/cli/src/repository-authority.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
