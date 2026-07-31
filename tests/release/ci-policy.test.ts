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

  it("delegates CI package and audit checks to their tested orchestrators", () => {
    const jobs = record(record(workflow, "workflow")["jobs"], "jobs");
    const testSteps = array(record(jobs["test"], "test job")["steps"], "test steps");
    const commands = testSteps.map((step, index) => record(step, `test step ${index}`)["run"]);

    expect(packageJson.scripts["ci"]?.split(" && ")).toEqual([
      "npm run typecheck",
      "npm run lint",
      "npm run docs:check",
      "npm test",
      "npm run verify:audit",
      "npm run test:package:preflight",
    ]);
    expect(commands).toContain("npm run ci");
    expect(packageJson.scripts["verify:audit"]).toBe("node scripts/verify-audit.mjs");
    expect(packageJson.scripts["docs:check"]).toBe(
      "node scripts/generate-docs.mjs --check && node scripts/verify-docs.mjs",
    );
    expect(packageJson.scripts["test:package:preflight"]).toBe(
      "npm run build && node scripts/create-preflight-pack.mjs",
    );
  });
});
