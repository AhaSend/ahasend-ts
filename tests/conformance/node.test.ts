import { describe, expect, it } from "vitest";
import { CONFORMANCE_CASES, runConformanceCase } from "./suite.js";

describe("web-globals conformance", () => {
  it.each(CONFORMANCE_CASES)("$name", async (testCase) => {
    const outcome = await runConformanceCase(testCase);
    expect(outcome).toEqual({ name: testCase.name, status: "passed" });
    expect(JSON.parse(JSON.stringify(outcome))).toEqual(outcome);
  });
});
