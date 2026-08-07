import { defineConfig } from "vitest/config";
import { CommittedTestPolicyReporter } from "./tests/helpers/test-policy-reporter.js";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "tests/conformance/workerd.test.ts"],
    allowOnly: false,
    reporters: ["default", new CommittedTestPolicyReporter()],
    testTimeout: 10_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/index.ts", "src/**/*.d.ts", "src/types/**", "src/webhooks/events.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 85,
        branches: 80,
      },
    },
  },
});
