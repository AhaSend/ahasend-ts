import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeJson, sha256Hex } from "../../scripts/digest-artifact.mjs";
import {
  readRepositorySourceBindings,
  REQUIRED_SOURCE_GATES,
  validateSourceGateReport,
  type SourceBindings,
} from "../../scripts/run-source-gates.mjs";
import sourceGateReportSchema from "../../scripts/source-gate-report.schema.json";
import sourceGateReports from "../fixtures/release/source-gate-reports.json";

interface GateResult {
  name: string;
  passed: boolean;
}

interface SourceGateReport {
  version: number;
  commit: string;
  contractSha256: Record<string, string>;
  profileSha256: string;
  captureSha256: string;
  keysSha256: Record<string, string>;
  lockfileSha256: string;
  auditPolicySha256: string;
  results: GateResult[];
  reportSha256?: string;
}

const repositoryRoot = process.cwd();
const temporaryDirectories: string[] = [];
const zeroHash = "0".repeat(64);
const validateSourceGateSchema = new Ajv({ allErrors: true }).compile(sourceGateReportSchema);

function validReport(bindings: SourceBindings): SourceGateReport {
  return {
    version: 1,
    ...structuredClone(bindings),
    results: REQUIRED_SOURCE_GATES.map((name) => ({ name, passed: true })),
  };
}

function requireGate(report: SourceGateReport, name: string): GateResult {
  const result = report.results.find((candidate) => candidate.name === name);
  if (result === undefined) throw new TypeError(`Missing fixture gate ${name}`);
  return result;
}

function reportBytes(report: SourceGateReport): Buffer {
  return canonicalizeJson(report);
}

function mutateFixture(
  bindings: SourceBindings,
  mutation: string,
): { reportSource: Buffer; reportSidecar: string } {
  const report = validReport(bindings);
  let source: Buffer;
  let sidecar: string;

  switch (mutation) {
    case "none":
      break;
    case "wrongCommit":
      report.commit = "0".repeat(40);
      break;
    case "failedAudit":
      requireGate(report, "audit").passed = false;
      break;
    case "staleProfile":
      report.profileSha256 = zeroHash;
      break;
    case "reportSelfDigest":
      report.reportSha256 = zeroHash;
      break;
    case "genericSelfDigest": {
      const validSource = reportBytes(report).toString("utf8");
      source = Buffer.from(
        validSource.replace(
          '"profileSha256"',
          `"metadata":{"sha256":"${zeroHash}"},"profileSha256"`,
        ),
        "utf8",
      );
      return { reportSource: source, reportSidecar: `${sha256Hex(source)}\n` };
    }
    case "duplicateGate":
      report.results[report.results.length - 1] = {
        name: "generation",
        passed: true,
      };
      break;
    case "noncanonicalReport":
      source = Buffer.from(JSON.stringify(report, null, 2), "utf8");
      return { reportSource: source, reportSidecar: `${sha256Hex(source)}\n` };
    case "alteredSidecar":
      source = reportBytes(report);
      return { reportSource: source, reportSidecar: `${zeroHash}\n` };
    default:
      throw new TypeError(`Unknown source gate fixture mutation ${mutation}`);
  }

  source = reportBytes(report);
  sidecar = `${sha256Hex(source)}\n`;
  return { reportSource: source, reportSidecar: sidecar };
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("source gate report validation", () => {
  it("keeps the schema aligned with the importable validator", async () => {
    const bindings = await readRepositorySourceBindings();
    const report = validReport(bindings);

    expect(validateSourceGateSchema(report), JSON.stringify(validateSourceGateSchema.errors)).toBe(
      true,
    );
    expect(report).not.toHaveProperty("reportSha256");
    expect(REQUIRED_SOURCE_GATES).toEqual(sourceGateReports.missingGateCases);
  });

  for (const testCase of sourceGateReports.cases) {
    it(testCase.name, async () => {
      const bindings = await readRepositorySourceBindings();
      const fixture = mutateFixture(bindings, testCase.mutation);
      const validate = () =>
        validateSourceGateReport({
          ...fixture,
          expectedBindings: bindings,
        });

      if (testCase.expectedError === null) {
        expect(validate()).toEqual({
          commit: bindings.commit,
          reportDigest: sha256Hex(fixture.reportSource),
          gates: REQUIRED_SOURCE_GATES.length,
        });
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }

  for (const [gateIndex, missingGate] of sourceGateReports.missingGateCases.entries()) {
    it(`rejects a missing ${missingGate} gate`, async () => {
      const bindings = await readRepositorySourceBindings();
      const report = validReport(bindings);
      report.results = report.results.filter(({ name }) => name !== missingGate);
      const source = reportBytes(report);

      expect(() =>
        validateSourceGateReport({
          reportSource: source,
          reportSidecar: `${sha256Hex(source)}\n`,
          expectedBindings: bindings,
        }),
      ).toThrow(`missing required gates: ${missingGate}`);
      expect(validateSourceGateSchema(report)).toBe(false);
      expect(validateSourceGateSchema.errors).toContainEqual(
        expect.objectContaining({
          keyword: "contains",
          schemaPath: `#/properties/results/allOf/${gateIndex}/contains`,
        }),
      );
    });
  }

  it("rejects missing, duplicate, and failed results through the JSON schema", async () => {
    const bindings = await readRepositorySourceBindings();
    const validateSchema = new Ajv({ allErrors: true }).compile(sourceGateReportSchema);
    const missing = validReport(bindings);
    missing.results.pop();
    const duplicate = validReport(bindings);
    duplicate.results[duplicate.results.length - 1] = structuredClone(duplicate.results[0]!);
    const failed = validReport(bindings);
    requireGate(failed, "audit").passed = false;

    expect(validateSchema(missing)).toBe(false);
    expect(validateSchema(duplicate)).toBe(false);
    expect(validateSchema(failed)).toBe(false);
  });

  it("binds every governed source digest", async () => {
    const bindings = await readRepositorySourceBindings();
    const mutations: Array<[string, (report: SourceGateReport) => void]> = [
      [
        "contracts.lock.json",
        (report) => (report.contractSha256["contracts.lock.json"] = zeroHash),
      ],
      ["openapi.yaml", (report) => (report.contractSha256["openapi.yaml"] = zeroHash)],
      ["webhooks.yaml", (report) => (report.contractSha256["webhooks.yaml"] = zeroHash)],
      ["capture manifest", (report) => (report.captureSha256 = zeroHash)],
      [
        "contracts/webhooks/captured/keys/configured-webhook.key",
        (report) =>
          (report.keysSha256["contracts/webhooks/captured/keys/configured-webhook.key"] = zeroHash),
      ],
      [
        "contracts/webhooks/captured/keys/route.key",
        (report) => (report.keysSha256["contracts/webhooks/captured/keys/route.key"] = zeroHash),
      ],
      ["package lockfile", (report) => (report.lockfileSha256 = zeroHash)],
      ["audit policy", (report) => (report.auditPolicySha256 = zeroHash)],
    ];

    for (const [label, mutate] of mutations) {
      const report = validReport(bindings);
      mutate(report);
      const source = reportBytes(report);
      expect(
        () =>
          validateSourceGateReport({
            reportSource: source,
            reportSidecar: `${sha256Hex(source)}\n`,
            expectedBindings: bindings,
          }),
        label,
      ).toThrow(`stale ${label}`);
    }
  });

  it("checks the detached digest before attempting to parse the report", async () => {
    const bindings = await readRepositorySourceBindings();

    expect(() =>
      validateSourceGateReport({
        reportSource: Buffer.from("{", "utf8"),
        reportSidecar: `${zeroHash}\n`,
        expectedBindings: bindings,
      }),
    ).toThrow("sidecar mismatch");
  });

  it("uses the importable validator from the CLI", async () => {
    const bindings = await readRepositorySourceBindings();
    const source = reportBytes(validReport(bindings));
    const directory = mkdtempSync(join(tmpdir(), "ahasend-source-gates-"));
    temporaryDirectories.push(directory);
    const reportPath = join(directory, "source-report.json");
    const sidecarPath = join(directory, "source-report.sha256");
    writeFileSync(reportPath, source);
    writeFileSync(sidecarPath, `${sha256Hex(source)}\n`);

    const result = spawnSync(process.execPath, ["scripts/run-source-gates.mjs", reportPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      `Source gate report passed: ${REQUIRED_SOURCE_GATES.length} gates for ${bindings.commit}`,
    );
  });
});
