import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const workflowSource = readFileSync(
  resolve(process.cwd(), ".github/workflows/release.yml"),
  "utf8",
);
const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as Readonly<Record<string, unknown>>;
const liveRunnerSource = readFileSync(
  resolve(process.cwd(), "scripts/run-live-acceptance.mjs"),
  "utf8",
);
const restoreLatestSource = readFileSync(
  resolve(process.cwd(), "scripts/restore-latest.mjs"),
  "utf8",
);
const artifactWorkflowSource = readFileSync(
  resolve(process.cwd(), "scripts/verify-doc-workflows.mjs"),
  "utf8",
);
const integrationSource = readFileSync(
  resolve(process.cwd(), "tests/integration/sdk.integration.test.ts"),
  "utf8",
);
const workflow = yaml.load(workflowSource, { schema: yaml.JSON_SCHEMA }) as unknown;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  return record(value, label) as Record<string, unknown>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function jobSteps(job: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  return array(record(job, label)["steps"], `${label} steps`).map((step, index) =>
    record(step, `${label} step ${index}`),
  );
}

function commands(job: unknown, label: string): string {
  return jobSteps(job, label)
    .map((step) => step["run"])
    .filter((run): run is string => typeof run === "string")
    .join("\n");
}

function namedStep(
  job: unknown,
  jobLabel: string,
  stepName: string,
): Readonly<Record<string, unknown>> {
  const step = jobSteps(job, jobLabel).find((candidate) => candidate["name"] === stepName);
  if (step === undefined) throw new TypeError(`${jobLabel} is missing ${stepName}.`);
  return step;
}

function expectAssertedNpmToolchain(job: unknown, label: string): void {
  const steps = jobSteps(job, label);
  const setupIndex = steps.findIndex((step) =>
    String(step["uses"] ?? "").startsWith("actions/setup-node@"),
  );
  const install = steps[setupIndex + 1];
  const verification = steps[setupIndex + 2];

  expect(setupIndex, `${label} setup-node step`).toBeGreaterThanOrEqual(0);
  expect(install, `${label} npm install step`).toMatchObject({
    name: "Install asserted npm version",
    run: "npm install --global npm@11.12.0",
  });
  expect(verification, `${label} npm version step`).toMatchObject({
    name: "Verify asserted npm version",
    run: 'test "$(npm --version)" = "11.12.0"',
  });
}

const publicationPrerequisites = [
  "source-gate",
  "candidate",
  "artifact-gates",
  "live-gates",
] as const;

function validatePublicationPolicy(workflowValue: unknown): void {
  const jobs = record(record(workflowValue, "workflow")["jobs"], "jobs");
  if (Object.hasOwn(jobs, "external-gates")) {
    throw new TypeError("The release graph must not restore external-gates.");
  }

  const needs = array(
    record(jobs["next-publish"], "next publish")["needs"],
    "next publish prerequisites",
  );
  if (
    needs.length !== publicationPrerequisites.length ||
    publicationPrerequisites.some((name, index) => needs[index] !== name)
  ) {
    throw new TypeError("Publication must retain every required prerequisite.");
  }
  if (record(jobs["candidate"], "candidate")["needs"] !== "source-gate") {
    throw new TypeError("Candidate construction must depend on source gates.");
  }
  if (record(jobs["artifact-gates"], "artifact gates")["needs"] !== "candidate") {
    throw new TypeError("Artifact gates must depend on candidate construction.");
  }
  if (record(jobs["live-gates"], "live gates")["needs"] !== "artifact-gates") {
    throw new TypeError("Live gates must depend directly on artifact gates.");
  }

  const publishSteps = jobSteps(jobs["next-publish"], "next publish");
  const publishIndex = publishSteps.findIndex((step) =>
    String(step["run"] ?? "").includes("npm publish"),
  );
  const validator = publishSteps[publishIndex - 1];
  if (
    publishIndex < 1 ||
    validator?.["name"] !== "Validate exact publication evidence" ||
    !String(validator["run"] ?? "").includes("validateGateReport")
  ) {
    throw new TypeError("Exact gate-report validation must immediately precede publication.");
  }
}

function validateRegistrySmokePolicy(workflowValue: unknown): void {
  const jobs = record(record(workflowValue, "workflow")["jobs"], "jobs");
  const smoke = record(jobs["registry-smoke"], "registry smoke");
  const steps = jobSteps(smoke, "registry smoke");
  if (smoke["needs"] !== "next-publish") {
    throw new TypeError("Registry smoke must consume the published next version.");
  }
  if (smoke["continue-on-error"] !== undefined) {
    throw new TypeError("Registry smoke failures must block promotion.");
  }

  const versionIndex = steps.findIndex((step) => step["name"] === "Verify asserted npm version");
  const downloadIndex = steps.findIndex(
    (step) => step["name"] === "Download the published registry bytes",
  );
  const installIndex = steps.findIndex(
    (step) => step["name"] === "Install the exact registry version in a clean directory",
  );
  const provenanceIndex = steps.findIndex(
    (step) => step["name"] === "Verify registry bytes and npm provenance",
  );
  const esmIndex = steps.findIndex((step) => step["name"] === "Run ESM first-use smoke");
  const cjsIndex = steps.findIndex((step) => step["name"] === "Run CommonJS first-use smoke");
  if (
    versionIndex < 0 ||
    downloadIndex <= versionIndex ||
    installIndex <= downloadIndex ||
    provenanceIndex <= installIndex ||
    esmIndex <= provenanceIndex ||
    cjsIndex <= esmIndex
  ) {
    throw new TypeError(
      "Registry install, provenance, and both first-use checks must run in blocking order.",
    );
  }

  for (const index of [downloadIndex, installIndex, provenanceIndex, esmIndex, cjsIndex]) {
    if (steps[index]?.["continue-on-error"] !== undefined) {
      throw new TypeError("Registry smoke steps must fail normally.");
    }
  }

  const download = String(steps[downloadIndex]?.["run"] ?? "");
  const install = String(steps[installIndex]?.["run"] ?? "");
  const provenance = String(steps[provenanceIndex]?.["run"] ?? "");
  const esm = record(steps[esmIndex], "ESM first-use smoke");
  const cjs = record(steps[cjsIndex], "CommonJS first-use smoke");
  for (const [source, label] of [
    [download, "registry metadata download"],
    [install, "registry installation"],
  ] as const) {
    for (const fragment of [
      'PACKAGE_NAME="$(node -e',
      'PACKAGE_VERSION="$(node -e',
      'test "$PACKAGE_NAME" = "@ahasend/sdk"',
      'PACKAGE="$PACKAGE_NAME@$PACKAGE_VERSION"',
      "for ATTEMPT in 1 2 3 4 5",
      'test "$ATTEMPT" -lt 5',
      "sleep 5",
    ]) {
      if (!source.includes(fragment)) {
        throw new TypeError(`${label} must bind the exact package and use a bounded retry.`);
      }
    }
  }
  if (!download.includes('npm view "$PACKAGE" --json')) {
    throw new TypeError("Registry metadata must be read for the exact next version.");
  }
  if (
    !install.includes("mkdir /tmp/registry-smoke") ||
    !install.includes(
      'npm install --ignore-scripts --save-exact "$PACKAGE" --prefix /tmp/registry-smoke',
    ) ||
    !install.includes("node_modules/@ahasend/sdk/package.json').version") ||
    /npm install[^\n]*(?:\.tgz|TARBALL|\/tmp\/candidate)/u.test(install)
  ) {
    throw new TypeError("Registry smoke must install the exact npm version in a clean directory.");
  }
  if (
    !provenance.includes("npm audit signatures") ||
    !provenance.includes("--prefix /tmp/registry-smoke") ||
    !provenance.includes("verify-provenance.mjs")
  ) {
    throw new TypeError("Registry bytes and npm provenance must be verified before first use.");
  }

  const firstUseRequirements = [
    {
      label: "ESM",
      step: esm,
      fragments: [
        "node --input-type=module <<'NODE'",
        'import { AhaSendClient } from "@ahasend/sdk";',
        "const client = new AhaSendClient({",
        "fetch: stubFetch",
        "await client.ping()",
        "client.domains.list({ limit: 1 }).withResponse()",
        'assert.equal(domains.requestId, "req_registry_esm")',
      ],
    },
    {
      label: "CommonJS",
      step: cjs,
      fragments: [
        "node <<'NODE'",
        'const { AhaSendClient } = require("@ahasend/sdk");',
        "const client = new AhaSendClient({",
        "fetch: stubFetch",
        "await client.ping()",
        "client.domains.list({ limit: 1 }).withResponse()",
        'assert.equal(domains.requestId, "req_registry_cjs")',
      ],
    },
  ] as const;
  for (const requirement of firstUseRequirements) {
    if (requirement.step["working-directory"] !== "/tmp/registry-smoke") {
      throw new TypeError(`${requirement.label} first use must resolve the registry installation.`);
    }
    const source = String(requirement.step["run"] ?? "");
    if (requirement.fragments.some((fragment) => !source.includes(fragment))) {
      throw new TypeError(
        `${requirement.label} first use must construct a client, ping, and inspect a resource response.`,
      );
    }
  }
}

describe("single-run release workflow", () => {
  it("provisions the declared npm executable before every release job uses it", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");

    expect(packageJson["packageManager"]).toBe("npm@11.12.0");
    for (const jobName of [
      "source-gate",
      "candidate",
      "artifact-gates",
      "live-gates",
      "next-publish",
      "registry-smoke",
      "latest-promotion",
      "github-release",
      "release-compensation",
    ]) {
      expectAssertedNpmToolchain(jobs[jobName], jobName);
    }
  });

  it("runs retained installed consumers as a blocking Node 22, 24, and 26 matrix", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const artifact = record(jobs["artifact-gates"], "artifact gates");
    const strategy = record(artifact["strategy"], "artifact strategy");
    const matrix = record(strategy["matrix"], "artifact matrix");
    const setupNode = jobSteps(artifact, "artifact gates").find((step) =>
      String(step["uses"] ?? "").startsWith("actions/setup-node@"),
    );

    expect(artifact["name"]).toBe("Artifact gates (Node ${{ matrix.node }})");
    expect(artifact["continue-on-error"]).toBeUndefined();
    expect(strategy["fail-fast"]).toBe(false);
    expect(matrix["node"]).toEqual([22, 24, 26]);
    expect(record(setupNode, "artifact setup-node")["with"]).toMatchObject({
      "node-version": "${{ matrix.node }}",
    });
    expectAssertedNpmToolchain(artifact, "artifact-gates");
  });

  it("starts from one final tag and advances through promotion before release", () => {
    const root = record(workflow, "workflow");
    const trigger = record(root["on"], "release trigger");
    const push = record(trigger["push"], "release push trigger");
    const jobs = record(root["jobs"], "release jobs");

    expect(push["tags"]).toEqual(["v*"]);
    expect(Object.keys(trigger)).toEqual(["push"]);
    expect(record(root["concurrency"], "release concurrency")).toEqual({
      group: "release",
      "cancel-in-progress": false,
    });
    expect(Object.keys(jobs)).toEqual([
      "source-gate",
      "candidate",
      "artifact-gates",
      "live-gates",
      "next-publish",
      "registry-smoke",
      "latest-promotion",
      "github-release",
      "release-compensation",
    ]);
    expect(record(jobs["candidate"], "candidate")["needs"]).toBe("source-gate");
    expect(record(jobs["artifact-gates"], "artifact")["needs"]).toBe("candidate");
    expect(record(jobs["live-gates"], "live")["needs"]).toBe("artifact-gates");
    expect(record(jobs["next-publish"], "next")["needs"]).toEqual(publicationPrerequisites);
    expect(record(jobs["registry-smoke"], "smoke")["needs"]).toBe("next-publish");
    expect(record(jobs["latest-promotion"], "promotion")["needs"]).toBe("registry-smoke");
    expect(record(jobs["github-release"], "GitHub release")["needs"]).toBe("latest-promotion");
    expect(record(jobs["release-compensation"], "compensation")["needs"]).toEqual([
      "latest-promotion",
      "github-release",
    ]);
  });

  it("does not read or retain external reports", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const sourceReportCreation = String(
      namedStep(jobs["source-gate"], "source gate", "Create detached source report")["run"],
    );
    const gateReportCreation = String(
      namedStep(jobs["live-gates"], "live gates", "Create detached gate report")["run"],
    );
    const sourceReportUpload = jobSteps(jobs["source-gate"], "source gate").find(
      (step) =>
        String(step["uses"] ?? "").startsWith("actions/upload-artifact@") &&
        record(step["with"], "source report upload inputs")["name"] === "source-report",
    );

    expect(jobs).not.toHaveProperty("external-gates");
    expect(workflowSource).not.toContain("RENDERER_REPORT_JSON");
    expect(workflowSource).not.toContain("GO_WEBHOOK_ATTESTATION_JSON");
    expect(workflowSource).not.toContain("renderer-report.json");
    expect(workflowSource).not.toContain("go-webhook-attestation.json");
    expect(workflowSource).not.toContain("verify-external-attestations.mjs");
    expect(sourceReportCreation).toMatch(
      /^mkdir -p \/tmp\/source-report\nnode --input-type=module/u,
    );
    expect(gateReportCreation).toContain('{ name: "artifact", passed: true }');
    expect(gateReportCreation).toContain('{ name: "installed-documentation-links", passed: true }');
    expect(gateReportCreation).toContain('{ name: "documentation-workflows", passed: true }');
    expect(gateReportCreation).toContain('{ name: "live", passed: true }');
    expect(gateReportCreation).not.toContain('{ name: "external", passed: true }');
    expect(
      record(
        record(sourceReportUpload, "source report upload")["with"],
        "source report upload inputs",
      )["path"],
    ).toBe(
      "/tmp/source-report/source-report.json\n" +
        "/tmp/source-report/source-report.sha256\n" +
        "/tmp/source-report/documentation-workflows.json\n" +
        "/tmp/source-report/documentation-workflows.sha256\n",
    );
  });

  it("builds and packs only in candidate creation and never regenerates the artifact", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const candidateCreation = String(
      namedStep(jobs["candidate"], "candidate", "Build and pack the retained candidate")["run"],
    );
    const allCommands = Object.entries(jobs)
      .map(([name, job]) => commands(job, name))
      .join("\n");
    const afterCandidate = Object.entries(jobs)
      .slice(2)
      .map(([name, job]) => commands(job, name))
      .join("\n");

    expect(allCommands.match(/create-candidate\.mjs/gu)).toHaveLength(1);
    expect(candidateCreation).toContain(
      "node scripts/create-candidate.mjs \\\n" +
        "  /tmp/source-report/source-report.json \\\n" +
        "  /tmp/candidate \\\n" +
        "  /tmp/source-report/source-report.sha256",
    );
    expect(allCommands).not.toMatch(/\bnpm run build\b/u);
    expect(allCommands).not.toMatch(/\bnpm pack\b/u);
    expect(afterCandidate).not.toMatch(/create-candidate\.mjs/u);
    expect(afterCandidate).not.toMatch(/from ["'][./]*src\//u);
    expect(commands(jobs["registry-smoke"], "registry smoke")).toContain("verify-provenance.mjs");
    expect(commands(jobs["latest-promotion"], "latest promotion")).toContain("promote-latest.mjs");
    expect(commands(jobs["github-release"], "GitHub release")).toContain("gh release create");
  });

  it("downloads and rechecks one retained checksum before every artifact matrix run", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const artifact = jobs["artifact-gates"];
    const steps = jobSteps(artifact, "artifact gates");
    const downloads = steps
      .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
      .map((step) => record(step["with"], "artifact download inputs"));
    const verification = String(
      namedStep(artifact, "artifact gates", "Verify retained package artifact")["run"],
    );

    expect(downloads).toEqual([
      { name: "candidate-tarball", path: "/tmp/candidate" },
      { name: "candidate-manifest", path: "/tmp/candidate" },
      { name: "source-report", path: "/tmp/source-report" },
    ]);
    expect(verification).toContain('SHA256="$(tr -d \'\\n\' < "$TARBALL.sha256")"');
    expect(verification).toContain("createHash('sha256')");
    expect(verification).toContain(
      'readFileSync(process.argv[1])).digest(\'hex\'))" "$TARBALL")" = "$SHA256"',
    );
    expect(verification).toContain("candidate-manifest.sha256");
    expect(verification).toContain(
      "JSON.parse(require('fs').readFileSync('/tmp/candidate/candidate-manifest.json')).tarballSha256",
    );
  });

  it("runs every retained artifact behavior without rebuilding or repacking", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const artifactCommands = commands(jobs["artifact-gates"], "artifact gates");

    expect(artifactCommands).toContain("node scripts/verify-doc-workflows.mjs --artifact \\");
    expect(artifactCommands).toContain('  "$TARBALL" \\\n  "$SHA256" \\');
    expect(artifactWorkflowSource).toContain(
      'run(process.execPath, [resolve(root, "scripts/verify-package.mjs"), tarball, checksum], root);',
    );
    expect(artifactWorkflowSource).toContain(
      'run(process.execPath, [resolve(root, "scripts/verify-docs.mjs"), tarball, checksum], root);',
    );
    expect(artifactWorkflowSource).toContain('runNpm(["run", "test:integration:tarball"], root, {');
    expect(integrationSource).toContain("const PACKED_EXAMPLE_MATRIX:");
    expect(integrationSource).toContain("expect(PACKED_EXAMPLE_MATRIX).toHaveLength(17)");
    expect(integrationSource).toContain('"--errors",');
    expect(integrationSource).toContain(
      'it("requires --errors to reject the deliberately invalid canary response"',
    );
    expect(integrationSource).toContain("expect(response.status).toBe(500)");
    expect(artifactCommands).not.toMatch(/\bnpm run build\b|\bnpm pack\b|create-candidate\.mjs/u);
  });

  it("runs the real package tests in both release test gates", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const sourceGate = jobs["source-gate"];

    expect(namedStep(sourceGate, "source gate", "Unit test gate")["run"]).toBe(
      "npm run test:unit -- tests/openapi-authoritative-contract.test.ts",
    );
    expect(namedStep(sourceGate, "source gate", "Coverage gate")["run"]).toBe(
      "npm run test:coverage",
    );
  });

  it("validates exact gate evidence in the step immediately before npm publication", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const publishSteps = jobSteps(jobs["next-publish"], "next publish");
    const publishIndex = publishSteps.findIndex((step) =>
      String(step["run"] ?? "").includes("npm publish"),
    );
    const validator = record(publishSteps[publishIndex - 1], "publication validator");
    const validation = String(validator["run"]);

    expect(validator["name"]).toBe("Validate exact publication evidence");
    expect(validation).toContain("validateGateReport({");
    expect(validation).toContain("expectedManifestSha256: sha256Hex(manifestSource)");
    expect(validation).toContain("expectedTarballSha256: sha256Hex(tarballSource)");
    expect(validation).toContain('"installed-documentation-links"');
    expect(validation).toContain('"documentation-workflows"');
    expect(publishSteps[publishIndex]?.["name"]).toBe("Publish the retained bytes with provenance");
    expect(String(publishSteps[publishIndex]?.["run"]).match(/npm publish/gu)).toHaveLength(1);
    expect(() => validatePublicationPolicy(workflow)).not.toThrow();
  });

  it("rejects removal of every explicit publication prerequisite", () => {
    for (const prerequisite of publicationPrerequisites) {
      const mutated = structuredClone(workflow);
      const jobs = mutableRecord(mutableRecord(mutated, "workflow")["jobs"], "jobs");
      const publication = mutableRecord(jobs["next-publish"], "next publish");
      publication["needs"] = publicationPrerequisites.filter((name) => name !== prerequisite);

      expect(() => validatePublicationPolicy(mutated), prerequisite).toThrow(
        "Publication must retain every required prerequisite",
      );
    }
  });

  it("rejects external gates and every bypass of the candidate-to-live chain", () => {
    const external = structuredClone(workflow);
    const externalJobs = mutableRecord(mutableRecord(external, "workflow")["jobs"], "jobs");
    externalJobs["external-gates"] = { needs: "artifact-gates", steps: [] };
    mutableRecord(externalJobs["live-gates"], "live gates")["needs"] = [
      "artifact-gates",
      "external-gates",
    ];
    expect(() => validatePublicationPolicy(external)).toThrow(
      "The release graph must not restore external-gates",
    );

    for (const [jobName, bypass] of [
      ["candidate", "live-gates"],
      ["artifact-gates", "source-gate"],
      ["live-gates", "candidate"],
    ] as const) {
      const mutated = structuredClone(workflow);
      const jobs = mutableRecord(mutableRecord(mutated, "workflow")["jobs"], "jobs");
      mutableRecord(jobs[jobName], jobName)["needs"] = bypass;

      expect(() => validatePublicationPolicy(mutated), jobName).toThrow();
    }
  });

  it("retains and downloads every governed handoff with detached sidecars", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const artifactNames = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .filter((step) => String(step["uses"] ?? "").startsWith("actions/upload-artifact@"))
        .map((step) => record(step["with"], "upload inputs")["name"]),
    );
    const downloads = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
        .map((step) => record(step["with"], "download inputs")["name"]),
    );

    expect(artifactNames).toEqual([
      "source-report",
      "release-tools",
      "candidate-tarball",
      "candidate-manifest",
      "live-report-evidence",
      "gate-report",
      "promotion-state",
    ]);
    for (const name of [
      "source-report",
      "candidate-tarball",
      "candidate-manifest",
      "gate-report",
    ]) {
      expect(downloads, `${name} handoff`).toContain(name);
    }
    expect(workflowSource).toContain("source-report.sha256");
    expect(workflowSource).toContain("*.tgz.sha256");
    expect(workflowSource).toContain("candidate-manifest.sha256");
    expect(workflowSource).toContain("gate-report.sha256");
    expect(workflowSource).toContain("live-report.sha256");
  });

  it("retains failed live evidence without masking failure or authorizing publication", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const liveJob = record(jobs["live-gates"], "live gates");
    const steps = jobSteps(liveJob, "live gates");
    const liveIndex = steps.findIndex((step) => step["name"] === "Run live candidate acceptance");
    const evidenceIndex = steps.findIndex(
      (step) =>
        String(step["uses"] ?? "").startsWith("actions/upload-artifact@") &&
        record(step["with"], "live evidence upload inputs")["name"] === "live-report-evidence",
    );
    const gateCreationIndex = steps.findIndex(
      (step) => step["name"] === "Create detached gate report",
    );
    const gateUploadIndex = steps.findIndex(
      (step) =>
        String(step["uses"] ?? "").startsWith("actions/upload-artifact@") &&
        record(step["with"], "gate report upload inputs")["name"] === "gate-report",
    );
    const live = record(steps[liveIndex], "live acceptance");
    const evidence = record(steps[evidenceIndex], "live evidence upload");
    const gateCreation = record(steps[gateCreationIndex], "gate report creation");
    const gateUpload = record(steps[gateUploadIndex], "gate report upload");

    expect(liveJob["continue-on-error"]).toBeUndefined();
    expect(live["continue-on-error"]).toBeUndefined();
    expect(evidence["if"]).toBe("${{ always() }}");
    expect(record(evidence["with"], "live evidence upload inputs")).toMatchObject({
      name: "live-report-evidence",
      path: "/tmp/gate-report/live-report.json\n" + "/tmp/gate-report/live-report.sha256\n",
      "if-no-files-found": "error",
    });
    expect(gateCreation["if"]).toBe("${{ success() }}");
    expect(gateUpload["if"]).toBe("${{ success() }}");
    expect(liveIndex).toBeLessThan(evidenceIndex);
    expect(evidenceIndex).toBeLessThan(gateCreationIndex);
    expect(gateCreationIndex).toBeLessThan(gateUploadIndex);
  });

  it("executes and validates the complete installed-candidate live report", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const liveCommands = commands(jobs["live-gates"], "live gates");

    expect(liveCommands).toContain("scripts/run-live-acceptance.mjs");
    expect(liveCommands).toContain("/tmp/gate-report/live-report.json");
    expect(liveCommands).toContain("/tmp/gate-report/live-report.sha256");
    expect(liveCommands).toContain("liveReportSha256");
    expect(liveRunnerSource).toContain("validateLiveReportArtifacts");
    expect(liveRunnerSource.match(/await run[A-Z][A-Za-z]+LiveScenarios/gu)).toHaveLength(10);
    expect(liveRunnerSource).toContain("combined.subAccounts.operationResults");
    expect(liveRunnerSource).toContain("combined.subAccountAPIKeys.operationResults");
    expect(liveRunnerSource).toContain(
      'import { AUTHORIZATION_REGISTRY } from "./generate-sdk.mjs";',
    );
    expect(liveRunnerSource).not.toContain("const resourceAuthorization");
    expect(liveRunnerSource).not.toMatch(/from ["'][./]*src\//u);
  });

  it("installs and exercises the exact registry version before promotion", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const smoke = record(jobs["registry-smoke"], "registry smoke");
    const steps = jobSteps(smoke, "registry smoke");
    const install = namedStep(
      smoke,
      "registry smoke",
      "Install the exact registry version in a clean directory",
    );
    const provenanceIndex = steps.findIndex(
      (step) => step["name"] === "Verify registry bytes and npm provenance",
    );
    const esmIndex = steps.findIndex((step) => step["name"] === "Run ESM first-use smoke");
    const cjsIndex = steps.findIndex((step) => step["name"] === "Run CommonJS first-use smoke");

    expectAssertedNpmToolchain(smoke, "registry-smoke");
    expect(String(install["run"])).toContain(
      'npm install --ignore-scripts --save-exact "$PACKAGE" --prefix /tmp/registry-smoke',
    );
    expect(String(install["run"])).not.toMatch(/npm install[^\n]*(?:\.tgz|TARBALL)/u);
    expect(provenanceIndex).toBeLessThan(esmIndex);
    expect(esmIndex).toBeLessThan(cjsIndex);
    expect(record(steps[esmIndex], "ESM smoke")["working-directory"]).toBe("/tmp/registry-smoke");
    expect(record(steps[cjsIndex], "CommonJS smoke")["working-directory"]).toBe(
      "/tmp/registry-smoke",
    );
    expect(record(jobs["latest-promotion"], "latest promotion")["needs"]).toBe("registry-smoke");
    expect(() => validateRegistrySmokePolicy(workflow)).not.toThrow();
  });

  it("rejects a local, unbounded, or non-exact registry installation", () => {
    for (const [label, mutation] of [
      [
        "local tarball",
        (source: string) =>
          source.replace(
            'npm install --ignore-scripts --save-exact "$PACKAGE"',
            'npm install --ignore-scripts --save-exact "$TARBALL"',
          ),
      ],
      [
        "floating tag",
        (source: string) =>
          source.replace(
            'PACKAGE="$PACKAGE_NAME@$PACKAGE_VERSION"',
            'PACKAGE="$PACKAGE_NAME@next"',
          ),
      ],
      [
        "unbounded propagation",
        (source: string) => source.replace('test "$ATTEMPT" -lt 5', "true"),
      ],
    ] as const) {
      const mutated = structuredClone(workflow);
      const jobs = mutableRecord(mutableRecord(mutated, "workflow")["jobs"], "jobs");
      const step = mutableRecord(
        namedStep(
          jobs["registry-smoke"],
          "registry smoke",
          "Install the exact registry version in a clean directory",
        ),
        "registry install",
      );
      step["run"] = mutation(String(step["run"]));

      expect(() => validateRegistrySmokePolicy(mutated), label).toThrow(/registry|bounded/i);
    }
  });

  it("rejects broken ESM and CommonJS first-use coverage", () => {
    for (const [stepName, fragment] of [
      ["Run ESM first-use smoke", 'import { AhaSendClient } from "@ahasend/sdk";'],
      ["Run ESM first-use smoke", "const client = new AhaSendClient({"],
      ["Run ESM first-use smoke", "await client.ping()"],
      ["Run ESM first-use smoke", "client.domains.list({ limit: 1 }).withResponse()"],
      ["Run CommonJS first-use smoke", 'const { AhaSendClient } = require("@ahasend/sdk");'],
      ["Run CommonJS first-use smoke", "const client = new AhaSendClient({"],
      ["Run CommonJS first-use smoke", "await client.ping()"],
      ["Run CommonJS first-use smoke", "client.domains.list({ limit: 1 }).withResponse()"],
    ] as const) {
      const mutated = structuredClone(workflow);
      const jobs = mutableRecord(mutableRecord(mutated, "workflow")["jobs"], "jobs");
      const step = mutableRecord(
        namedStep(jobs["registry-smoke"], "registry smoke", stepName),
        stepName,
      );
      step["run"] = String(step["run"]).replace(fragment, "broken-first-use");

      expect(() => validateRegistrySmokePolicy(mutated), `${stepName}: ${fragment}`).toThrow(
        /first use/i,
      );
    }
  });

  it("stages releases as drafts and compensates promotion and release failures", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const promotionCommands = commands(jobs["latest-promotion"], "latest promotion");
    const releaseCommands = commands(jobs["github-release"], "GitHub release");
    const compensation = record(jobs["release-compensation"], "compensation");
    const compensationCommands = commands(compensation, "compensation");

    expect(promotionCommands).toContain("promotion-state.json");
    expect(promotionCommands).toContain("promote-latest.mjs");
    expect(releaseCommands).toContain("--draft");
    expect(releaseCommands).toContain("gh release edit");
    expect(releaseCommands.indexOf("--draft")).toBeLessThan(
      releaseCommands.indexOf("--draft=false"),
    );
    expect(compensation["if"]).toBe(
      "${{ always() && needs.latest-promotion.result != 'skipped' && (needs.latest-promotion.result != 'success' || needs.github-release.result != 'success') }}",
    );
    expect(promotionCommands).not.toContain("|| true");
    expect(compensationCommands).not.toContain("|| true");
    expect(compensationCommands).not.toContain('if test "$CURRENT_LATEST"');
    expect(compensationCommands).toContain("/tmp/release-tools/scripts/restore-latest.mjs");
    expect(restoreLatestSource).toContain('"dist-tag", "add"');
    expect(restoreLatestSource).toContain('"dist-tag", "rm"');
    expect(restoreLatestSource).toContain('verification: "rollback"');
    expect(compensationCommands).toContain("gh release delete");
  });

  it("re-promotes and verifies latest before every GitHub Release attempt", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const release = record(jobs["github-release"], "GitHub release");
    const releaseCommands = commands(release, "GitHub release");
    const promotionDownloads = jobSteps(jobs["latest-promotion"], "latest promotion")
      .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
      .map((step) => record(step["with"], "download inputs")["name"]);
    const releaseDownloads = jobSteps(release, "GitHub release")
      .filter((step) => String(step["uses"] ?? "").startsWith("actions/download-artifact@"))
      .map((step) => record(step["with"], "download inputs")["name"]);

    expect(release["environment"]).toBe("npm-latest");
    expect(commands(jobs["source-gate"], "source gate")).toContain(
      "cp scripts/promote-latest.mjs /tmp/release-tools/scripts/",
    );
    expect(promotionDownloads).toContain("release-tools");
    expect(releaseDownloads).toContain("release-tools");
    expect(releaseCommands).toContain("promote-latest.mjs");
    expect(releaseCommands.indexOf("promote-latest.mjs")).toBeLessThan(
      releaseCommands.indexOf("gh release create"),
    );
    expect(restoreLatestSource).toContain('verification: "promotion"');
  });

  it("reuses immutable promotion state when latest promotion is retried", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const steps = jobSteps(jobs["latest-promotion"], "latest promotion");
    const reuseIndex = steps.findIndex((step) => step["name"] === "Reuse retained promotion state");
    const captureIndex = steps.findIndex((step) => step["name"] === "Capture the prior latest tag");
    const uploadIndex = steps.findIndex((step) =>
      String(step["uses"] ?? "").startsWith("actions/upload-artifact@"),
    );
    const promoteIndex = steps.findIndex(
      (step) => step["name"] === "Promote only the verified version",
    );
    const reuse = record(steps[reuseIndex], "promotion-state reuse");
    const capture = record(steps[captureIndex], "promotion-state capture");
    const upload = record(steps[uploadIndex], "promotion-state upload");

    expect(reuse["id"]).toBe("retained_promotion_state");
    expect(reuse["continue-on-error"]).toBe(true);
    expect(record(reuse["with"], "promotion-state download inputs")["name"]).toBe(
      "promotion-state",
    );
    expect(capture["if"]).toBe("${{ steps.retained_promotion_state.outcome == 'failure' }}");
    expect(upload["if"]).toBe("${{ steps.retained_promotion_state.outcome == 'failure' }}");
    expect(record(upload["with"], "promotion-state upload inputs")["name"]).toBe("promotion-state");
    expect(record(upload["with"], "promotion-state upload inputs")["overwrite"]).toBeUndefined();
    expect(reuseIndex).toBeLessThan(captureIndex);
    expect(captureIndex).toBeLessThan(uploadIndex);
    expect(uploadIndex).toBeLessThan(promoteIndex);
  });

  it("pins actions and limits publish authority to terminal mutations and compensation", () => {
    const root = record(workflow, "workflow");
    const jobs = record(root["jobs"], "jobs");
    const actionReferences = Object.values(jobs).flatMap((job, jobIndex) =>
      jobSteps(job, `job ${jobIndex}`)
        .map((step) => step["uses"])
        .filter((uses): uses is string => typeof uses === "string"),
    );

    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/u.test(reference))).toBe(true);
    expect(record(root["permissions"], "default permissions")).toEqual({ contents: "read" });
    expect(record(record(jobs["next-publish"], "next")["permissions"], "next permissions")).toEqual(
      { contents: "read", "id-token": "write" },
    );
    expect(
      record(
        record(jobs["github-release"], "GitHub release")["permissions"],
        "release permissions",
      ),
    ).toEqual({ contents: "write" });
    expect(
      record(
        record(jobs["release-compensation"], "compensation")["permissions"],
        "compensation permissions",
      ),
    ).toEqual({ contents: "write" });
  });
});
