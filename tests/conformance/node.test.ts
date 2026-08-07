import { describe, expect, it } from "vitest";
import { CONFORMANCE_CASES, runConformanceCase } from "./suite.js";

const COMPLETION_TIMEOUT_MS = 5_000;

describe("web-globals conformance", () => {
  for (const testCase of CONFORMANCE_CASES) {
    it(
      testCase.name,
      async () => {
        const outcome = await runConformanceCase(testCase);
        expect(outcome).toEqual({ name: testCase.name, status: "passed" });
        expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
      },
      COMPLETION_TIMEOUT_MS,
    );
  }
});
