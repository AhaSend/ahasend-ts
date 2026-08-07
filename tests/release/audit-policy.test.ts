import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("pins the dependency overrides that keep the audit surface clean", () => {
    // These overrides are the only thing holding the audit gate green: without
    // them postman-collection pulls lodash 4.17.21 (high: _.template code
    // injection) and uuid 8.3.2, which re-flags the DIRECT devDependency
    // @stoplight/prism-cli — a class the policy forbids with no exception path.
    // npm does not record overrides in the lockfile, and package.json is not
    // hashed into the release evidence, so deleting this block is otherwise
    // undetectable until someone regenerates the lockfile.
    expect(packageJson.overrides).toEqual({
      esbuild: "^0.28.1",
      "postman-collection": { lodash: "^4.18.1", uuid: "^11.1.1" },
    });

    expect(lockfilePackage("node_modules/lodash")).toMatchObject({ version: "4.18.1", dev: true });
    expect(lockfilePackage("node_modules/uuid")).toMatchObject({ version: "11.1.1", dev: true });

    // The nested copies are exactly what the overrides removed.
    expect(
      packageLock.packages["node_modules/postman-collection/node_modules/lodash"],
    ).toBeUndefined();
    expect(
      packageLock.packages["node_modules/postman-collection/node_modules/uuid"],
    ).toBeUndefined();
  });

  it("pins the corrected development tools without adding production dependencies", () => {
    expect(packageJson.dependencies ?? {}).toEqual({});
    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.devDependencies["@edge-runtime/vm"]).toBe("5.0.0");
    expect(packageJson.devDependencies["js-yaml"]).toBe("4.3.0");
    expect(packageJson.devDependencies["@stoplight/prism-cli"]).toBe("5.14.2");
    expect(packageJson.devDependencies["workerd"]).toBe("1.20260722.1");
    expect(packageJson.devDependencies["wrangler"]).toBe("4.114.0");

    const rootPackage = lockfilePackage("");
    expect(rootPackage.dependencies ?? {}).toEqual({});
    expect(rootPackage.devDependencies?.["@edge-runtime/vm"]).toBe("5.0.0");
    expect(rootPackage.devDependencies?.["js-yaml"]).toBe("4.3.0");
    expect(rootPackage.devDependencies?.["@stoplight/prism-cli"]).toBe("5.14.2");
    expect(rootPackage.devDependencies?.["workerd"]).toBe("1.20260722.1");
    expect(rootPackage.devDependencies?.["wrangler"]).toBe("4.114.0");
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
    expect(lockfilePackage("node_modules/js-yaml")).toMatchObject({
      version: "4.3.0",
      dev: true,
    });
    expect(lockfilePackage("node_modules/workerd")).toMatchObject({
      version: "1.20260722.1",
      dev: true,
      engines: { node: ">=16" },
    });
    expect(lockfilePackage("node_modules/wrangler")).toMatchObject({
      version: "4.114.0",
      dev: true,
      engines: { node: ">=22.0.0" },
      dependencies: { workerd: "1.20260722.1" },
    });
    // prism-core and prism-http-server were advanced by the audit
    // remediation that cleared the lodash/uuid advisories; they now declare a
    // newer engines floor than the CLI that depends on them.
    for (const [path, version, nodeEngine] of [
      ["node_modules/@stoplight/prism-cli", "5.14.2", ">=18.20.1"],
      ["node_modules/@stoplight/prism-core", "5.15.11", ">=24.14.0"],
      ["node_modules/@stoplight/prism-http", "5.12.0", ">=18.20.1"],
      ["node_modules/@stoplight/prism-http-server", "5.15.11", ">=24.14.0"],
    ] as const) {
      expect(lockfilePackage(path)).toMatchObject({
        version,
        dev: true,
        engines: { node: nodeEngine },
      });
    }
  });

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
