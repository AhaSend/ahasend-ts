#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "./digest-artifact.mjs";
import { collectOperations, parseOpenApi } from "./generate-contracts.mjs";
import {
  AUTHORIZATION_REGISTRY,
  validateAuthorizationRegistry,
  validateOperationProfile,
} from "./generate-sdk.mjs";
import {
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  sourceBytes,
} from "./report-validation.mjs";
import { readRepositorySourceBindings, validateSourceGateReport } from "./run-source-gates.mjs";
import { validateRendererReport } from "./verify-renderer-report.mjs";

const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const CONTRACT_PATHS = Object.freeze(["contracts.lock.json", "openapi.yaml", "webhooks.yaml"]);
const KEY_PATHS = Object.freeze([
  "contracts/webhooks/captured/keys/configured-webhook.key",
  "contracts/webhooks/captured/keys/route.key",
]);
const EXPECTED_OPERATION_COUNT = 56;
const EXPECTED_ITERATOR_COUNT = 9;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDirectories = [".betterborg-task/", ".orchestry/", ".betterborg-analysis/"];

function requireCommit(value, label) {
  if (typeof value !== "string" || !GIT_COMMIT.test(value)) {
    throw new TypeError(`${label} must be a full lowercase Git commit.`);
  }
  return value;
}

function parseHashMap(value, paths, label) {
  const map = requireObject(value, label);
  requireExactKeys(map, paths, label);
  return Object.fromEntries(
    paths.map((path) => [path, requireHash(map[path], `${label}[${JSON.stringify(path)}]`)]),
  );
}

function parseCandidateManifest(value) {
  requireExactKeys(
    value,
    [
      "captureSha256",
      "commit",
      "contractSha256",
      "keysSha256",
      "profileSha256",
      "rendererReportSha256",
      "sourceReportSha256",
      "tarballSha256",
      "version",
    ],
    "Candidate manifest",
  );
  if (value.version !== 1) throw new TypeError("Candidate manifest version must be 1.");
  return {
    version: 1,
    commit: requireCommit(value.commit, "Candidate manifest commit"),
    sourceReportSha256: requireHash(
      value.sourceReportSha256,
      "Candidate manifest sourceReportSha256",
    ),
    contractSha256: parseHashMap(
      value.contractSha256,
      CONTRACT_PATHS,
      "Candidate manifest contractSha256",
    ),
    captureSha256: requireHash(value.captureSha256, "Candidate manifest captureSha256"),
    keysSha256: parseHashMap(value.keysSha256, KEY_PATHS, "Candidate manifest keysSha256"),
    rendererReportSha256: requireHash(
      value.rendererReportSha256,
      "Candidate manifest rendererReportSha256",
    ),
    profileSha256: requireHash(value.profileSha256, "Candidate manifest profileSha256"),
    tarballSha256: requireHash(value.tarballSha256, "Candidate manifest tarballSha256"),
  };
}

function parseExpectedCandidateBindings(value) {
  const expected = requireObject(value, "Expected candidate bindings");
  requireExactKeys(
    expected,
    [
      "captureSha256",
      "commit",
      "contractSha256",
      "keysSha256",
      "profileSha256",
      "rendererReportSha256",
      "sourceReportSha256",
      "tarballSha256",
    ],
    "Expected candidate bindings",
  );
  return parseCandidateManifest({ version: 1, ...expected });
}

function requireBinding(actual, expected, label) {
  if (actual !== expected) {
    throw new TypeError(`Candidate manifest references a stale ${label}.`);
  }
}

function compareCandidateBindings(manifest, expected) {
  requireBinding(manifest.commit, expected.commit, "commit");
  requireBinding(manifest.sourceReportSha256, expected.sourceReportSha256, "source report");
  for (const path of CONTRACT_PATHS) {
    requireBinding(manifest.contractSha256[path], expected.contractSha256[path], path);
  }
  requireBinding(manifest.captureSha256, expected.captureSha256, "capture manifest");
  for (const path of KEY_PATHS) {
    requireBinding(manifest.keysSha256[path], expected.keysSha256[path], path);
  }
  requireBinding(manifest.rendererReportSha256, expected.rendererReportSha256, "renderer report");
  requireBinding(manifest.profileSha256, expected.profileSha256, "operation profile");
  requireBinding(manifest.tarballSha256, expected.tarballSha256, "tarball");
}

export function validateCandidateManifest({ manifestSource, manifestSidecar, expectedBindings }) {
  const manifestBytes = sourceBytes(manifestSource, "Candidate manifest");
  const sidecarDigest = parseSha256Sidecar(manifestSidecar, "Candidate manifest sidecar");
  const manifestDigest = sha256Hex(manifestBytes);
  if (sidecarDigest !== manifestDigest) {
    throw new TypeError(
      `Candidate manifest sidecar mismatch: expected ${manifestDigest}, received ${sidecarDigest}.`,
    );
  }

  const manifest = parseCandidateManifest(
    parseCanonicalJson(manifestBytes, "Candidate manifest").value,
  );
  compareCandidateBindings(manifest, parseExpectedCandidateBindings(expectedBindings));
  return { commit: manifest.commit, manifestDigest, tarballDigest: manifest.tarballSha256 };
}

function validateStandardSecurity(document) {
  const root = requireObject(document, "OpenAPI document");
  const components = requireObject(root.components, "OpenAPI components");
  const securitySchemes = requireObject(components.securitySchemes, "OpenAPI security schemes");
  const bearer = requireObject(securitySchemes.BearerAuth, "BearerAuth security scheme");
  if (bearer.type !== "http" || bearer.scheme !== "bearer") {
    throw new TypeError("Packaged operation metadata requires standard HTTP bearer security.");
  }

  const operations = collectOperations(document);
  if (operations.length !== EXPECTED_OPERATION_COUNT) {
    throw new TypeError(
      `Packaged operation metadata must describe ${EXPECTED_OPERATION_COUNT} operations.`,
    );
  }
  for (const { operationId, operation } of operations) {
    if (!Array.isArray(operation.security) || operation.security.length === 0) {
      throw new TypeError(`Packaged operation metadata is missing security for ${operationId}.`);
    }
    for (const requirementValue of operation.security) {
      const requirement = requireObject(
        requirementValue,
        `Packaged operation metadata security for ${operationId}`,
      );
      requireExactKeys(
        requirement,
        ["BearerAuth"],
        `Packaged operation metadata security for ${operationId}`,
      );
      if (
        !Array.isArray(requirement.BearerAuth) ||
        requirement.BearerAuth.some((role) => typeof role !== "string")
      ) {
        throw new TypeError(
          `Packaged operation metadata has invalid BearerAuth roles for ${operationId}.`,
        );
      }
    }
  }
  return operations;
}

function parseJson(source, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes(source, label)));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

export function validatePackagedOperationProfile({
  packagedProfileSource,
  packagedProfileSidecar,
  sourceProfileSource,
  sourceProfileSidecar,
  openApiSource,
}) {
  const packagedProfileBytes = sourceBytes(packagedProfileSource, "Packaged operation profile");
  const packagedSidecarBytes = sourceBytes(
    packagedProfileSidecar,
    "Packaged operation profile sidecar",
  );
  const sourceProfileBytes = sourceBytes(sourceProfileSource, "Source operation profile");
  const sourceSidecarBytes = sourceBytes(sourceProfileSidecar, "Source operation profile sidecar");
  if (
    !packagedProfileBytes.equals(sourceProfileBytes) ||
    !packagedSidecarBytes.equals(sourceSidecarBytes)
  ) {
    throw new TypeError("Packaged operation metadata must match generated source bytes exactly.");
  }

  const profile = parseJson(packagedProfileBytes, "Packaged operation profile");
  const detachedDigest = parseSha256Sidecar(
    packagedSidecarBytes,
    "Packaged operation profile sidecar",
  );
  const actualDigest = digestJsonArtifact(profile);
  if (detachedDigest !== actualDigest) {
    throw new TypeError("Packaged operation profile does not match its detached sidecar.");
  }

  const document = parseOpenApi(
    new TextDecoder("utf-8", { fatal: true }).decode(
      sourceBytes(openApiSource, "OpenAPI contract"),
    ),
  );
  validateStandardSecurity(document);
  validateOperationProfile(document, profile);
  validateAuthorizationRegistry(document);

  if (
    !Array.isArray(profile.operations) ||
    profile.operations.length !== EXPECTED_OPERATION_COUNT ||
    !Array.isArray(profile.iterators) ||
    profile.iterators.length !== EXPECTED_ITERATOR_COUNT
  ) {
    throw new TypeError(
      `Packaged operation metadata requires ${EXPECTED_OPERATION_COUNT} primary mappings and ${EXPECTED_ITERATOR_COUNT} iterators.`,
    );
  }

  return {
    profileDigest: actualDigest,
    operations: profile.operations.length,
    iterators: profile.iterators.length,
    resourceAuthorizationRules: Object.keys(AUTHORIZATION_REGISTRY).length,
  };
}

export function validateCleanCommit({ commit, expectedCommit, status }) {
  const actualCommit = requireCommit(commit.trim(), "Repository commit");
  const sourceCommit = requireCommit(expectedCommit, "Source report commit");
  if (actualCommit !== sourceCommit) {
    throw new TypeError(
      `Repository commit ${actualCommit} does not match source report commit ${sourceCommit}.`,
    );
  }

  const dirty = status
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((line) => {
      const path = line.slice(3).replace(/^"|"$/gu, "");
      return !harnessDirectories.some(
        (directory) => path === directory.slice(0, -1) || path.startsWith(directory),
      );
    });
  if (dirty.length > 0) {
    throw new TypeError(`Candidate construction requires a clean commit: ${dirty.join(", ")}.`);
  }
  return actualCommit;
}

function defaultRunCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    env: { ...process.env, FORCE_COLOR: "0" },
    maxBuffer: 20 * 1024 * 1024,
  });
}

function npmInvocation(args) {
  const npmExecutable = process.env.npm_execpath;
  return npmExecutable === undefined
    ? { command: "npm", args }
    : { command: process.execPath, args: [npmExecutable, ...args] };
}

function runNpm(runCommand, args, cwd) {
  const invocation = npmInvocation(args);
  return runCommand(invocation.command, invocation.args, { cwd, encoding: "utf8" });
}

function extractPackageFile(runCommand, tarballPath, packagePath, cwd) {
  return runCommand("tar", ["-xOf", tarballPath, `package/${packagePath}`], { cwd });
}

function parsePackResult(output) {
  let value;
  try {
    value = JSON.parse(String(output));
  } catch (error) {
    throw new TypeError("npm pack did not return valid JSON.", { cause: error });
  }
  if (!Array.isArray(value) || value.length !== 1) {
    const count = Array.isArray(value) ? value.length : 0;
    throw new TypeError(`npm pack must produce exactly one package, received ${count}.`);
  }
  const result = requireObject(value[0], "npm pack result");
  if (
    typeof result.filename !== "string" ||
    basename(result.filename) !== result.filename ||
    !result.filename.endsWith(".tgz")
  ) {
    throw new TypeError("npm pack returned an invalid tarball filename.");
  }
  return result.filename;
}

export async function createCandidate({
  sourceReportPath,
  sourceReportSidecarPath,
  rendererReportPath,
  outputDirectory,
  runCommand = defaultRunCommand,
}) {
  const sourcePath = resolve(sourceReportPath);
  const sourceSidecarPath =
    sourceReportSidecarPath === undefined
      ? sourcePath.endsWith(".json")
        ? `${sourcePath.slice(0, -5)}.sha256`
        : `${sourcePath}.sha256`
      : resolve(sourceReportSidecarPath);
  const rendererPath = resolve(rendererReportPath);
  const destination = resolve(outputDirectory);

  const [sourceReport, sourceSidecar, rendererReport, expectedSourceBindings] = await Promise.all([
    readFile(sourcePath),
    readFile(sourceSidecarPath),
    readFile(rendererPath),
    readRepositorySourceBindings(),
  ]);
  const commit = validateCleanCommit({
    commit: String(
      runCommand("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    ),
    expectedCommit: expectedSourceBindings.commit,
    status: String(
      runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }),
    ),
  });
  const sourceSummary = validateSourceGateReport({
    reportSource: sourceReport,
    reportSidecar: sourceSidecar,
    expectedBindings: expectedSourceBindings,
  });

  const [handoffSource, handoffSidecar, sourceProfile, sourceProfileSidecar, openApiSource] =
    await Promise.all([
      readFile(resolve(repositoryRoot, "docs/renderer-handoff.json")),
      readFile(resolve(repositoryRoot, "docs/renderer-handoff.sha256")),
      readFile(resolve(repositoryRoot, "src/generated/operation-profile.json")),
      readFile(resolve(repositoryRoot, "src/generated/operation-profile.sha256")),
      readFile(resolve(repositoryRoot, "openapi.yaml")),
    ]);
  validateRendererReport({
    handoffSource,
    handoffSidecar,
    reportSource: rendererReport,
  });
  const rendererReportSha256 = sha256Hex(rendererReport);

  const stagingDirectory = await mkdtemp(join(tmpdir(), "ahasend-sdk-candidate-"));
  try {
    runNpm(runCommand, ["run", "build"], repositoryRoot);
    const packOutput = runNpm(
      runCommand,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", stagingDirectory],
      repositoryRoot,
    );
    const tarballName = parsePackResult(packOutput);
    const tarballs = (await readdir(stagingDirectory)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1 || tarballs[0] !== tarballName) {
      throw new TypeError(
        `Candidate construction requires exactly one npm pack tarball, received ${tarballs.length}.`,
      );
    }
    const tarballPath = resolve(stagingDirectory, tarballName);
    const packagedProfile = extractPackageFile(
      runCommand,
      tarballPath,
      "dist/_metadata/operation-profile.json",
      repositoryRoot,
    );
    const packagedProfileSidecar = extractPackageFile(
      runCommand,
      tarballPath,
      "dist/_metadata/operation-profile.sha256",
      repositoryRoot,
    );
    const profileSummary = validatePackagedOperationProfile({
      packagedProfileSource: packagedProfile,
      packagedProfileSidecar,
      sourceProfileSource: sourceProfile,
      sourceProfileSidecar,
      openApiSource,
    });
    requireBinding(
      profileSummary.profileDigest,
      expectedSourceBindings.profileSha256,
      "operation profile",
    );

    const tarballSha256 = sha256Hex(await readFile(tarballPath));
    const candidateBindings = {
      commit,
      sourceReportSha256: sourceSummary.reportDigest,
      contractSha256: expectedSourceBindings.contractSha256,
      captureSha256: expectedSourceBindings.captureSha256,
      keysSha256: expectedSourceBindings.keysSha256,
      rendererReportSha256,
      profileSha256: profileSummary.profileDigest,
      tarballSha256,
    };
    const manifestSource = canonicalizeJson({ version: 1, ...candidateBindings });
    const manifestDigest = sha256Hex(manifestSource);
    const manifestSidecar = Buffer.from(`${manifestDigest}\n`, "utf8");
    validateCandidateManifest({
      manifestSource,
      manifestSidecar,
      expectedBindings: candidateBindings,
    });

    await mkdir(destination, { recursive: true });
    const manifestPath = resolve(destination, "candidate-manifest.json");
    const manifestSidecarPath = resolve(destination, "candidate-manifest.sha256");
    const destinationTarball = resolve(destination, tarballName);
    await Promise.all([
      copyFile(tarballPath, destinationTarball, constants.COPYFILE_EXCL),
      writeFile(manifestPath, manifestSource, { flag: "wx" }),
      writeFile(manifestSidecarPath, manifestSidecar, { flag: "wx" }),
    ]);
    return {
      commit,
      manifestDigest,
      manifestPath,
      manifestSidecarPath,
      tarballPath: destinationTarball,
      tarballDigest: tarballSha256,
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const [sourceReportPath, rendererReportPath, outputDirectory, suppliedSidecarPath, ...extra] =
    process.argv.slice(2);
  if (
    sourceReportPath === undefined ||
    rendererReportPath === undefined ||
    outputDirectory === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      "Usage: node scripts/create-candidate.mjs <source-report.json> <renderer-report.json> <output-directory> [source-report.sha256]",
    );
  }
  const result = await createCandidate({
    sourceReportPath,
    rendererReportPath,
    outputDirectory,
    ...(suppliedSidecarPath === undefined ? {} : { sourceReportSidecarPath: suppliedSidecarPath }),
  });
  process.stdout.write(
    `Candidate created for ${result.commit}: ${result.tarballPath} (${result.tarballDigest}); manifest ${result.manifestDigest}.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-candidate: ${message}\n`);
    process.exitCode = 1;
  });
}
