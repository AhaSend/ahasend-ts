import { describe, expect, it } from "vitest";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "../../scripts/digest-artifact.mjs";
import { validateExternalAttestations } from "../../scripts/verify-external-attestations.mjs";
import externalAttestations from "../fixtures/release/external-attestations.json";
import {
  rendererHandoffSidecar,
  rendererHandoffSource,
  rendererReportFixture,
  validRendererReport,
} from "./renderer-report-fixtures.js";
import {
  validGoWebhookAttestation,
  webhookAttestationFixture,
  webhookManifest,
} from "./webhook-attestation-fixtures.js";

describe("external attestation validation", () => {
  for (const testCase of externalAttestations.rendererCases) {
    it(testCase.name, () => {
      const fixture = rendererReportFixture(testCase.mutation);
      const webhook = webhookAttestationFixture("none");
      const validate = () =>
        validateExternalAttestations({
          rendererHandoffSource,
          rendererHandoffSidecar: fixture.handoffSidecar,
          rendererReportSource: fixture.reportSource,
          webhook,
        });

      if (testCase.expectedError === null) {
        expect(validate()).toEqual({
          renderer: {
            handoffDigest: sha256Hex(rendererHandoffSource),
            operations: 56,
            tabs: 56,
          },
          webhooks: {
            manifestDigest: digestJsonArtifact(webhookManifest),
            serverCommit: validGoWebhookAttestation().serverCommit,
            fixtures: 2,
          },
        });
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }

  for (const testCase of externalAttestations.webhookCases) {
    it(testCase.name, () => {
      const webhook = webhookAttestationFixture(testCase.mutation);
      const validate = () =>
        validateExternalAttestations({
          rendererHandoffSource,
          rendererHandoffSidecar,
          rendererReportSource: canonicalizeJson(validRendererReport()),
          webhook,
        });

      if (testCase.expectedError === null) {
        expect(validate().webhooks).toEqual({
          manifestDigest: digestJsonArtifact(webhookManifest),
          serverCommit: validGoWebhookAttestation().serverCommit,
          fixtures: 2,
        });
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }
});
