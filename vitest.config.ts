import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
          environment: "node",
          coverage: {
            provider: "v8",
            include: ["src/guardrails/**", "src/backup/**", "src/audit/**"],
            thresholds: {
              lines: 90,
              branches: 90,
            },
          },
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          exclude: [],
          environment: "node",
          globalSetup: ["src/test/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
