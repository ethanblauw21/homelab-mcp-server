import { defineConfig } from "vitest/config";

// Minimal vitest config for Stryker mutation testing — unit tests only, no integration.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts"],
    environment: "node",
  },
});
