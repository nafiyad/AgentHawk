import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/**/*.ts",
        "packages/cli/src/doctor.ts",
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
