import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCandidate,
  validateCandidateManifest,
  validateCleanCommit,
  validatePackagedOperationProfile,
  type CandidateBindings,
  type CandidateCommandRunner,
} from "../../scripts/create-candidate.mjs";
import candidateManifestSchema from "../../scripts/candidate-manifest.schema.json";
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
const validateCandidateSchema = new Ajv({ allErrors: true }).compile(candidateManifestSchema);
const sourceProfile = readFileSync(resolve(repositoryRoot, "src/generated/operation-profile.json"));
const sourceProfileSidecar = readFileSync(
  resolve(repositoryRoot, "src/generated/operation-profile.sha256"),
);
const sourceOperationDescriptors = readFileSync(
  resolve(repositoryRoot, "src/generated/operations.ts"),
);
const openApiSource = readFileSync(resolve(repositoryRoot, "openapi.yaml"));
const documentationGeneratorSource = readFileSync(
  resolve(repositoryRoot, "scripts/generate-docs.mjs"),
  "utf8",
);
const releaseWorkflowSource = readFileSync(
  resolve(repositoryRoot, ".github/workflows/release.yml"),
  "utf8",
);
const authoritativeOpenApiTest = "tests/openapi-authoritative-contract.test.ts";

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

function candidateBindings(bindings: SourceBindings): CandidateBindings {
  return {
    commit: bindings.commit,
    sourceReportSha256: "1".repeat(64),
    contractSha256: structuredClone(bindings.contractSha256),
    captureSha256: bindings.captureSha256,
    keysSha256: structuredClone(bindings.keysSha256),
    profileSha256: bindings.profileSha256,
    tarballSha256: "3".repeat(64),
  };
}

function candidateBytes(bindings: CandidateBindings): Buffer {
  return canonicalizeJson({ version: 1, ...bindings });
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

function candidateRunnerFixture(
  sourceBindings: SourceBindings,
  packResult: unknown,
  packFiles: readonly string[] = ["ahasend-sdk-0.1.0.tgz"],
  mutateDuringBuild?: () => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "ahasend-candidate-test-"));
  temporaryDirectories.push(directory);
  const outputDirectory = join(directory, "candidate");
  const sourceReportPath = join(directory, "source-report.json");
  const sourceSidecarPath = join(directory, "source-report.sha256");
  const sourceReport = reportBytes(validReport(sourceBindings));
  writeFileSync(sourceReportPath, sourceReport);
  writeFileSync(sourceSidecarPath, `${sha256Hex(sourceReport)}\n`);

  const npmCalls: string[][] = [];
  const fakeTarball = Buffer.from("one candidate tarball", "utf8");
  const runner: CandidateCommandRunner = (command, args) => {
    if (command === "git" && args[0] === "rev-parse") return `${sourceBindings.commit}\n`;
    if (command === "git" && args[0] === "status") return "?? .betterborg-task/task.md\n";
    if (command === "git" && args[0] === "ls-files") {
      const result = spawnSync("git", ["ls-files", "-z"], { cwd: repositoryRoot });
      if (result.status !== 0) throw new TypeError(result.stderr.toString("utf8"));
      return result.stdout;
    }
    if (args.includes("build")) {
      npmCalls.push([...args]);
      mutateDuringBuild?.();
      return "";
    }
    if (args.includes("pack")) {
      npmCalls.push([...args]);
      const destination = args[args.indexOf("--pack-destination") + 1];
      if (destination === undefined) throw new TypeError("Missing pack destination");
      for (const filename of packFiles) {
        writeFileSync(join(destination, filename), fakeTarball);
      }
      const output = JSON.stringify(packResult);
      if (output === undefined) throw new TypeError("Pack result is not JSON serializable");
      return output;
    }
    if (command === "tar" && args.at(-1)?.endsWith("operation-profile.json")) {
      return sourceProfile;
    }
    if (command === "tar" && args.at(-1)?.endsWith("operation-profile.sha256")) {
      return sourceProfileSidecar;
    }
    if (command === "tar" && args.at(-1)?.endsWith("dist/index.js")) {
      return sourceOperationDescriptors;
    }
    throw new TypeError(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  return {
    createOptions: {
      sourceReportPath,
      sourceReportSidecarPath: sourceSidecarPath,
      outputDirectory,
      runCommand: runner,
    },
    fakeTarball,
    npmCalls,
    sourceReport,
  };
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("source gate report validation", () => {
  it("retains the authoritative OpenAPI contract test in the release unit gate", () => {
    const trackedTest = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", authoritativeOpenApiTest],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    expect(trackedTest.status, trackedTest.stderr).toBe(0);
    expect(trackedTest.stdout.trim()).toBe(authoritativeOpenApiTest);
    expect(releaseWorkflowSource).toContain(
      `run: npm run test:unit -- ${authoritativeOpenApiTest}`,
    );
  });

  it("does not produce or consume a renderer handoff after sample regeneration", () => {
    expect(documentationGeneratorSource).not.toMatch(/renderer[-A-Za-z]*handoff/iu);
    expect(releaseWorkflowSource).not.toMatch(/renderer[-A-Za-z]*handoff/iu);
  });

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

describe("release candidate validation", () => {
  it("documents the simplified candidate CLI", () => {
    const result = spawnSync(process.execPath, ["scripts/create-candidate.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "create-candidate: Usage: node scripts/create-candidate.mjs <source-report.json> <output-directory> [source-report.sha256]\n",
    );
  });

  it("binds the canonical candidate manifest to its detached sidecar", async () => {
    const sourceBindings = await readRepositorySourceBindings();
    const bindings = candidateBindings(sourceBindings);
    const source = candidateBytes(bindings);
    const sidecar = `${sha256Hex(source)}\n`;

    expect(validateCandidateSchema({ version: 1, ...bindings })).toBe(true);
    expect(JSON.parse(source.toString("utf8"))).not.toHaveProperty("manifestSha256");
    expect(
      validateCandidateManifest({
        manifestSource: source,
        manifestSidecar: sidecar,
        expectedBindings: bindings,
      }),
    ).toEqual({
      commit: bindings.commit,
      manifestDigest: sha256Hex(source),
      tarballDigest: bindings.tarballSha256,
    });
  });

  it("rejects stale candidate linkage, altered sidecars, and embedded self-digests", async () => {
    const sourceBindings = await readRepositorySourceBindings();
    const bindings = candidateBindings(sourceBindings);
    const source = candidateBytes(bindings);
    const sidecar = `${sha256Hex(source)}\n`;
    const staleProfile = { ...bindings, profileSha256: zeroHash };
    const staleSource = candidateBytes(staleProfile);
    const withSelfDigest = canonicalizeJson({
      version: 1,
      ...bindings,
      manifestSha256: zeroHash,
    });

    expect(() =>
      validateCandidateManifest({
        manifestSource: staleSource,
        manifestSidecar: `${sha256Hex(staleSource)}\n`,
        expectedBindings: bindings,
      }),
    ).toThrow("stale operation profile");
    expect(() =>
      validateCandidateManifest({
        manifestSource: source,
        manifestSidecar: `${zeroHash}\n`,
        expectedBindings: bindings,
      }),
    ).toThrow("sidecar mismatch");
    expect(() =>
      validateCandidateManifest({
        manifestSource: withSelfDigest,
        manifestSidecar: `${sha256Hex(withSelfDigest)}\n`,
        expectedBindings: bindings,
      }),
    ).toThrow('unexpected ["manifestSha256"]');
    expect(sidecar).toHaveLength(65);
  });

  it("requires packaged operation metadata to match source and retain all governed facts", () => {
    expect(
      validatePackagedOperationProfile({
        packagedProfileSource: sourceProfile,
        packagedProfileSidecar: sourceProfileSidecar,
        packagedOperationDescriptorsSource: sourceOperationDescriptors,
        sourceProfileSource: sourceProfile,
        sourceProfileSidecar,
        openApiSource,
      }),
    ).toEqual({
      profileDigest: sourceProfileSidecar.toString("utf8").trim(),
      operations: 56,
      iterators: 9,
      resourceAuthorizationRules: 22,
    });

    const transformed = Buffer.from(
      JSON.stringify(JSON.parse(sourceProfile.toString("utf8"))),
      "utf8",
    );
    expect(() =>
      validatePackagedOperationProfile({
        packagedProfileSource: transformed,
        packagedProfileSidecar: sourceProfileSidecar,
        packagedOperationDescriptorsSource: sourceOperationDescriptors,
        sourceProfileSource: sourceProfile,
        sourceProfileSidecar,
        openApiSource,
      }),
    ).toThrow("match generated source bytes exactly");

    const invalidProfile = JSON.parse(sourceProfile.toString("utf8")) as {
      operations: unknown[];
    };
    invalidProfile.operations.pop();
    const invalidProfileSource = Buffer.from(`${JSON.stringify(invalidProfile, null, 2)}\n`);
    const invalidProfileSidecar = `${sha256Hex(canonicalizeJson(invalidProfile))}\n`;
    expect(() =>
      validatePackagedOperationProfile({
        packagedProfileSource: invalidProfileSource,
        packagedProfileSidecar: invalidProfileSidecar,
        packagedOperationDescriptorsSource: sourceOperationDescriptors,
        sourceProfileSource: invalidProfileSource,
        sourceProfileSidecar: invalidProfileSidecar,
        openApiSource,
      }),
    ).toThrow("56 primary mappings");

    const invalidSecurity = Buffer.from(
      openApiSource.toString("utf8").replace("scheme: bearer", "scheme: basic"),
    );
    expect(() =>
      validatePackagedOperationProfile({
        packagedProfileSource: sourceProfile,
        packagedProfileSidecar: sourceProfileSidecar,
        packagedOperationDescriptorsSource: sourceOperationDescriptors,
        sourceProfileSource: sourceProfile,
        sourceProfileSidecar,
        openApiSource: invalidSecurity,
      }),
    ).toThrow("standard HTTP bearer security");

    const missingPackagedSecurity = Buffer.from(
      sourceOperationDescriptors
        .toString("utf8")
        .replace('security: [["messages:send:all"], ["messages:send:{domain}"]]', "security: []"),
      "utf8",
    );
    expect(() =>
      validatePackagedOperationProfile({
        packagedProfileSource: sourceProfile,
        packagedProfileSidecar: sourceProfileSidecar,
        packagedOperationDescriptorsSource: missingPackagedSecurity,
        sourceProfileSource: sourceProfile,
        sourceProfileSidecar,
        openApiSource,
      }),
    ).toThrow("Packaged security metadata for createMessage");

    const descriptorSource = sourceOperationDescriptors.toString("utf8");
    const descriptorStart = descriptorSource.indexOf("export const OPERATION_DESCRIPTORS");
    if (descriptorStart === -1) throw new TypeError("Missing generated operation descriptors");
    const missingPackagedAuthorization = Buffer.from(
      descriptorSource.slice(0, descriptorStart) +
        descriptorSource
          .slice(descriptorStart)
          .replace('global: "messages:read:all"', 'global: "messages:read:altered"'),
      "utf8",
    );
    expect(() =>
      validatePackagedOperationProfile({
        packagedProfileSource: sourceProfile,
        packagedProfileSidecar: sourceProfileSidecar,
        packagedOperationDescriptorsSource: missingPackagedAuthorization,
        sourceProfileSource: sourceProfile,
        sourceProfileSidecar,
        openApiSource,
      }),
    ).toThrow("Packaged resource authorization metadata for getMessages");
  });

  it("rejects dirty or mismatched commits", async () => {
    const bindings = await readRepositorySourceBindings();

    expect(
      validateCleanCommit({
        commit: `${bindings.commit}\n`,
        expectedCommit: bindings.commit,
        status: "?? .betterborg-task/task.md\n",
      }),
    ).toBe(bindings.commit);
    expect(() =>
      validateCleanCommit({
        commit: `${bindings.commit}\n`,
        expectedCommit: "0".repeat(40),
        status: "",
      }),
    ).toThrow("does not match source report commit");
    expect(() =>
      validateCleanCommit({
        commit: `${bindings.commit}\n`,
        expectedCommit: bindings.commit,
        status: " M src/index.ts\n",
      }),
    ).toThrow("requires a clean commit");
    expect(() =>
      validateCleanCommit({
        commit: `${bindings.commit}\n`,
        expectedCommit: bindings.commit,
        status: "?? unexpected-candidate-input.txt\n",
      }),
    ).toThrow("requires a clean commit");
  });

  it("rejects a governed mutation during build before npm pack", async () => {
    const sourceBindings = await readRepositorySourceBindings();
    const openApiPath = resolve(repositoryRoot, "openapi.yaml");
    const originalOpenApi = readFileSync(openApiPath);
    const fixture = candidateRunnerFixture(
      sourceBindings,
      [{ filename: "ahasend-sdk-0.1.0.tgz" }],
      undefined,
      () => {
        writeFileSync(
          openApiPath,
          originalOpenApi.toString("utf8").replace("title: AhaSend API v2", "title: Mutated API"),
        );
      },
    );

    try {
      await expect(createCandidate(fixture.createOptions)).rejects.toThrow(
        "Candidate inputs references a stale openapi.yaml",
      );
      expect(fixture.npmCalls.filter((args) => args.includes("build"))).toHaveLength(1);
      expect(fixture.npmCalls.filter((args) => args.includes("pack"))).toHaveLength(0);
    } finally {
      writeFileSync(openApiPath, originalOpenApi);
    }
  });

  it("rejects a package-source mutation during build before npm pack", async () => {
    const sourceBindings = await readRepositorySourceBindings();
    const sourcePath = resolve(repositoryRoot, "src/index.ts");
    const originalSource = readFileSync(sourcePath);
    const fixture = candidateRunnerFixture(
      sourceBindings,
      [{ filename: "ahasend-sdk-0.1.0.tgz" }],
      undefined,
      () => {
        writeFileSync(sourcePath, Buffer.concat([originalSource, Buffer.from("\n// mutation\n")]));
      },
    );

    try {
      await expect(createCandidate(fixture.createOptions)).rejects.toThrow(
        "Candidate package-source inputs changed during build: src/index.ts",
      );
      expect(fixture.npmCalls.filter((args) => args.includes("build"))).toHaveLength(1);
      expect(fixture.npmCalls.filter((args) => args.includes("pack"))).toHaveLength(0);
    } finally {
      writeFileSync(sourcePath, originalSource);
    }
  });

  for (const testCase of [
    {
      label: "npm 10/11 array JSON",
      packResult: [{ filename: "ahasend-sdk-0.1.0.tgz" }],
    },
    {
      label: "npm 12 keyed-object JSON",
      packResult: { "@ahasend/sdk": { filename: "ahasend-sdk-0.1.0.tgz" } },
    },
  ]) {
    it(`constructs a linked candidate from ${testCase.label}`, async () => {
      const sourceBindings = await readRepositorySourceBindings();
      const fixture = candidateRunnerFixture(sourceBindings, testCase.packResult);
      const result = await createCandidate(fixture.createOptions);

      expect(fixture.npmCalls.filter((args) => args.includes("build"))).toHaveLength(1);
      expect(fixture.npmCalls.filter((args) => args.includes("pack"))).toHaveLength(1);
      expect(readFileSync(result.tarballPath)).toEqual(fixture.fakeTarball);
      const manifestSource = readFileSync(result.manifestPath);
      const manifestSidecar = readFileSync(result.manifestSidecarPath);
      const manifest = JSON.parse(manifestSource.toString("utf8")) as CandidateBindings;
      expect(manifest).toEqual({
        version: 1,
        commit: sourceBindings.commit,
        sourceReportSha256: sha256Hex(fixture.sourceReport),
        contractSha256: sourceBindings.contractSha256,
        captureSha256: sourceBindings.captureSha256,
        keysSha256: sourceBindings.keysSha256,
        profileSha256: sourceBindings.profileSha256,
        tarballSha256: sha256Hex(fixture.fakeTarball),
      });
      expect(manifestSidecar.toString("utf8")).toBe(`${sha256Hex(manifestSource)}\n`);
    });
  }

  for (const testCase of [
    {
      label: "no package",
      packResult: [],
      packFiles: [],
      expectedError: "exactly one package, received 0",
    },
    {
      label: "multiple keyed packages",
      packResult: {
        "@ahasend/sdk": { filename: "ahasend-sdk-0.1.0.tgz" },
        "other-package": { filename: "other-package-1.0.0.tgz" },
      },
      packFiles: ["ahasend-sdk-0.1.0.tgz", "other-package-1.0.0.tgz"],
      expectedError: "exactly one package, received 2",
    },
    {
      label: "a filename absent from the explicit pack destination",
      packResult: [{ filename: "ahasend-sdk-0.1.0.tgz" }],
      packFiles: [],
      expectedError: "existing tarball in the explicit pack destination",
    },
    {
      label: "an unreported tarball in the explicit pack destination",
      packResult: [{ filename: "ahasend-sdk-0.1.0.tgz" }],
      packFiles: ["ahasend-sdk-0.1.0.tgz", "unreported-1.0.0.tgz"],
      expectedError: "exactly one npm pack tarball, received 2",
    },
  ]) {
    it(`rejects npm pack output with ${testCase.label}`, async () => {
      const sourceBindings = await readRepositorySourceBindings();
      const fixture = candidateRunnerFixture(
        sourceBindings,
        testCase.packResult,
        testCase.packFiles,
      );

      await expect(createCandidate(fixture.createOptions)).rejects.toThrow(testCase.expectedError);
    });
  }
});
