import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../scripts/digest-artifact.mjs";
import { NODE_CODE_SAMPLES } from "../../scripts/node-code-samples.mjs";
import { validateRendererReport } from "../../scripts/verify-renderer-report.mjs";
import rendererAttestations from "../fixtures/release/renderer-attestations.json";
import {
  rendererHandoff as handoff,
  rendererHandoffSidecar as handoffSidecar,
  rendererHandoffSource as handoffSource,
  rendererReportFixture,
} from "./renderer-report-fixtures.js";

describe("renderer report validation", () => {
  it("keeps the validator fixture canonical and bound to its detached digest", () => {
    expect(handoffSidecar.toString("utf8")).toBe(`${sha256Hex(handoffSource)}\n`);
    expect(handoff).not.toHaveProperty("digest");
    expect(handoff).not.toHaveProperty("sha256");
    expect(handoff.operations).toHaveLength(56);
    expect(handoff.operations.flatMap(({ samples }) => samples)).toHaveLength(56);
    expect(new Set(handoff.operations.map(({ operationId }) => operationId))).toHaveLength(56);

    for (const { operationId, samples } of handoff.operations) {
      const sample = NODE_CODE_SAMPLES[operationId];
      expect(sample, operationId).toBeDefined();
      expect(samples).toEqual([
        {
          label: sample?.label,
          language: sample?.lang,
          sourceHash: sha256Hex(Buffer.from(sample?.source ?? "", "utf8")),
        },
      ]);
    }
  });

  for (const testCase of rendererAttestations.cases) {
    it(testCase.name, () => {
      const fixture = rendererReportFixture(testCase.mutation);
      const validate = () =>
        validateRendererReport({
          handoffSource,
          handoffSidecar: fixture.handoffSidecar,
          reportSource: fixture.reportSource,
        });

      if (testCase.expectedError === null) {
        expect(validate()).toEqual({
          handoffDigest: sha256Hex(handoffSource),
          operations: 56,
          tabs: 56,
        });
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }
});
