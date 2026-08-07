import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  readonly packageManager: string;
  readonly scripts: Readonly<Record<string, string>>;
};
const workflow = yaml.load(
  readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  { schema: yaml.JSON_SCHEMA },
) as unknown;
const releaseWorkflow = yaml.load(
  readFileSync(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  { schema: yaml.JSON_SCHEMA },
) as unknown;
const packagePreflightSource = readFileSync(
  resolve(repositoryRoot, "scripts/create-preflight-pack.mjs"),
  "utf8",
);
const documentationPreflightSource = readFileSync(
  resolve(repositoryRoot, "scripts/create-docs-preflight-pack.mjs"),
  "utf8",
);
const ordinaryVitestConfigSource = readFileSync(
  resolve(repositoryRoot, "vitest.config.ts"),
  "utf8",
);

const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const SETUP_DENO_ACTION = "denoland/setup-deno@667a34cdef165d8d2b2e98dde39547c9daac7282";
const SETUP_BUN_ACTION = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function expectAssertedNpmToolchain(job: unknown, label: string): void {
  const steps = array(record(job, label)["steps"], `${label} steps`).map((step, index) =>
    record(step, `${label} step ${index}`),
  );
  const setupIndex = steps.findIndex((step) =>
    String(step["uses"] ?? "").startsWith("actions/setup-node@"),
  );

  expect(setupIndex, `${label} setup-node step`).toBeGreaterThanOrEqual(0);
  expect(steps[setupIndex + 1], `${label} npm install step`).toMatchObject({
    name: "Install asserted npm version",
    run: "npm install --global npm@11.12.0",
  });
  expect(steps[setupIndex + 2], `${label} npm version step`).toMatchObject({
    name: "Verify asserted npm version",
    run: 'test "$(npm --version)" = "11.12.0"',
  });
}

function steps(job: unknown, label: string): readonly Readonly<Record<string, unknown>>[] {
  return array(record(job, label)["steps"], `${label} steps`).map((step, index) =>
    record(step, `${label} step ${index}`),
  );
}

function namedStep(
  job: unknown,
  jobLabel: string,
  stepName: string,
): Readonly<Record<string, unknown>> {
  const step = steps(job, jobLabel).find((candidate) => candidate["name"] === stepName);
  if (step === undefined) throw new TypeError(`${jobLabel} is missing ${stepName}.`);
  return step;
}

function actionStep(
  job: unknown,
  jobLabel: string,
  actionRepository: string,
): Readonly<Record<string, unknown>> {
  const step = steps(job, jobLabel).find((candidate) =>
    String(candidate["uses"] ?? "").startsWith(`${actionRepository}@`),
  );
  if (step === undefined) throw new TypeError(`${jobLabel} is missing ${actionRepository}.`);
  return step;
}

function expectBlockingJob(job: unknown, label: string): void {
  const jobRecord = record(job, label);
  expect(jobRecord["continue-on-error"], `${label} continue-on-error`).toBeUndefined();
  expect(jobRecord["if"], `${label} condition`).toBeUndefined();
  for (const [index, step] of steps(job, label).entries()) {
    expect(step["continue-on-error"], `${label} step ${index} continue-on-error`).toBeUndefined();
    expect(step["if"], `${label} step ${index} condition`).toBeUndefined();
  }
}

function expectNode22Toolchain(job: unknown, label: string): void {
  expect(actionStep(job, label, "actions/setup-node")).toMatchObject({
    uses: SETUP_NODE_ACTION,
    with: { "node-version": 22, cache: "npm" },
  });
  expectAssertedNpmToolchain(job, label);
  expect(namedStep(job, label, "Install dependencies")).toMatchObject({ run: "npm ci" });
}

function expectCandidateTarball(job: unknown, label: string): void {
  const pack = namedStep(job, label, "Build candidate tarball");
  const command = String(pack["run"] ?? "");

  expect(pack["id"]).toBe("pack");
  expect(pack["continue-on-error"]).toBeUndefined();
  expect(command).toContain("npm run build");
  expect(command).toContain(
    'npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP/ahasend-runtime-smoke"',
  );
  expect(command).toContain("-type f -name '*.tgz'");
  expect(command).toContain('echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"');
}

function expectMaintainedRuntimeGates(
  scripts: Readonly<Record<string, string>>,
  candidateWorkflow: unknown,
): void {
  const jobs = record(record(candidateWorkflow, "CI workflow")["jobs"], "CI jobs");
  const testJob = record(jobs["test"], "Node test job");
  const strategy = record(testJob["strategy"], "Node test strategy");
  const matrix = record(strategy["matrix"], "Node test matrix");

  expect(array(matrix["include"], "Node matrix includes")).toEqual([
    { node: 22, experimental: false },
    { node: 24, experimental: false },
    { node: 26, experimental: true },
  ]);
  expect(testJob["continue-on-error"]).toBe("${{ matrix.experimental }}");
  expect(testJob["if"], "Node test job condition").toBeUndefined();
  expect(strategy["fail-fast"]).toBe(false);
  const nodeGate = namedStep(
    testJob,
    "Node test job",
    "Required source gates and packed preflights",
  );
  expect(nodeGate).toMatchObject({ run: "npm run ci" });
  expect(nodeGate["if"], "Node required gate condition").toBeUndefined();
  expect(nodeGate["continue-on-error"], "Node required gate continue-on-error").toBeUndefined();
  expect(scripts["ci"]?.split(" && ")).toContain("npm test");
  expect(scripts["test"]).toBe(
    "npm run test:policy && vitest run --exclude 'tests/test-policy.test.ts'",
  );
  expect(ordinaryVitestConfigSource).toContain(
    'exclude: ["tests/integration/**", "tests/conformance/workerd.test.ts"]',
  );

  const coverageJob = jobs["coverage"];
  expect(record(coverageJob, "coverage job")).toMatchObject({
    name: "Coverage thresholds",
    "runs-on": "ubuntu-latest",
  });
  expectBlockingJob(coverageJob, "coverage job");
  expectNode22Toolchain(coverageJob, "coverage job");
  expect(
    namedStep(coverageJob, "coverage job", "Coverage (thresholds enforced in vitest.config.ts)"),
  ).toMatchObject({ run: "npm run test:coverage" });

  const workerdJob = jobs["workerd"];
  expect(record(workerdJob, "workerd job")).toMatchObject({
    name: "workerd shared conformance (no nodejs_compat)",
    "runs-on": "ubuntu-latest",
  });
  expectBlockingJob(workerdJob, "workerd job");
  expectNode22Toolchain(workerdJob, "workerd job");
  expect(scripts["test:conformance:workerd"]).toBe("vitest run --config vitest.workerd.config.ts");
  expect(namedStep(workerdJob, "workerd job", "Run maintained workerd conformance")).toMatchObject({
    run: "npm run test:conformance:workerd",
  });

  const runtimeGates = [
    {
      jobId: "deno",
      label: "Deno job",
      actionRepository: "denoland/setup-deno",
      action: SETUP_DENO_ACTION,
      actionInputs: { "deno-version": "2.x" },
      jobName: "Deno 2.x packed smoke",
      script: "test:runtime:deno",
      scriptCommand: "node scripts/run-runtime-smoke.mjs deno",
      stepName: "Run maintained Deno packed smoke",
    },
    {
      jobId: "bun",
      label: "Bun job",
      actionRepository: "oven-sh/setup-bun",
      action: SETUP_BUN_ACTION,
      actionInputs: { "bun-version": "latest" },
      jobName: "Bun packed smoke",
      script: "test:runtime:bun",
      scriptCommand: "node scripts/run-runtime-smoke.mjs bun",
      stepName: "Run maintained Bun packed smoke",
    },
  ] as const;

  for (const runtime of runtimeGates) {
    const job = jobs[runtime.jobId];
    expect(record(job, runtime.label)).toMatchObject({
      name: runtime.jobName,
      "runs-on": "ubuntu-latest",
    });
    expectBlockingJob(job, runtime.label);
    expectNode22Toolchain(job, runtime.label);
    expect(actionStep(job, runtime.label, runtime.actionRepository)).toMatchObject({
      uses: runtime.action,
      with: runtime.actionInputs,
    });
    expectCandidateTarball(job, runtime.label);
    expect(scripts[runtime.script]).toBe(runtime.scriptCommand);

    const smoke = namedStep(job, runtime.label, runtime.stepName);
    expect(smoke).toMatchObject({
      run: `npm run ${runtime.script} -- \"\${{ steps.pack.outputs.tarball }}\"`,
    });
    expect(smoke["continue-on-error"]).toBeUndefined();
    expect(String(smoke["run"])).not.toMatch(/(?:^|\s)(?:src|tests)\//u);
  }
}

function expectDocumentationCallerPolicy(
  scripts: Readonly<Record<string, string>>,
  ciWorkflow: unknown,
  candidateWorkflow: unknown,
  preflightSource = documentationPreflightSource,
): void {
  expect(scripts["test:docs:tarball"]).toBe("node scripts/verify-docs.mjs");
  expect(scripts["test:docs:preflight"]).toBe("node scripts/create-docs-preflight-pack.mjs");
  expect(scripts["test:docs:workflows:source"]).toBe(
    "node scripts/verify-doc-workflows.mjs --source",
  );
  expect(scripts["test:docs:workflows:artifact"]).toBe(
    "node scripts/verify-doc-workflows.mjs --artifact",
  );
  expect(scripts["docs:check"]).toBe(
    "node scripts/generate-docs.mjs --check && npm run test:docs:preflight",
  );
  expect(scripts["ci"]?.split(" && ")).toEqual([
    "npm run typecheck",
    "npm run lint",
    "npm run docs:check",
    "npm test",
    "npm run verify:audit",
    "npm run test:package:preflight",
  ]);
  // Asserted as an ordered set of required steps rather than one exact string:
  // the string form made the gate itself the thing under test, so adding a
  // missing gate failed here rather than passing. `lint` and
  // `test:package:preflight` were both absent, which let a publish skip the
  // packed-tarball checks that CI runs — including the declaration fixtures
  // that compile the shipped .d.ts and .d.cts with no @types/node installed.
  expect(scripts["prepublishOnly"]?.split(" && ")).toEqual([
    "npm run clean",
    "npm run contracts:check",
    "npm run sdk:check",
    "npm run docs:check",
    "npm run verify:audit",
    "npm run typecheck",
    "npm run lint",
    "npm run test",
    "npm run test:package:preflight",
  ]);
  expect(preflightSource).toContain("build: true");
  expect(preflightSource).toContain('verificationScripts: ["test:docs:tarball"]');
  expect(preflightSource).toContain("await runSourceDocumentationWorkflows(repositoryRoot)");

  const ciJobs = record(record(ciWorkflow, "CI workflow")["jobs"], "CI jobs");
  expect(
    namedStep(ciJobs["test"], "CI test job", "Required source gates and packed preflights"),
  ).toMatchObject({ run: "npm run ci" });
  expect(namedStep(ciJobs["test"], "CI test job", "Documented workflow gate")).toMatchObject({
    run: "npm run test:docs:workflows:source",
  });

  const releaseJobs = record(record(candidateWorkflow, "release workflow")["jobs"], "release jobs");
  expect(namedStep(releaseJobs["source-gate"], "source gate", "Generation gate")["run"]).toBe(
    "npm run contracts:check && npm run sdk:check && npm run docs:check",
  );
  const sourceWorkflow = String(
    namedStep(releaseJobs["source-gate"], "source gate", "Documentation workflow gate")["run"],
  );
  expect(sourceWorkflow).toContain("npm run test:docs:workflows:source -- \\");
  expect(sourceWorkflow).toContain("/tmp/source-report/source-report.json \\");
  expect(sourceWorkflow).toContain("/tmp/source-report/source-report.sha256 \\");
  expect(sourceWorkflow).toContain("/tmp/source-report/documentation-workflows.json \\");
  expect(sourceWorkflow).toContain("/tmp/source-report/documentation-workflows.sha256");
  const artifactVerification = String(
    namedStep(releaseJobs["artifact-gates"], "artifact gates", "Verify retained package artifact")[
      "run"
    ],
  );
  expect(artifactVerification).toContain("node scripts/verify-doc-workflows.mjs --artifact \\");
  expect(artifactVerification).toContain('  "$TARBALL" \\\n  "$SHA256" \\');
  expect(artifactVerification).toContain("/tmp/source-report/source-report.json \\");
  expect(artifactVerification).toContain("/tmp/source-report/source-report.sha256 \\");
  expect(artifactVerification).toContain("/tmp/source-report/documentation-workflows.json \\");
  expect(artifactVerification).toContain("/tmp/source-report/documentation-workflows.sha256");
  expect(artifactVerification).not.toMatch(/\bnpm run build\b|\bnpm pack\b/u);
}

describe("CI policy", () => {
  it("provisions the declared npm executable before CI commands", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");

    expect(packageJson.packageManager).toBe("npm@11.12.0");
    expectAssertedNpmToolchain(jobs["test"], "test job");
    expectAssertedNpmToolchain(jobs["coverage"], "coverage job");
    expectAssertedNpmToolchain(jobs["workerd"], "workerd job");
    expectAssertedNpmToolchain(jobs["deno"], "Deno job");
    expectAssertedNpmToolchain(jobs["bun"], "Bun job");
  });

  it("loads type-aware rules from the dedicated ESLint TypeScript program", async () => {
    const eslint = new ESLint({ cwd: repositoryRoot });
    const config = (await eslint.calculateConfigForFile("src/client.ts")) as unknown;
    const languageOptions = record(record(config, "ESLint config")["languageOptions"], "language");
    const parserOptions = record(languageOptions["parserOptions"], "parser options");
    const rules = record(record(config, "ESLint config")["rules"], "rules");

    expect(parserOptions["project"]).toBe("./tsconfig.eslint.json");
    expect(parserOptions["tsconfigRootDir"]).toBe(repositoryRoot);
    expect(rules["@typescript-eslint/no-floating-promises"]).toEqual([2]);
    expect(packageJson.scripts["lint"]).toBe(
      'eslint "src/**/*.ts" "examples/**/*.mjs" --max-warnings 0',
    );
  });

  it("keeps Node 22 and 24 blocking while making Node 26 best-effort", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const testJob = record(jobs["test"], "test job");
    const strategy = record(testJob["strategy"], "test strategy");
    const matrix = record(strategy["matrix"], "test matrix");

    expect(array(matrix["include"], "matrix includes")).toEqual([
      { node: 22, experimental: false },
      { node: 24, experimental: false },
      { node: 26, experimental: true },
    ]);
    expect(testJob["continue-on-error"]).toBe("${{ matrix.experimental }}");
    expect(strategy["fail-fast"]).toBe(false);
  });

  it("pins reviewed actions and grants only repository read access", () => {
    const workflowRecord = record(workflow, "workflow");
    const permissions = record(workflowRecord["permissions"], "permissions");
    const jobs = record(workflowRecord["jobs"], "jobs");
    const actionReferences = Object.values(jobs).flatMap((job, jobIndex) =>
      array(record(job, `job ${jobIndex}`)["steps"], `job ${jobIndex} steps`)
        .map((step, stepIndex) => record(step, `job ${jobIndex} step ${stepIndex}`)["uses"])
        .filter((uses): uses is string => typeof uses === "string"),
    );

    expect(permissions).toEqual({ contents: "read" });
    // Reviewed pins, node24 runtimes (GitHub deprecated the node20 action
    // runtime). checkout v7.0.1 and setup-node v6.5.0 — v6 deliberately, not
    // v7: setup-node v7 stopped exporting the dummy NODE_AUTH_TOKEN, and any
    // job that sets registry-url without providing the token (registry-smoke,
    // by design) would then fail npm's env substitution in .npmrc.
    expect(actionReferences).toEqual([
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      SETUP_DENO_ACTION,
      CHECKOUT_ACTION,
      SETUP_NODE_ACTION,
      SETUP_BUN_ACTION,
    ]);
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/.test(reference))).toBe(true);
  });

  it("keeps the complete packed example preflight on the blocking CI path", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const testSteps = array(record(jobs["test"], "test job")["steps"], "test steps");
    const requiredGatesStep = testSteps
      .map((step, index) => record(step, `test step ${index}`))
      .find(({ name }) => name === "Required source gates and packed preflights");

    expect(packageJson.scripts["ci"]?.split(" && ")).toEqual([
      "npm run typecheck",
      "npm run lint",
      "npm run docs:check",
      "npm test",
      "npm run verify:audit",
      "npm run test:package:preflight",
    ]);
    expect(requiredGatesStep).toMatchObject({ run: "npm run ci" });
    expect(requiredGatesStep?.["continue-on-error"]).toBeUndefined();
    expect(packageJson.scripts["verify:audit"]).toBe("node scripts/verify-audit.mjs");
    expectDocumentationCallerPolicy(packageJson.scripts, workflow, releaseWorkflow);
    expect(packageJson.scripts["test:package:preflight"]).toBe(
      "npm run build && node scripts/create-preflight-pack.mjs",
    );
    expect(packageJson.scripts["test:integration:tarball"]).toBe(
      "vitest run --config vitest.integration.config.ts",
    );
    expect(packagePreflightSource).toContain(
      'verificationScripts: ["test:docs:tarball", "test:package:tarball", "test:integration:tarball"]',
    );
  });

  it("keeps every maintained runtime gate blocking and attached to its package script", () => {
    expectMaintainedRuntimeGates(packageJson.scripts, workflow);
  });

  it.each([
    [
      "a removed runtime job",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs") as Record<
          string,
          unknown
        >;
        delete jobs["workerd"];
      },
    ],
    [
      "a runtime job allowed to continue on error",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const deno = record(jobs["deno"], "Deno job") as Record<string, unknown>;
        deno["continue-on-error"] = true;
      },
    ],
    [
      "a runtime job muted by a condition",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const workerd = record(jobs["workerd"], "workerd job") as Record<string, unknown>;
        workerd["if"] = "${{ false }}";
      },
    ],
    [
      "a maintained runtime step muted by a condition",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const smoke = namedStep(
          jobs["deno"],
          "Deno job",
          "Run maintained Deno packed smoke",
        ) as Record<string, unknown>;
        smoke["if"] = "${{ false }}";
      },
    ],
    [
      "a packed smoke replaced by a source import",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const smoke = namedStep(
          jobs["bun"],
          "Bun job",
          "Run maintained Bun packed smoke",
        ) as Record<string, unknown>;
        smoke["run"] = "bun run tests/runtime-smoke.mjs";
      },
    ],
    [
      "a workerd gate detached from its maintained script",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const gate = namedStep(
          jobs["workerd"],
          "workerd job",
          "Run maintained workerd conformance",
        ) as Record<string, unknown>;
        gate["run"] = "vitest run --config vitest.workerd.config.ts";
      },
    ],
    [
      "a Deno gate detached from its maintained script",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const smoke = namedStep(
          jobs["deno"],
          "Deno job",
          "Run maintained Deno packed smoke",
        ) as Record<string, unknown>;
        smoke["run"] =
          'node scripts/run-runtime-smoke.mjs deno "${{ steps.pack.outputs.tarball }}"';
      },
    ],
    [
      "an unpinned runtime setup action",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const setup = actionStep(jobs["deno"], "Deno job", "denoland/setup-deno") as Record<
          string,
          unknown
        >;
        setup["uses"] = "denoland/setup-deno@v2";
      },
    ],
    [
      "a runtime gate without tarball packing",
      (_scripts: Record<string, string>, ci: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const pack = namedStep(jobs["bun"], "Bun job", "Build candidate tarball") as Record<
          string,
          unknown
        >;
        pack["run"] = "npm run build";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const scripts = { ...packageJson.scripts };
    const ciFixture = structuredClone(workflow);
    mutate(scripts, ciFixture);

    expect(() => expectMaintainedRuntimeGates(scripts, ciFixture)).toThrow();
  });

  it.each([
    [
      "an obsolete source-only docs command",
      (scripts: Record<string, string>, _ci: unknown, _release: unknown) => {
        scripts["docs:check"] =
          "node scripts/generate-docs.mjs --check && node scripts/verify-docs.mjs";
      },
    ],
    [
      "a docs command without its preflight producer",
      (scripts: Record<string, string>, _ci: unknown, _release: unknown) => {
        scripts["docs:check"] = "node scripts/generate-docs.mjs --check";
      },
    ],
    [
      "a prepublish command that bypasses docs:check",
      (scripts: Record<string, string>, _ci: unknown, _release: unknown) => {
        scripts["prepublishOnly"] = scripts["prepublishOnly"]!.replace(
          "npm run docs:check",
          "npm run test:docs:tarball",
        );
      },
    ],
    [
      "a CI command chain that invokes the verifier without a producer",
      (scripts: Record<string, string>, _ci: unknown, _release: unknown) => {
        scripts["ci"] = scripts["ci"]!.replace("npm run docs:check", "npm run test:docs:tarball");
      },
    ],
    [
      "a source gate that invokes the verifier without a producer",
      (_scripts: Record<string, string>, _ci: unknown, release: unknown) => {
        const jobs = record(record(release, "release workflow")["jobs"], "release jobs");
        const generation = namedStep(jobs["source-gate"], "source gate", "Generation gate") as {
          run: string;
        };
        generation.run = generation.run.replace(
          "npm run docs:check",
          "node scripts/verify-docs.mjs",
        );
      },
    ],
    [
      "an artifact gate that omits retained inputs",
      (_scripts: Record<string, string>, _ci: unknown, release: unknown) => {
        const jobs = record(record(release, "release workflow")["jobs"], "release jobs");
        const artifact = namedStep(
          jobs["artifact-gates"],
          "artifact gates",
          "Verify retained package artifact",
        ) as { run: string };
        artifact.run = artifact.run.replace(
          "/tmp/source-report/documentation-workflows.sha256",
          "",
        );
      },
    ],
    [
      "an artifact gate that substitutes a source preflight tarball",
      (_scripts: Record<string, string>, _ci: unknown, release: unknown) => {
        const jobs = record(record(release, "release workflow")["jobs"], "release jobs");
        const artifact = namedStep(
          jobs["artifact-gates"],
          "artifact gates",
          "Verify retained package artifact",
        ) as { run: string };
        artifact.run = artifact.run.replace(
          "node scripts/verify-doc-workflows.mjs --artifact",
          "npm run test:docs:preflight",
        );
      },
    ],
    [
      "a suppressed CI documentation workflow gate",
      (_scripts: Record<string, string>, ci: unknown, _release: unknown) => {
        const jobs = record(record(ci, "CI workflow")["jobs"], "CI jobs");
        const step = namedStep(jobs["test"], "CI test job", "Documented workflow gate") as {
          run: string;
        };
        step.run = "true";
      },
    ],
  ])("rejects %s", (_label, mutate) => {
    const scripts = { ...packageJson.scripts };
    const ciFixture = structuredClone(workflow);
    const releaseFixture = structuredClone(releaseWorkflow);
    mutate(scripts, ciFixture, releaseFixture);

    expect(() => expectDocumentationCallerPolicy(scripts, ciFixture, releaseFixture)).toThrow();
  });
});
