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
    expect(actionReferences).toEqual([
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
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
