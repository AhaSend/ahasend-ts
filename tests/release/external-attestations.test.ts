import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Hex } from "../../scripts/digest-artifact.mjs";
import { validateExternalAttestations } from "../../scripts/verify-external-attestations.mjs";
import externalAttestations from "../fixtures/release/external-attestations.json";
import {
  rendererHandoffSidecar,
  rendererHandoffSource,
  rendererReportFixture,
  validRendererReport,
} from "./renderer-report-fixtures.js";

const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external attestation validation", () => {
  for (const testCase of externalAttestations.rendererCases) {
    it(testCase.name, () => {
      const fixture = rendererReportFixture(testCase.mutation);
      const validate = () =>
        validateExternalAttestations({
          rendererHandoffSource,
          rendererHandoffSidecar: fixture.handoffSidecar,
          rendererReportSource: fixture.reportSource,
        });

      if (testCase.expectedError === null) {
        expect(validate()).toEqual({
          renderer: {
            handoffDigest: sha256Hex(rendererHandoffSource),
            operations: 56,
            tabs: 56,
          },
        });
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }

  it("runs the shared renderer validator from the external-attestation CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "ahasend-external-attestations-"));
    temporaryDirectories.push(directory);
    const validReportPath = join(directory, "renderer-report.json");
    const staleReportPath = join(directory, "stale-renderer-report.json");
    writeFileSync(validReportPath, canonicalizeJson(validRendererReport()));
    writeFileSync(staleReportPath, rendererReportFixture("staleHandoffDigest").reportSource);

    const valid = spawnSync(
      process.execPath,
      ["scripts/verify-external-attestations.mjs", validReportPath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const stale = spawnSync(
      process.execPath,
      ["scripts/verify-external-attestations.mjs", staleReportPath],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    expect(valid.stderr).toBe("");
    expect(valid.stdout).toContain("renderer report covers 56 operations and 56 tabs");
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toBe("");
    expect(stale.stderr).toContain("stale handoff digest");
  });
});
