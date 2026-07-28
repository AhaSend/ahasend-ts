import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateAuditReports } from "../../scripts/verify-audit.mjs";
import auditExceptions from "../../security/audit-exceptions.json";
import auditPolicy from "../../security/audit-policy.json";
import auditCases from "../fixtures/release/audit-cases.json";

const reports = auditCases.reports as Record<string, unknown>;
const exceptionSets = auditCases.exceptionSets as Record<string, unknown>;
const temporaryDirectories: string[] = [];

function fixtureValue(fixtures: Record<string, unknown>, name: string): unknown {
  const value = fixtures[name];
  if (value === undefined) throw new TypeError(`Unknown audit fixture ${name}.`);
  return value;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dependency audit policy", () => {
  for (const testCase of auditCases.cases) {
    it(testCase.name, () => {
      const validate = () =>
        validateAuditReports({
          fullReport: fixtureValue(reports, testCase.fullReport),
          productionReport: fixtureValue(reports, testCase.productionReport),
          policy: auditPolicy,
          exceptions: fixtureValue(exceptionSets, testCase.exceptions),
          today: auditCases.today,
        });

      if (testCase.expectedError === null) {
        expect(validate).not.toThrow();
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }

  it("keeps the committed exception register empty while the dependency graph is clean", () => {
    expect(auditExceptions).toEqual({ version: 1, exceptions: [] });
    expect(() =>
      validateAuditReports({
        fullReport: auditCases.reports.clean,
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditExceptions,
        today: auditCases.today,
      }),
    ).not.toThrow();
  });

  it("requires an exception to match the current advisory range exactly", () => {
    const changedReport = structuredClone(auditCases.reports.transitiveModerate);
    changedReport.vulnerabilities["transitive-development-tool"].range = "<=4.0.0";

    expect(() =>
      validateAuditReports({
        fullReport: changedReport,
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditCases.exceptionSets.allowed,
        today: auditCases.today,
      }),
    ).toThrow("has no exact exception");
  });

  it("fails closed when npm output is not an audit report", () => {
    expect(() =>
      validateAuditReports({
        fullReport: { error: { summary: "registry unavailable" } },
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditExceptions,
        today: auditCases.today,
      }),
    ).toThrow("must use npm audit report version 2");
  });

  it("runs the tested validator from the CLI with development dependencies explicitly included", () => {
    const directory = mkdtempSync(join(tmpdir(), "ahasend-audit-cli-"));
    temporaryDirectories.push(directory);
    const npmStub = resolve(directory, "npm-stub.mjs");
    const callLog = resolve(directory, "calls.jsonl");
    const cleanReport = JSON.stringify(auditCases.reports.clean);
    writeFileSync(
      npmStub,
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.AUDIT_CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (!process.argv.includes("audit") || !process.argv.includes("--json")) process.exit(2);
process.stdout.write(${JSON.stringify(cleanReport)});
`,
    );

    const result = spawnSync(process.execPath, ["scripts/verify-audit.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        AUDIT_CALL_LOG: callLog,
        NODE_ENV: "production",
        npm_config_omit: "dev",
        npm_execpath: npmStub,
      },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "Audit policy passed: 0 production, 0 direct development, 0 transitive development advisories",
    );
    expect(
      readFileSync(callLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      ["audit", "--omit=dev", "--json"],
      ["audit", "--include=dev", "--json"],
    ]);
  });
});
