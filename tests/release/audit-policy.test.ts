import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateAuditReports } from "../../scripts/verify-audit.mjs";
import auditExceptions from "../../security/audit-exceptions.json";
import auditPolicy from "../../security/audit-policy.json";
import auditCases from "../fixtures/release/audit-cases.json";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly engines: Readonly<Record<string, string>>;
  readonly overrides?: Readonly<Record<string, unknown>>;
}

interface LockfilePackage {
  readonly version?: string;
  readonly dev?: boolean;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface PackageLock {
  readonly packages: Readonly<Record<string, LockfilePackage>>;
}

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
) as PackageManifest;
const packageLock = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package-lock.json"), "utf8"),
) as PackageLock;
const reports = auditCases.reports as Record<string, unknown>;
const exceptionSets = auditCases.exceptionSets as Record<string, unknown>;
const temporaryDirectories: string[] = [];

function fixtureValue(fixtures: Record<string, unknown>, name: string): unknown {
  const value = fixtures[name];
  if (value === undefined) throw new TypeError(`Unknown audit fixture ${name}.`);
  return value;
}

function lockfilePackage(path: string): LockfilePackage {
  const value = packageLock.packages[path];
  if (value === undefined) throw new TypeError(`Missing lockfile package ${path}.`);
  return value;
}

function lockfileVersion(path: string): string {
  const version = lockfilePackage(path).version;
  if (version === undefined) throw new TypeError(`Lockfile package ${path} has no version.`);
  return version;
}

interface FixtureFinding {
  severity: string;
  range: string;
  via: unknown[];
  fixAvailable: unknown;
}

interface FixtureReport {
  vulnerabilities: Record<string, FixtureFinding>;
  metadata: { vulnerabilities: Record<string, number> };
}

function fixtureFinding(report: FixtureReport, name: string): FixtureFinding {
  const finding = report.vulnerabilities[name];
  if (finding === undefined) throw new TypeError(`Fixture report has no finding ${name}.`);
  return finding;
}

function recountFindings(report: FixtureReport): void {
  const counts = report.metadata.vulnerabilities;
  for (const severity of Object.keys(counts)) counts[severity] = 0;
  for (const finding of Object.values(report.vulnerabilities)) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  counts.total = Object.keys(report.vulnerabilities).length;
}

function validateUnpatchedVariant(
  change: (report: FixtureReport) => void,
  exceptions: unknown = auditCases.exceptionSets.directUnpatched,
): () => unknown {
  const report = structuredClone(auditCases.reports.directUnpatched) as unknown as FixtureReport;
  change(report);
  recountFindings(report);
  return () =>
    validateAuditReports({
      fullReport: report,
      productionReport: auditCases.reports.clean,
      policy: auditPolicy,
      exceptions,
      installedVersions: auditCases.installedVersions,
      today: auditCases.today,
    });
}

function extraAdvisory(source: number, range: string): Record<string, unknown> {
  return {
    source,
    name: "unpatched-dependency",
    dependency: "unpatched-dependency",
    title: "Further dependency issue",
    url: `https://github.com/advisories/GHSA-test-${String(source)}`,
    severity: "moderate",
    cwe: ["CWE-400"],
    cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
    range,
  };
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
          installedVersions: auditCases.installedVersions,
          today: auditCases.today,
        });

      if (testCase.expectedError === null) {
        expect(validate).not.toThrow();
      } else {
        expect(validate).toThrow(testCase.expectedError);
      }
    });
  }

  it("keeps the Prism mock server out of the dependency tree", () => {
    // Prism is fetched through npx by the documented workflow rather than
    // installed. Its chain reaches postman-collection, which pins an
    // @faker-js/faker release covered by GHSA-qxc2-j82w-r537 in every version
    // it has ever published, and the advisory covers every faker at or below
    // 10.4.0 — so no patched release exists on the API postman-collection
    // calls, and forcing one makes postman-collection throw on require.
    // Installing Prism therefore re-flags it as a DIRECT devDependency
    // advisory. The policy allows one only when the advisory affects every
    // published release of the package it is filed against. Newer faker
    // releases are patched, so npm does not report the faker range as "*",
    // and Prism stays blocked.
    // Nothing else would catch a reinstatement: package.json is not hashed
    // into the release evidence, and the finding only appears once someone
    // regenerates the lockfile.
    expect("@stoplight/prism-cli" in packageJson.devDependencies).toBe(false);
    for (const path of [
      "node_modules/@stoplight/prism-cli",
      "node_modules/@stoplight/prism-http",
      "node_modules/@stoplight/prism-http-server",
      "node_modules/@stoplight/http-spec",
      "node_modules/postman-collection",
      "node_modules/@faker-js/faker",
      "node_modules/json-schema-ref-parser",
    ]) {
      expect(packageLock.packages[path]).toBeUndefined();
    }

    // esbuild is the one override left: it holds the bundler at the version the
    // packed-output tests assert, and npm does not record overrides in the
    // lockfile, so deleting it is otherwise undetectable.
    expect(packageJson.overrides).toEqual({ esbuild: "0.28.1" });
    expect(lockfilePackage("node_modules/esbuild")).toMatchObject({
      version: "0.28.1",
      dev: true,
    });
  });

  it("pins the corrected development tools without adding production dependencies", () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.devDependencies["@edge-runtime/vm"]).toBe("5.0.0");
    expect(packageJson.devDependencies["esbuild"]).toBe("0.28.1");
    expect(packageJson.devDependencies["js-yaml"]).toBe("4.3.2");
    expect(packageJson.devDependencies["workerd"]).toBe("1.20260801.1");
    expect(packageJson.devDependencies["wrangler"]).toBe("4.147.0");

    const rootPackage = lockfilePackage("");
    expect(rootPackage.dependencies ?? {}).toEqual({});
    expect(rootPackage.devDependencies?.["@edge-runtime/vm"]).toBe("5.0.0");
    expect(rootPackage.devDependencies?.["esbuild"]).toBe("0.28.1");
    expect(rootPackage.devDependencies?.["js-yaml"]).toBe("4.3.2");
    expect(rootPackage.devDependencies?.["workerd"]).toBe("1.20260801.1");
    expect(rootPackage.devDependencies?.["wrangler"]).toBe("4.147.0");
    for (const path of ["node_modules/@edge-runtime/vm", "node_modules/@edge-runtime/primitives"]) {
      expect(lockfilePackage(path)).toMatchObject({
        dev: true,
        engines: { node: ">=18" },
      });
    }
    expect(lockfilePackage("node_modules/@edge-runtime/vm")).toMatchObject({
      version: "5.0.0",
      dependencies: { "@edge-runtime/primitives": "6.0.0" },
    });
    expect(lockfilePackage("node_modules/@edge-runtime/primitives")).toMatchObject({
      version: "6.0.0",
    });
    expect(lockfilePackage("node_modules/esbuild")).toMatchObject({
      version: "0.28.1",
      dev: true,
    });
    expect(lockfilePackage("node_modules/js-yaml")).toMatchObject({
      version: "4.3.2",
      dev: true,
    });
    expect(lockfilePackage("node_modules/workerd")).toMatchObject({
      version: "1.20260801.1",
      dev: true,
      engines: { node: ">=16" },
    });
    expect(lockfilePackage("node_modules/wrangler")).toMatchObject({
      version: "4.147.0",
      dev: true,
      engines: { node: ">=22.0.0" },
      dependencies: { workerd: "1.20261001.1" },
    });
  });

  it("limits the committed exception register to the unpatched sprintf-js advisory", () => {
    // GHSA-hp3w-g68c-fv3c covers every published sprintf-js, and every
    // api-extractor release reaches it through argparse 1.x, so the register
    // carries one exception per finding on that chain. Any other entry needs
    // its own review rather than a quiet addition here.
    expect(auditExceptions.exceptions.map(({ id }) => id)).toEqual([
      "sprintf-js-GHSA-hp3w-g68c-fv3c",
      "argparse-GHSA-hp3w-g68c-fv3c",
      "@rushstack/ts-command-line-GHSA-hp3w-g68c-fv3c",
      "@microsoft/api-extractor-GHSA-hp3w-g68c-fv3c",
      "tsup-GHSA-hp3w-g68c-fv3c",
    ]);
    for (const exception of auditExceptions.exceptions) {
      expect(exception.severity).toBe("moderate");
    }
    const reviewedOn = auditExceptions.exceptions[0]?.reviewedOn;
    if (reviewedOn === undefined) throw new TypeError("The exception register is empty.");
    expect(() =>
      validateAuditReports({
        fullReport: auditCases.reports.sprintfJsChain,
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditExceptions,
        installedVersions: {
          "@microsoft/api-extractor": lockfileVersion("node_modules/@microsoft/api-extractor"),
          tsup: lockfileVersion("node_modules/tsup"),
        },
        today: reviewedOn,
      }),
    ).not.toThrow();
  });

  it("fails closed when a rolled-back fix cannot be compared with the installed version", () => {
    expect(() =>
      validateAuditReports({
        fullReport: auditCases.reports.directUnpatched,
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditCases.exceptionSets.directUnpatched,
        today: auditCases.today,
      }),
    ).toThrow("Installed version of direct dependency unpatched-development-tool is unknown");
  });

  it("keeps an unpatched direct exception when an upstream release widens the reported range", () => {
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-development-tool").range = "2.0.0 - 2.9.0";
      }),
    ).not.toThrow();
  });

  it("rejects an unpatched chain whose advisory is replaced by a different one", () => {
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-dependency").via = [extraAdvisory(1000005, "<=1.1.3")];
      }),
    ).toThrow("Transitive development advisory unpatched-dependency has no exact exception");
  });

  it("rejects an unpatched chain once a further advisory lands on the same package", () => {
    // The package range stays "*" because the original advisory still covers
    // every release, so it cannot show whether the new advisory has a fix.
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-dependency").via.push(extraAdvisory(1000005, "<1.1.0"));
      }),
    ).toThrow("Direct development advisories are forbidden unless provably unpatched");
  });

  it("rejects a direct dependency with an advisory of its own next to an unpatched chain", () => {
    expect(
      validateUnpatchedVariant((report) => {
        const tool = fixtureFinding(report, "unpatched-development-tool");
        tool.via.push({ ...extraAdvisory(1000006, "<2.5.0"), name: "unpatched-development-tool" });
        tool.range = "*";
      }),
    ).toThrow("Direct development advisories are forbidden unless provably unpatched");
  });

  it("rejects an unpatched chain whose deeper dependency has a patched release", () => {
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-development-tool").via = ["intermediate-dependency"];
        report.vulnerabilities["intermediate-dependency"] = {
          ...structuredClone(fixtureFinding(report, "unpatched-dependency")),
          name: "intermediate-dependency",
          via: ["unpatched-dependency"],
          range: "1.0.0 - 1.4.0",
        } as FixtureFinding;
        fixtureFinding(report, "unpatched-dependency").range = "1.0.0 - 1.1.3";
      }),
    ).toThrow("Direct development advisories are forbidden unless provably unpatched");
  });

  it("accepts an unpatched direct advisory for which npm offers no fix at all", () => {
    expect(
      validateUnpatchedVariant((report) => {
        for (const finding of Object.values(report.vulnerabilities)) finding.fixAvailable = false;
      }),
    ).not.toThrow();
  });

  it.each([
    ["names another package", { name: "other-package", version: "1.0.0", isSemVerMajor: true }],
    [
      "equals the installed version",
      { name: "unpatched-development-tool", version: "2.4.0", isSemVerMajor: false },
    ],
    [
      "is a prerelease of the installed version",
      { name: "unpatched-development-tool", version: "2.4.0-rc.1", isSemVerMajor: false },
    ],
  ])("rejects an unpatched direct advisory whose npm fix %s", (_label, fixAvailable) => {
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-development-tool").fixAvailable = fixAvailable;
      }),
    ).toThrow("Direct development advisories are forbidden unless provably unpatched");
  });

  it("fails closed when a chain names a finding the report does not contain", () => {
    expect(
      validateUnpatchedVariant((report) => {
        fixtureFinding(report, "unpatched-development-tool").via = ["absent-dependency"];
      }),
    ).toThrow(
      "Advisory finding unpatched-development-tool names absent-dependency, which the report does not contain",
    );
  });

  it("matches an unpatched direct finding only with an exception that carries no range", () => {
    const ranged = structuredClone(auditCases.exceptionSets.directUnpatched);
    for (const exception of ranged.exceptions) {
      Object.assign(exception, { range: exception.range ?? ">=2.0.0" });
    }
    expect(validateUnpatchedVariant(() => undefined, ranged)).toThrow(
      "Direct development advisory unpatched-development-tool has no exact exception",
    );
  });

  it("matches a transitive finding only with an exception that carries its exact range", () => {
    const rangeless = structuredClone(auditCases.exceptionSets.directUnpatched);
    for (const exception of rangeless.exceptions) delete exception.range;
    expect(validateUnpatchedVariant(() => undefined, rangeless)).toThrow(
      "Transitive development advisory unpatched-dependency has no exact exception",
    );
  });

  it("rejects exceptions that no current finding uses", () => {
    expect(() =>
      validateAuditReports({
        fullReport: auditCases.reports.clean,
        productionReport: auditCases.reports.clean,
        policy: auditPolicy,
        exceptions: auditCases.exceptionSets.directUnpatched,
        installedVersions: auditCases.installedVersions,
        today: auditCases.today,
      }),
    ).toThrow(
      "Audit exceptions do not match current findings: unpatched-dependency-1000004, unpatched-development-tool-1000004",
    );
  });

  it.each([
    ["accepts", "2026-09-29", null],
    ["rejects", "2026-09-30", "lasts 91 days; the policy allows at most 90"],
  ])("%s an exception that expires on %s, after a 2026-07-01 review", (_verb, expiresOn, error) => {
    const exceptions = structuredClone(auditCases.exceptionSets.directUnpatched);
    for (const exception of exceptions.exceptions) {
      Object.assign(exception, { reviewedOn: "2026-07-01", expiresOn });
    }
    const validate = validateUnpatchedVariant(() => undefined, exceptions);
    if (error === null) {
      expect(validate).not.toThrow();
    } else {
      expect(validate).toThrow(error);
    }
  });

  it("requires the policy to bound how long an exception lasts", () => {
    const { maxExceptionDays: _maxExceptionDays, ...unbounded } = auditPolicy;
    expect(() =>
      validateAuditReports({
        fullReport: auditCases.reports.clean,
        productionReport: auditCases.reports.clean,
        policy: unbounded,
        exceptions: { version: 1, exceptions: [] },
        today: auditCases.today,
      }),
    ).toThrow("Audit policy fields must match policy schema");
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
    // The CLI runs on the real clock, so the committed register would expire
    // this test along with it. A copy of the script runs against the committed
    // register with its review window moved around today instead; the
    // register's own dates are checked above at a fixed date.
    const day = 86_400_000;
    const isoDate = (offset: number) => new Date(Date.now() + offset).toISOString().slice(0, 10);
    mkdirSync(join(directory, "scripts"));
    mkdirSync(join(directory, "security"));
    copyFileSync("scripts/verify-audit.mjs", join(directory, "scripts/verify-audit.mjs"));
    copyFileSync("security/audit-policy.json", join(directory, "security/audit-policy.json"));
    copyFileSync("package-lock.json", join(directory, "package-lock.json"));
    writeFileSync(
      join(directory, "security/audit-exceptions.json"),
      JSON.stringify({
        ...auditExceptions,
        exceptions: auditExceptions.exceptions.map((exception) => ({
          ...exception,
          reviewedOn: isoDate(-day),
          expiresOn: isoDate(2 * day),
        })),
      }),
    );
    const npmStub = resolve(directory, "npm-stub.mjs");
    const callLog = resolve(directory, "calls.jsonl");
    const cleanReport = JSON.stringify(auditCases.reports.clean);
    // The full report carries the findings the committed register covers, so
    // the CLI also proves it reads installed versions from the lockfile.
    const fullReport = JSON.stringify(auditCases.reports.sprintfJsChain);
    writeFileSync(
      npmStub,
      `import { appendFileSync } from "node:fs";
appendFileSync(process.env.AUDIT_CALL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (!process.argv.includes("audit") || !process.argv.includes("--json")) process.exit(2);
process.stdout.write(process.argv.includes("--include=dev") ? ${JSON.stringify(fullReport)} : ${JSON.stringify(cleanReport)});
`,
    );

    const result = spawnSync(process.execPath, ["scripts/verify-audit.mjs"], {
      cwd: directory,
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
      "Audit policy passed: 0 production, 2 direct development, 3 transitive development advisories (5 exceptions)",
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
