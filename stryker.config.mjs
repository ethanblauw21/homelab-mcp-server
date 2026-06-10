/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.stryker.config.ts",
  },
  mutate: [
    "src/guardrails/denylist.ts",
    "src/guardrails/pathValidation.ts",
    "src/guardrails/largeChange.ts",
    "src/backup/policy.ts",
    "src/backup/eviction.ts",
    "src/audit/record.ts",
  ],
  reporters: ["clear-text", "progress"],
  coverageAnalysis: "perTest",
  disableTypeChecks: true,
  checkers: [],
  thresholds: {
    high: 90,
    low: 80,
    break: 0,
  },
};
