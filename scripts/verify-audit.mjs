#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const severityNames = ["info", "low", "moderate", "high", "critical"];

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${label} fields must match policy schema: unexpected ${JSON.stringify(unexpected)}, missing ${JSON.stringify(missing)}.`,
    );
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireSeverity(value, label) {
  if (typeof value !== "string" || !severityNames.includes(value)) {
    throw new TypeError(`${label} must be a recognized npm severity.`);
  }
  return value;
}

function requireDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label} must be an ISO calendar date.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} must be a valid ISO calendar date.`);
  }
  return value;
}

function normalizeVia(via, label, { allowSourceIds = false } = {}) {
  if (!Array.isArray(via) || via.length === 0) {
    throw new TypeError(`${label} must contain at least one advisory source.`);
  }
  const normalized = via.map((entry, index) => {
    if (typeof entry === "string") return requireNonEmptyString(entry, `${label}[${index}]`);
    if (allowSourceIds && typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0) {
      return entry;
    }

    const advisory = requireObject(entry, `${label}[${index}]`);
    if (
      (typeof advisory.source !== "number" ||
        !Number.isSafeInteger(advisory.source) ||
        advisory.source <= 0) &&
      (typeof advisory.source !== "string" || advisory.source.trim() === "")
    ) {
      throw new TypeError(`${label}[${index}].source must identify an npm advisory.`);
    }
    requireSeverity(advisory.severity, `${label}[${index}].severity`);
    requireNonEmptyString(advisory.range, `${label}[${index}].range`);
    return advisory.source;
  });

  if (new Set(normalized.map((entry) => `${typeof entry}:${entry}`)).size !== normalized.length) {
    throw new TypeError(`${label} must not contain duplicate advisory sources.`);
  }
  return normalized.sort((left, right) =>
    `${typeof left}:${left}`.localeCompare(`${typeof right}:${right}`),
  );
}

function parsePolicy(value) {
  const policy = requireObject(value, "Audit policy");
  requireExactKeys(
    policy,
    ["version", "auditReportVersion", "exceptionSeverities"],
    "Audit policy",
  );
  if (policy.version !== 1) throw new TypeError("Unsupported audit policy version.");
  if (policy.auditReportVersion !== 2) {
    throw new TypeError("Audit policy must require npm audit report version 2.");
  }
  if (
    !Array.isArray(policy.exceptionSeverities) ||
    policy.exceptionSeverities.length === 0 ||
    policy.exceptionSeverities.some((severity) => !severityNames.includes(severity)) ||
    new Set(policy.exceptionSeverities).size !== policy.exceptionSeverities.length
  ) {
    throw new TypeError("Audit policy exceptionSeverities must be unique recognized severities.");
  }
  if (
    policy.exceptionSeverities.some((severity) => severity === "high" || severity === "critical")
  ) {
    throw new TypeError("Audit policy cannot allow high or critical exceptions.");
  }
  return policy;
}

function parseAuditReport(value, label, reportVersion) {
  const report = requireObject(value, label);
  if (report.auditReportVersion !== reportVersion) {
    throw new TypeError(`${label} must use npm audit report version ${reportVersion}.`);
  }
  const vulnerabilities = requireObject(report.vulnerabilities, `${label}.vulnerabilities`);
  const parsed = [];

  for (const [packageName, value] of Object.entries(vulnerabilities)) {
    const vulnerability = requireObject(value, `${label}.vulnerabilities[${packageName}]`);
    if (vulnerability.name !== packageName) {
      throw new TypeError(`${label} vulnerability key and name disagree for ${packageName}.`);
    }
    const severity = requireSeverity(
      vulnerability.severity,
      `${label}.vulnerabilities[${packageName}].severity`,
    );
    if (typeof vulnerability.isDirect !== "boolean") {
      throw new TypeError(`${label} vulnerability ${packageName} must declare isDirect.`);
    }
    const range = requireNonEmptyString(
      vulnerability.range,
      `${label}.vulnerabilities[${packageName}].range`,
    );
    const via = normalizeVia(vulnerability.via, `${label}.vulnerabilities[${packageName}].via`);
    parsed.push({ packageName, severity, isDirect: vulnerability.isDirect, range, via });
  }

  const metadata = requireObject(report.metadata, `${label}.metadata`);
  const counts = requireObject(metadata.vulnerabilities, `${label}.metadata.vulnerabilities`);
  let total = 0;
  for (const severity of severityNames) {
    const count = counts[severity];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(
        `${label} metadata count for ${severity} must be a non-negative integer.`,
      );
    }
    const actual = parsed.filter((vulnerability) => vulnerability.severity === severity).length;
    if (count !== actual) {
      throw new TypeError(`${label} metadata count for ${severity} does not match its findings.`);
    }
    total += count;
  }
  if (counts.total !== total) {
    throw new TypeError(`${label} metadata total does not match its findings.`);
  }
  return parsed;
}

function exceptionKey(value) {
  return JSON.stringify([
    value.packageName,
    value.severity,
    value.range,
    value.via.map((entry) => [typeof entry, entry]),
  ]);
}

function parseExceptions(value, policy, today) {
  const document = requireObject(value, "Audit exceptions");
  requireExactKeys(document, ["version", "exceptions"], "Audit exceptions");
  if (document.version !== 1) throw new TypeError("Unsupported audit exceptions version.");
  if (!Array.isArray(document.exceptions)) {
    throw new TypeError("Audit exceptions must be an array.");
  }

  const ids = new Set();
  const keys = new Set();
  return document.exceptions.map((value, index) => {
    const label = `Audit exception ${index}`;
    const exception = requireObject(value, label);
    requireExactKeys(
      exception,
      ["id", "packageName", "severity", "range", "via", "reviewedOn", "expiresOn", "reason"],
      label,
    );
    const parsed = {
      id: requireNonEmptyString(exception.id, `${label}.id`),
      packageName: requireNonEmptyString(exception.packageName, `${label}.packageName`),
      severity: requireSeverity(exception.severity, `${label}.severity`),
      range: requireNonEmptyString(exception.range, `${label}.range`),
      via: normalizeVia(exception.via, `${label}.via`, { allowSourceIds: true }),
      reviewedOn: requireDate(exception.reviewedOn, `${label}.reviewedOn`),
      expiresOn: requireDate(exception.expiresOn, `${label}.expiresOn`),
      reason: requireNonEmptyString(exception.reason, `${label}.reason`),
    };

    if (!policy.exceptionSeverities.includes(parsed.severity)) {
      throw new TypeError(
        `Audit exception ${parsed.id} has non-eligible severity ${parsed.severity}.`,
      );
    }
    if (parsed.reviewedOn > today) {
      throw new TypeError(`Audit exception ${parsed.id} has not been reviewed yet.`);
    }
    if (parsed.expiresOn <= today) {
      throw new TypeError(`Audit exception ${parsed.id} expired on ${parsed.expiresOn}.`);
    }
    if (parsed.expiresOn <= parsed.reviewedOn) {
      throw new TypeError(`Audit exception ${parsed.id} must expire after its review date.`);
    }
    if (ids.has(parsed.id)) throw new TypeError(`Duplicate audit exception id ${parsed.id}.`);
    ids.add(parsed.id);

    const key = exceptionKey(parsed);
    if (keys.has(key)) throw new TypeError(`Duplicate audit exception finding ${parsed.id}.`);
    keys.add(key);
    return { ...parsed, key };
  });
}

export function validateAuditReports({
  fullReport,
  productionReport,
  policy: policyValue,
  exceptions: exceptionValue,
  today = new Date().toISOString().slice(0, 10),
}) {
  const policy = parsePolicy(policyValue);
  today = requireDate(today, "Audit validation date");
  const production = parseAuditReport(
    productionReport,
    "Production audit report",
    policy.auditReportVersion,
  );
  const full = parseAuditReport(fullReport, "Full audit report", policy.auditReportVersion);
  const exceptions = parseExceptions(exceptionValue, policy, today);

  if (production.length > 0) {
    throw new TypeError(
      `Production advisories are forbidden: ${production.map(({ packageName }) => packageName).join(", ")}.`,
    );
  }
  const direct = full.filter((vulnerability) => vulnerability.isDirect);
  if (direct.length > 0) {
    throw new TypeError(
      `Direct development advisories are forbidden: ${direct.map(({ packageName }) => packageName).join(", ")}.`,
    );
  }

  const usedExceptionKeys = new Set();
  for (const vulnerability of full) {
    if (!policy.exceptionSeverities.includes(vulnerability.severity)) {
      throw new TypeError(
        `Transitive development advisory ${vulnerability.packageName} has non-eligible severity ${vulnerability.severity}.`,
      );
    }
    const key = exceptionKey(vulnerability);
    if (!exceptions.some((exception) => exception.key === key)) {
      throw new TypeError(
        `Transitive development advisory ${vulnerability.packageName} has no exact exception.`,
      );
    }
    usedExceptionKeys.add(key);
  }

  const unused = exceptions.filter((exception) => !usedExceptionKeys.has(exception.key));
  if (unused.length > 0) {
    throw new TypeError(
      `Audit exceptions do not match current findings: ${unused.map(({ id }) => id).join(", ")}.`,
    );
  }

  return {
    productionAdvisories: production.length,
    directDevelopmentAdvisories: direct.length,
    transitiveDevelopmentAdvisories: full.length,
    exceptions: exceptions.length,
  };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Unable to read ${label}: ${message}`, { cause: error });
  }
}

function runNpmAudit(args) {
  const npmExecutable = process.env.npm_execpath;
  const command = npmExecutable === undefined ? "npm" : process.execPath;
  const commandArguments = npmExecutable === undefined ? args : [npmExecutable, ...args];
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `npm ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}: ${result.stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new TypeError(`npm ${args.join(" ")} did not return a JSON audit report.`, {
      cause: error,
    });
  }
}

async function main() {
  if (process.argv.length !== 2) {
    throw new TypeError("Usage: node scripts/verify-audit.mjs");
  }
  const policy = readJson(resolve(repositoryRoot, "security/audit-policy.json"), "audit policy");
  const exceptions = readJson(
    resolve(repositoryRoot, "security/audit-exceptions.json"),
    "audit exceptions",
  );
  const productionReport = runNpmAudit(["audit", "--omit=dev", "--json"]);
  const fullReport = runNpmAudit(["audit", "--json"]);
  const summary = validateAuditReports({ fullReport, productionReport, policy, exceptions });
  process.stdout.write(
    `Audit policy passed: ${summary.productionAdvisories} production, ${summary.directDevelopmentAdvisories} direct development, ${summary.transitiveDevelopmentAdvisories} transitive development advisories (${summary.exceptions} exceptions).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`verify-audit: ${message}\n`);
    process.exitCode = 1;
  });
}
