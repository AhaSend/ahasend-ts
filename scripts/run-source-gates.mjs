#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestJsonArtifact, digestYamlArtifact, sha256Hex } from "./digest-artifact.mjs";
import {
  decodeUtf8,
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireExactPassedGateResults,
  requireHash,
  requireObject,
  sourceBytes,
} from "./report-validation.mjs";

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
  "documentation-workflows",
]);

const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE_CONTRACT_PATHS = Object.freeze([
  "contracts.lock.json",
  "openapi.yaml",
  "webhooks.yaml",
]);
export const SOURCE_KEY_PATHS = Object.freeze([
  "contracts/webhooks/captured/keys/configured-webhook.key",
  "contracts/webhooks/captured/keys/route.key",
]);

export function requireSourceCommit(value, label) {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) {
    throw new TypeError(`${label} must be a full lowercase Git commit.`);
  }
  return value;
}

export function parseSourceHashMap(value, paths, label) {
  const map = requireObject(value, label);
  requireExactKeys(map, paths, label);
  return Object.fromEntries(
    paths.map((path) => [path, requireHash(map[path], `${label}[${JSON.stringify(path)}]`)]),
  );
}

export function requireSourceBinding(actual, expected, label, owner = "Source gate report") {
  if (actual !== expected) {
    throw new TypeError(`${owner} references a stale ${label}.`);
  }
}

export function compareSourceArtifactBindings(actual, expected, owner = "Source gate report") {
  requireSourceBinding(actual.commit, expected.commit, "commit", owner);
  for (const path of SOURCE_CONTRACT_PATHS) {
    requireSourceBinding(actual.contractSha256[path], expected.contractSha256[path], path, owner);
  }
  requireSourceBinding(actual.profileSha256, expected.profileSha256, "operation profile", owner);
  requireSourceBinding(actual.captureSha256, expected.captureSha256, "capture manifest", owner);
  for (const path of SOURCE_KEY_PATHS) {
    requireSourceBinding(actual.keysSha256[path], expected.keysSha256[path], path, owner);
  }
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
  const commit = requireSourceCommit(value.commit, "Source gate report commit");
  const contractSha256 = parseSourceHashMap(
    value.contractSha256,
    SOURCE_CONTRACT_PATHS,
    "Source gate report contractSha256",
  );
  const keysSha256 = parseSourceHashMap(
    value.keysSha256,
    SOURCE_KEY_PATHS,
    "Source gate report keysSha256",
  );
  const profileSha256 = requireHash(value.profileSha256, "Source gate report profileSha256");
  const captureSha256 = requireHash(value.captureSha256, "Source gate report captureSha256");
  const lockfileSha256 = requireHash(value.lockfileSha256, "Source gate report lockfileSha256");
  const auditPolicySha256 = requireHash(
    value.auditPolicySha256,
    "Source gate report auditPolicySha256",
  );

  requireExactPassedGateResults(value.results, REQUIRED_SOURCE_GATES, {
    reportLabel: "Source gate report",
    resultLabel: "Source gate result",
    gateLabel: "source gate",
    gatesLabel: "gates",
  });

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
    commit: requireSourceCommit(expected.commit, "Expected source commit"),
    contractSha256: parseSourceHashMap(
      expected.contractSha256,
      SOURCE_CONTRACT_PATHS,
      "Expected contractSha256",
    ),
    profileSha256: requireHash(expected.profileSha256, "Expected profileSha256"),
    captureSha256: requireHash(expected.captureSha256, "Expected captureSha256"),
    keysSha256: parseSourceHashMap(expected.keysSha256, SOURCE_KEY_PATHS, "Expected keysSha256"),
    lockfileSha256: requireHash(expected.lockfileSha256, "Expected lockfileSha256"),
    auditPolicySha256: requireHash(expected.auditPolicySha256, "Expected auditPolicySha256"),
  };
}

function compareBindings(report, expected) {
  compareSourceArtifactBindings(report, expected);
  requireSourceBinding(report.lockfileSha256, expected.lockfileSha256, "package lockfile");
  requireSourceBinding(report.auditPolicySha256, expected.auditPolicySha256, "audit policy");
}

export function validateSourceGateReport({ reportSource, reportSidecar, expectedBindings }) {
  const reportBytes = sourceBytes(reportSource, "Source gate report");
  const sidecarDigest = parseSha256Sidecar(reportSidecar, "Source gate report sidecar");
  const reportDigest = sha256Hex(reportBytes);
  if (sidecarDigest !== reportDigest) {
    throw new TypeError(
      `Source gate report sidecar mismatch: expected ${reportDigest}, received ${sidecarDigest}.`,
    );
  }

  // The detached digest deliberately authenticates the bytes before they are parsed.
  const report = parseReport(parseCanonicalJson(reportBytes, "Source gate report").value);
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
    value = JSON.parse(decodeUtf8(source, label));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
  const digest = digestJsonArtifact(value);
  if (sidecarPath !== undefined) {
    const detached = parseSha256Sidecar(
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
    readFile(resolve(repositoryRoot, SOURCE_KEY_PATHS[0])),
    readFile(resolve(repositoryRoot, SOURCE_KEY_PATHS[1])),
    readJsonDigest("package-lock.json", "Package lockfile"),
    readJsonDigest("security/audit-policy.json", "Audit policy"),
  ]);

  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();

  return {
    commit: requireSourceCommit(commit, "Repository commit"),
    contractSha256: {
      "contracts.lock.json": contractsLock,
      "openapi.yaml": digestYamlArtifact(openapi),
      "webhooks.yaml": digestYamlArtifact(webhooks),
    },
    profileSha256,
    captureSha256,
    keysSha256: {
      [SOURCE_KEY_PATHS[0]]: sha256Hex(configuredWebhookKey),
      [SOURCE_KEY_PATHS[1]]: sha256Hex(routeKey),
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
