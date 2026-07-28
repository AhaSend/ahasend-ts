import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalizeJson, sha256Hex } from "../../scripts/digest-artifact.mjs";

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

export const rendererHandoffSource = readFileSync(
  resolve(process.cwd(), "docs/renderer-handoff.json"),
);
export const rendererHandoffSidecar = readFileSync(
  resolve(process.cwd(), "docs/renderer-handoff.sha256"),
);
export const rendererHandoff = JSON.parse(
  rendererHandoffSource.toString("utf8"),
) as RendererHandoff;

export function validRendererReport(): RendererReport {
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

export function rendererReportFixture(mutation: string): {
  reportSource: Buffer;
  handoffSidecar: Buffer | string;
} {
  const report = validRendererReport();
  let handoffSidecar: Buffer | string = rendererHandoffSidecar;

  switch (mutation) {
    case "none":
      break;
    case "staleHandoffDigest":
      report.handoffDigest = "0".repeat(64);
      break;
    case "staleRestDigest":
      report.restDigest = "0".repeat(64);
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
    case "duplicateTab": {
      const operation = requireOperation(report, 0);
      operation.tabs.push(structuredClone(requireTab(operation, 0)));
      break;
    }
    case "noncanonicalTab":
      requireTab(requireOperation(report, 0), 0).label = "JavaScript / TypeScript";
      break;
    case "sourceHashDrift":
    case "sourceHashMismatch":
      requireTab(requireOperation(report, 0), 0).sourceHash = "0".repeat(64);
      break;
    case "noncanonicalPayload":
      return {
        reportSource: Buffer.from(JSON.stringify(report, null, 2), "utf8"),
        handoffSidecar,
      };
    case "sidecarMismatch":
      handoffSidecar = `${"0".repeat(64)}\n`;
      break;
    default:
      throw new TypeError(`Unknown renderer fixture mutation ${mutation}`);
  }

  return { reportSource: canonicalizeJson(report), handoffSidecar };
}
