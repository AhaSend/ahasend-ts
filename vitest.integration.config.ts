import { defineConfig } from "vitest/config";
import { CommittedTestPolicyReporter } from "./tests/helpers/test-policy-reporter.js";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    allowOnly: false,
    reporters: ["default", new CommittedTestPolicyReporter()],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
