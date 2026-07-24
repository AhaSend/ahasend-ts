#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalizeJson,
  digestJsonArtifact,
  digestYamlArtifact,
  sha256Hex,
} from "./digest-artifact.mjs";

export const REQUIRED_SOURCE_GATES = Object.freeze([
  "generation",
  "typecheck",
  "typed-lint",
  "unit-tests",
  "state-tests",
  "webhook-tests",
  "framework-tests",
  "coverage",
  "format",
  "test-policy",
  "repository-secret-scan",
  "audit",
]);

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const CONTRACT_PATHS = Object.freeze(["contracts.lock.json", "openapi.yaml", "webhooks.yaml"]);
const KEY_PATHS = Object.freeze([
  "contracts/webhooks/captured/keys/configured-webhook.key",
  "contracts/webhooks/captured/keys/route.key",
]);

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TypeError(
      `${label} fields must be canonical: missing ${JSON.stringify(missing)}, unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase hexadecimal SHA-256 value.`);
  }
  return value;
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) {
    throw new TypeError(`${label} must be a full lowercase Git commit.`);
  }
  return value;
}

function sourceBytes(value, label) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${label} must be bytes or a UTF-8 string.`);
}

function parseSidecar(source, label) {
  const bytes = sourceBytes(source, label);
  let value;
  try {
    value = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} must be UTF-8.`, { cause: error });
  }
  if (!/^[0-9a-f]{64}\n$/u.test(value)) {
    throw new TypeError(`${label} must contain one lowercase SHA-256 value and a newline.`);
  }
  return value.slice(0, -1);
}

function parseCanonicalReport(source) {
  const bytes = sourceBytes(source, "Source gate report");
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(bytes));
  } catch (error) {
    throw new TypeError("Source gate report must be valid UTF-8 JSON.", { cause: error });
  }

  let canonical;
  try {
    canonical = canonicalizeJson(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes("forbidden self-digest")) {
      throw error;
    }
    throw new TypeError("Source gate report is not a canonical JSON payload.", { cause: error });
  }
  if (!bytes.equals(canonical)) {
    throw new TypeError("Source gate report must use RFC 8785 canonical JSON bytes.");
  }
  return requireObject(value, "Source gate report");
}

function parseHashMap(value, paths, label) {
  const map = requireObject(value, label);
  requireExactKeys(map, paths, label);
  return Object.fromEntries(
    paths.map((path) => [path, requireHash(map[path], `${label}[${JSON.stringify(path)}]`)]),
  );
}

function parseReport(value) {
  requireExactKeys(
    value,
    [
      "auditPolicySha256",
      "captureSha256",
      "commit",
      "contractSha256",
      "keysSha256",
      "lockfileSha256",
      "profileSha256",
      "results",
      "version",
    ],
    "Source gate report",
  );
  if (value.version !== 1) throw new TypeError("Source gate report version must be 1.");
  const commit = requireCommit(value.commit, "Source gate report commit");
  const contractSha256 = parseHashMap(
    value.contractSha256,
    CONTRACT_PATHS,
    "Source gate report contractSha256",
  );
  const keysSha256 = parseHashMap(value.keysSha256, KEY_PATHS, "Source gate report keysSha256");
  const profileSha256 = requireHash(value.profileSha256, "Source gate report profileSha256");
  const captureSha256 = requireHash(value.captureSha256, "Source gate report captureSha256");
  const lockfileSha256 = requireHash(value.lockfileSha256, "Source gate report lockfileSha256");
  const auditPolicySha256 = requireHash(
    value.auditPolicySha256,
    "Source gate report auditPolicySha256",
  );

  if (!Array.isArray(value.results)) {
    throw new TypeError("Source gate report results must be an array.");
  }
  const seen = new Set();
  for (const [index, resultValue] of value.results.entries()) {
    const label = `Source gate result ${index}`;
    const result = requireObject(resultValue, label);
    requireExactKeys(result, ["name", "passed"], label);
    if (typeof result.name !== "string" || !REQUIRED_SOURCE_GATES.includes(result.name)) {
      throw new TypeError(`${label}.name is not a required source gate.`);
    }
    if (seen.has(result.name)) {
      throw new TypeError(`Source gate report contains duplicate result ${result.name}.`);
    }
    seen.add(result.name);
    if (result.passed !== true) {
      throw new TypeError(`Required source gate ${result.name} did not pass.`);
    }
  }

  const missing = REQUIRED_SOURCE_GATES.filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new TypeError(`Source gate report is missing required gates: ${missing.join(", ")}.`);
  }
  if (value.results.length !== REQUIRED_SOURCE_GATES.length) {
    throw new TypeError(
      `Source gate report must contain exactly ${REQUIRED_SOURCE_GATES.length} results.`,
    );
  }

  return {
    commit,
    contractSha256,
    profileSha256,
    captureSha256,
    keysSha256,
    lockfileSha256,
    auditPolicySha256,
  };
}

function parseExpectedBindings(value) {
  const expected = requireObject(value, "Expected source bindings");
  requireExactKeys(
    expected,
    [
      "auditPolicySha256",
      "captureSha256",
      "commit",
      "contractSha256",
      "keysSha256",
      "lockfileSha256",
      "profileSha256",
    ],
    "Expected source bindings",
  );
  return {
    commit: requireCommit(expected.commit, "Expected source commit"),
    contractSha256: parseHashMap(
      expected.contractSha256,
      CONTRACT_PATHS,
      "Expected contractSha256",
    ),
    profileSha256: requireHash(expected.profileSha256, "Expected profileSha256"),
    captureSha256: requireHash(expected.captureSha256, "Expected captureSha256"),
    keysSha256: parseHashMap(expected.keysSha256, KEY_PATHS, "Expected keysSha256"),
    lockfileSha256: requireHash(expected.lockfileSha256, "Expected lockfileSha256"),
    auditPolicySha256: requireHash(expected.auditPolicySha256, "Expected auditPolicySha256"),
  };
}

function requireBinding(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`Source gate report references a stale ${label}.`);
  }
}

function compareBindings(report, expected) {
  requireBinding(report.commit, expected.commit, "commit");
  for (const path of CONTRACT_PATHS) {
    requireBinding(report.contractSha256[path], expected.contractSha256[path], path);
  }
  requireBinding(report.profileSha256, expected.profileSha256, "operation profile");
  requireBinding(report.captureSha256, expected.captureSha256, "capture manifest");
  for (const path of KEY_PATHS) {
    requireBinding(report.keysSha256[path], expected.keysSha256[path], path);
  }
  requireBinding(report.lockfileSha256, expected.lockfileSha256, "package lockfile");
  requireBinding(report.auditPolicySha256, expected.auditPolicySha256, "audit policy");
}

export function validateSourceGateReport({ reportSource, reportSidecar, expectedBindings }) {
  const reportBytes = sourceBytes(reportSource, "Source gate report");
  const sidecarDigest = parseSidecar(reportSidecar, "Source gate report sidecar");
  const reportDigest = sha256Hex(reportBytes);
  if (sidecarDigest !== reportDigest) {
    throw new TypeError(
      `Source gate report sidecar mismatch: expected ${reportDigest}, received ${sidecarDigest}.`,
    );
  }

  // The detached digest deliberately authenticates the bytes before they are parsed.
  const report = parseReport(parseCanonicalReport(reportBytes));
  const expected = parseExpectedBindings(expectedBindings);
  compareBindings(report, expected);

  return {
    commit: report.commit,
    reportDigest,
    gates: REQUIRED_SOURCE_GATES.length,
  };
}

async function readJsonDigest(path, label, sidecarPath) {
  const source = await readFile(resolve(repositoryRoot, path));
  let value;
  try {
    value = JSON.parse(utf8Decoder.decode(source));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
  const digest = digestJsonArtifact(value);
  if (sidecarPath !== undefined) {
    const detached = parseSidecar(
      await readFile(resolve(repositoryRoot, sidecarPath)),
      `${label} sidecar`,
    );
    if (detached !== digest) {
      throw new TypeError(`${label} does not match its detached sidecar.`);
    }
  }
  return digest;
}

export async function readRepositorySourceBindings() {
  const [
    contractsLock,
    openapi,
    webhooks,
    profileSha256,
    captureSha256,
    configuredWebhookKey,
    routeKey,
    lockfileSha256,
    auditPolicySha256,
  ] = await Promise.all([
    readJsonDigest("contracts.lock.json", "Contract lock"),
    readFile(resolve(repositoryRoot, "openapi.yaml")),
    readFile(resolve(repositoryRoot, "webhooks.yaml")),
    readJsonDigest(
      "src/generated/operation-profile.json",
      "Operation profile",
      "src/generated/operation-profile.sha256",
    ),
    readJsonDigest(
      "contracts/webhooks/captured/manifest.json",
      "Capture manifest",
      "contracts/webhooks/captured/manifest.sha256",
    ),
    readFile(resolve(repositoryRoot, KEY_PATHS[0])),
    readFile(resolve(repositoryRoot, KEY_PATHS[1])),
    readJsonDigest("package-lock.json", "Package lockfile"),
    readJsonDigest("security/audit-policy.json", "Audit policy"),
  ]);

  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();

  return {
    commit: requireCommit(commit, "Repository commit"),
    contractSha256: {
      "contracts.lock.json": contractsLock,
      "openapi.yaml": digestYamlArtifact(openapi),
      "webhooks.yaml": digestYamlArtifact(webhooks),
    },
    profileSha256,
    captureSha256,
    keysSha256: {
      [KEY_PATHS[0]]: sha256Hex(configuredWebhookKey),
      [KEY_PATHS[1]]: sha256Hex(routeKey),
    },
    lockfileSha256,
    auditPolicySha256,
  };
}

async function main() {
  const [reportPath, suppliedSidecarPath, ...extraArguments] = process.argv.slice(2);
  if (reportPath === undefined || extraArguments.length > 0) {
    throw new TypeError(
      "Usage: node scripts/run-source-gates.mjs <source-report.json> [source-report.sha256]",
    );
  }
  const sidecarPath =
    suppliedSidecarPath ??
    (reportPath.endsWith(".json") ? `${reportPath.slice(0, -5)}.sha256` : `${reportPath}.sha256`);
  const [reportSource, reportSidecar, expectedBindings] = await Promise.all([
    readFile(resolve(reportPath)),
    readFile(resolve(sidecarPath)),
    readRepositorySourceBindings(),
  ]);
  const summary = validateSourceGateReport({
    reportSource,
    reportSidecar,
    expectedBindings,
  });
  process.stdout.write(
    `Source gate report passed: ${summary.gates} gates for ${summary.commit} (${summary.reportDigest}).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`run-source-gates: ${message}\n`);
    process.exitCode = 1;
  });
}
