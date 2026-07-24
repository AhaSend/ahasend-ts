import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Hex } from "../../scripts/digest-artifact.mjs";
import { validateExternalAttestations } from "../../scripts/verify-external-attestations.mjs";
import externalAttestations from "../fixtures/release/external-attestations.json";

interface Sample {
  label: string;
  language: string;
  sourceHash: string;
}

interface HandoffOperation {
  operationId: string;
  samples: Sample[];
}

interface RendererHandoff {
  version: number;
  restDigest: string;
  operations: HandoffOperation[];
}

interface ReportOperation {
  operationId: string;
  tabs: Sample[];
}

interface RendererReport {
  version: number;
  handoffDigest: string;
  restDigest: string;
  operations: ReportOperation[];
}

const repositoryRoot = process.cwd();
const rendererHandoffSource = readFileSync(resolve(repositoryRoot, "docs/renderer-handoff.json"));
const rendererHandoffSidecar = readFileSync(
  resolve(repositoryRoot, "docs/renderer-handoff.sha256"),
);
const rendererHandoff = JSON.parse(rendererHandoffSource.toString("utf8")) as RendererHandoff;
const temporaryDirectories: string[] = [];

function validRendererReport(): RendererReport {
  return {
    version: 1,
    handoffDigest: sha256Hex(rendererHandoffSource),
    restDigest: rendererHandoff.restDigest,
    operations: rendererHandoff.operations.map(({ operationId, samples }) => ({
      operationId,
      tabs: structuredClone(samples),
    })),
  };
}

function requireOperation(report: RendererReport, index: number): ReportOperation {
  const operation = report.operations[index];
  if (operation === undefined) throw new TypeError(`Missing fixture operation ${index}`);
  return operation;
}

function requireTab(operation: ReportOperation, index: number): Sample {
  const tab = operation.tabs[index];
  if (tab === undefined) throw new TypeError(`Missing fixture tab ${index}`);
  return tab;
}

function rendererFixture(mutation: string): {
  rendererReportSource: Buffer;
  rendererHandoffSidecar: Buffer | string;
} {
  const report = validRendererReport();
  let handoffSidecar: Buffer | string = rendererHandoffSidecar;

  switch (mutation) {
    case "none":
      break;
    case "staleHandoffDigest":
      report.handoffDigest = "0".repeat(64);
      break;
    case "missingOperation":
      report.operations.pop();
      break;
    case "duplicateOperation":
      report.operations[report.operations.length - 1] = structuredClone(
        requireOperation(report, 0),
      );
      break;
    case "missingTab":
      requireOperation(report, 0).tabs.pop();
      break;
    case "noncanonicalTab":
      requireTab(requireOperation(report, 0), 0).label = "JavaScript / TypeScript";
      break;
    case "sourceHashDrift":
      requireTab(requireOperation(report, 0), 0).sourceHash = "0".repeat(64);
      break;
    case "noncanonicalPayload":
      return {
        rendererReportSource: Buffer.from(JSON.stringify(report, null, 2), "utf8"),
        rendererHandoffSidecar: handoffSidecar,
      };
    case "sidecarMismatch":
      handoffSidecar = `${"0".repeat(64)}\n`;
      break;
    default:
      throw new TypeError(`Unknown external attestation fixture mutation ${mutation}`);
  }

  return {
    rendererReportSource: canonicalizeJson(report),
    rendererHandoffSidecar: handoffSidecar,
  };
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("external attestation validation", () => {
  for (const testCase of externalAttestations.rendererCases) {
    it(testCase.name, () => {
      const fixture = rendererFixture(testCase.mutation);
      const validate = () =>
        validateExternalAttestations({
          rendererHandoffSource,
          rendererHandoffSidecar: fixture.rendererHandoffSidecar,
          rendererReportSource: fixture.rendererReportSource,
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
    writeFileSync(staleReportPath, rendererFixture("staleHandoffDigest").rendererReportSource);

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
