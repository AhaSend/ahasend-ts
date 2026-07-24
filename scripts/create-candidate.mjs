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
import {
  compareSourceArtifactBindings,
  parseSourceHashMap,
  readRepositorySourceBindings,
  requireSourceBinding,
  requireSourceCommit,
  SOURCE_CONTRACT_PATHS,
  SOURCE_KEY_PATHS,
  validateSourceGateReport,
} from "./run-source-gates.mjs";
import { validateRendererReport } from "./verify-renderer-report.mjs";

const EXPECTED_OPERATION_COUNT = 56;
const EXPECTED_ITERATOR_COUNT = 9;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const harnessDirectories = [".betterborg-task/", ".orchestry/", ".betterborg-analysis/"];

export function parseCandidateManifest(value, label = "Candidate manifest") {
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
    label,
  );
  if (value.version !== 1) throw new TypeError(`${label} version must be 1.`);
  return {
    version: 1,
    commit: requireSourceCommit(value.commit, `${label} commit`),
    sourceReportSha256: requireHash(value.sourceReportSha256, `${label} sourceReportSha256`),
    contractSha256: parseSourceHashMap(
      value.contractSha256,
      SOURCE_CONTRACT_PATHS,
      `${label} contractSha256`,
    ),
    captureSha256: requireHash(value.captureSha256, `${label} captureSha256`),
    keysSha256: parseSourceHashMap(value.keysSha256, SOURCE_KEY_PATHS, `${label} keysSha256`),
    rendererReportSha256: requireHash(value.rendererReportSha256, `${label} rendererReportSha256`),
    profileSha256: requireHash(value.profileSha256, `${label} profileSha256`),
    tarballSha256: requireHash(value.tarballSha256, `${label} tarballSha256`),
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

function compareCandidateBindings(manifest, expected) {
  compareSourceArtifactBindings(manifest, expected, "Candidate manifest");
  requireSourceBinding(
    manifest.sourceReportSha256,
    expected.sourceReportSha256,
    "source report",
    "Candidate manifest",
  );
  requireSourceBinding(
    manifest.rendererReportSha256,
    expected.rendererReportSha256,
    "renderer report",
    "Candidate manifest",
  );
  requireSourceBinding(
    manifest.profileSha256,
    expected.profileSha256,
    "operation profile",
    "Candidate manifest",
  );
  requireSourceBinding(
    manifest.tarballSha256,
    expected.tarballSha256,
    "tarball",
    "Candidate manifest",
  );
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

function objectLiteralToJson(source) {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      result += character;
      for (index += 1; index < source.length; index += 1) {
        const stringCharacter = source[index];
        result += stringCharacter;
        if (stringCharacter === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) return result;
          result += escaped;
          index += 1;
        } else if (stringCharacter === '"') {
          break;
        }
      }
      continue;
    }
    if (character === "'") {
      result += '"';
      for (index += 1; index < source.length; index += 1) {
        const stringCharacter = source[index];
        if (stringCharacter === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) return result;
          result += escaped === "'" ? "'" : `\\${escaped}`;
          index += 1;
        } else if (stringCharacter === '"') {
          result += '\\"';
        } else if (stringCharacter === "'") {
          result += '"';
          break;
        } else {
          result += stringCharacter;
        }
      }
      continue;
    }
    if (character === "`") {
      throw new TypeError("Template literals are not static JSON values.");
    }
    if (character === ",") {
      let next = index + 1;
      while (/\s/u.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    if (/[$A-Z_a-z]/u.test(character)) {
      let end = index + 1;
      while (/[$\w]/u.test(source[end] ?? "")) end += 1;
      let colon = end;
      while (/\s/u.test(source[colon] ?? "")) colon += 1;
      if (source[colon] === ":") {
        result += `${JSON.stringify(source.slice(index, end))}${source.slice(end, colon + 1)}`;
        index = colon;
        continue;
      }
    }
    result += character;
  }
  return result;
}

function extractOperationDescriptors(source) {
  const label = "Packaged operation descriptors";
  const text = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes(source, label));
  const declarations = ["var OPERATION_DESCRIPTORS = ", "export const OPERATION_DESCRIPTORS = "];
  let start = -1;
  for (const declaration of declarations) {
    const declarationStart = text.indexOf(declaration);
    if (declarationStart !== -1) {
      start = declarationStart + declaration.length;
      break;
    }
  }
  if (start === -1 || text[start] !== "{") {
    throw new TypeError(`${label} are missing from the packaged entry module.`);
  }

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== "") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const expression = text.slice(start, index + 1);
        try {
          return requireObject(JSON.parse(objectLiteralToJson(expression)), label);
        } catch (error) {
          throw new TypeError(`${label} must contain a static object literal.`, { cause: error });
        }
      }
    }
  }
  throw new TypeError(`${label} contain an unterminated object literal.`);
}

function requireSameJson(actual, expected, label) {
  let actualBytes;
  let expectedBytes;
  try {
    actualBytes = canonicalizeJson(actual);
    expectedBytes = canonicalizeJson(expected);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-compatible.`, { cause: error });
  }
  if (!actualBytes.equals(expectedBytes)) {
    throw new TypeError(`${label} do not match the generated source contract.`);
  }
}

function validatePackagedOperationDescriptors(source, document, operations) {
  const descriptors = extractOperationDescriptors(source);
  const operationIds = operations.map(({ operationId }) => operationId);
  requireExactKeys(descriptors, operationIds, "Packaged operation descriptors");

  let resourceAuthorizationRules = 0;
  for (const { operationId, operation } of operations) {
    const descriptor = requireObject(
      descriptors[operationId],
      `Packaged operation descriptor ${operationId}`,
    );
    const requirements = operation.security ?? document.security;
    const expectedSecurity = requirements.map((requirement) => requirement.BearerAuth);
    requireSameJson(
      descriptor.security,
      expectedSecurity,
      `Packaged security metadata for ${operationId}`,
    );

    const expectedAuthorization = AUTHORIZATION_REGISTRY[operationId] ?? null;
    requireSameJson(
      descriptor.resourceAuthorization,
      expectedAuthorization,
      `Packaged resource authorization metadata for ${operationId}`,
    );
    if (descriptor.resourceAuthorization !== null) resourceAuthorizationRules += 1;
  }
  return resourceAuthorizationRules;
}

export function validatePackagedOperationProfile({
  packagedProfileSource,
  packagedProfileSidecar,
  packagedOperationDescriptorsSource,
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
  const operations = validateStandardSecurity(document);
  validateOperationProfile(document, profile);
  validateAuthorizationRegistry(document);
  const resourceAuthorizationRules = validatePackagedOperationDescriptors(
    packagedOperationDescriptorsSource,
    document,
    operations,
  );

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
    resourceAuthorizationRules,
  };
}

export function validateCleanCommit({ commit, expectedCommit, status }) {
  const actualCommit = requireSourceCommit(commit.trim(), "Repository commit");
  const sourceCommit = requireSourceCommit(expectedCommit, "Source report commit");
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
    const packagedOperationDescriptors = extractPackageFile(
      runCommand,
      tarballPath,
      "dist/index.js",
      repositoryRoot,
    );
    const profileSummary = validatePackagedOperationProfile({
      packagedProfileSource: packagedProfile,
      packagedProfileSidecar,
      packagedOperationDescriptorsSource: packagedOperationDescriptors,
      sourceProfileSource: sourceProfile,
      sourceProfileSidecar,
      openApiSource,
    });
    requireSourceBinding(
      profileSummary.profileDigest,
      expectedSourceBindings.profileSha256,
      "operation profile",
      "Candidate manifest",
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
