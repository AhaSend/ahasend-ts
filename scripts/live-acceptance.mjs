#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCandidateManifest } from "./create-candidate.mjs";
import { canonicalizeJson, digestJsonArtifact, sha256Hex } from "./digest-artifact.mjs";
import {
  parseCanonicalJson,
  parseSha256Sidecar,
  requireExactKeys,
  requireHash,
  requireObject,
  requireString,
  sourceBytes,
} from "./report-validation.mjs";
import {
  parseSourceHashMap,
  requireSourceCommit,
  SOURCE_CONTRACT_PATHS,
  SOURCE_KEY_PATHS,
} from "./run-source-gates.mjs";
import { SECRET_PATTERNS } from "./secret-patterns.mjs";

export const EXPECTED_LIVE_OPERATION_COUNT = 56;
export const EXPECTED_LIVE_ITERATOR_COUNT = 9;

const packageName = "@ahasend/sdk";
const domainOperationIds = Object.freeze([
  "getDomains",
  "createDomain",
  "getDomain",
  "updateDomain",
  "checkDomainDNS",
  "deleteDomain",
]);
const messageOperationIds = Object.freeze([
  "ping",
  "createMessage",
  "createConversationMessage",
  "getMessages",
  "getMessage",
  "cancelMessage",
]);
const sensitiveFieldNames = new Set([
  "ahasendapikey",
  "ahasendtoken",
  "ahasendwebhooksecret",
  "apikey",
  "authorization",
  "dkimprivatekey",
  "password",
  "privatekey",
  "secret",
  "secretkey",
  "signature",
  "signingkey",
  "token",
  "xapikey",
]);

function parseJson(source, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes(source, label)));
  } catch (error) {
    throw new TypeError(`${label} must be valid UTF-8 JSON.`, { cause: error });
  }
}

function parseMapping(value, label, expectedMethod) {
  const mapping = requireObject(value, label);
  requireExactKeys(mapping, ["facade", "method", "operationId"], label);
  const parsed = {
    operationId: requireString(mapping.operationId, `${label} operationId`),
    facade: requireString(mapping.facade, `${label} facade`),
    method: requireString(mapping.method, `${label} method`),
  };
  if (expectedMethod !== undefined && parsed.method !== expectedMethod) {
    throw new TypeError(`${label} method must be ${expectedMethod}.`);
  }
  return Object.freeze(parsed);
}

function parseMappings(value, expectedCount, label, expectedMethod) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new TypeError(`${label} must contain exactly ${expectedCount} entries.`);
  }
  const mappings = [];
  const operationIds = new Set();
  for (const [index, entry] of value.entries()) {
    const mapping = parseMapping(entry, `${label} entry ${index}`, expectedMethod);
    if (operationIds.has(mapping.operationId)) {
      throw new TypeError(`${label} contains duplicate operationId ${mapping.operationId}.`);
    }
    operationIds.add(mapping.operationId);
    mappings.push(mapping);
  }
  return Object.freeze(mappings);
}

export function validatePackagedLiveProfile({
  profileSource,
  profileSidecar,
  expectedProfileSha256,
}) {
  const profile = requireObject(
    parseJson(profileSource, "Packaged live operation profile"),
    "Packaged live operation profile",
  );
  requireExactKeys(
    profile,
    ["iterators", "operations", "version"],
    "Packaged live operation profile",
  );
  if (profile.version !== 1) {
    throw new TypeError("Packaged live operation profile version must be 1.");
  }

  const sidecarDigest = parseSha256Sidecar(
    profileSidecar,
    "Packaged live operation profile sidecar",
  );
  const actualDigest = digestJsonArtifact(profile);
  if (sidecarDigest !== actualDigest) {
    throw new TypeError("Packaged live operation profile does not match its detached sidecar.");
  }
  if (actualDigest !== requireHash(expectedProfileSha256, "Expected packaged profile digest")) {
    throw new TypeError("Packaged live operation profile does not match the candidate manifest.");
  }

  const operations = parseMappings(
    profile.operations,
    EXPECTED_LIVE_OPERATION_COUNT,
    "Primary operation inventory",
  );
  const iterators = parseMappings(
    profile.iterators,
    EXPECTED_LIVE_ITERATOR_COUNT,
    "Iterator inventory",
    "iterate",
  );
  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const iterator of iterators) {
    const primary = operationsById.get(iterator.operationId);
    if (primary === undefined) {
      throw new TypeError(
        `Iterator ${iterator.operationId} is orphaned from the primary operation inventory.`,
      );
    }
    if (primary.facade !== iterator.facade || primary.method !== "list") {
      throw new TypeError(
        `Iterator ${iterator.operationId} must attach to its corresponding list-operation mapping.`,
      );
    }
  }

  return Object.freeze({
    version: 1,
    operations,
    iterators,
    profileSha256: actualDigest,
  });
}

function parsePackageIdentity(source) {
  const manifest = requireObject(
    parseJson(source, "Candidate package manifest"),
    "Candidate package manifest",
  );
  if (manifest.name !== packageName) {
    throw new TypeError(`Candidate package name must be ${packageName}.`);
  }
  return Object.freeze({
    name: packageName,
    version: requireString(manifest.version, "Candidate package version"),
  });
}

function validateCandidateEnvelope({ manifestSource, manifestSidecar, tarballSource }) {
  const manifestBytes = sourceBytes(manifestSource, "Live candidate manifest");
  const manifestDigest = sha256Hex(manifestBytes);
  const manifestSidecarDigest = parseSha256Sidecar(
    manifestSidecar,
    "Live candidate manifest sidecar",
  );
  if (manifestDigest !== manifestSidecarDigest) {
    throw new TypeError("Live candidate manifest does not match its detached sidecar.");
  }

  const manifest = parseCandidateManifest(
    parseCanonicalJson(manifestBytes, "Live candidate manifest").value,
    "Live candidate manifest",
  );
  const tarballBytes = sourceBytes(tarballSource, "Live candidate tarball");
  const tarballDigest = sha256Hex(tarballBytes);
  if (tarballDigest !== manifest.tarballSha256) {
    throw new TypeError("Live candidate tarball does not match the candidate manifest.");
  }
  return { manifest, manifestDigest, tarballBytes, tarballDigest };
}

export function inspectLiveCandidate({
  manifestSource,
  manifestSidecar,
  tarballSource,
  profileSource,
  profileSidecar,
  packageManifestSource,
}) {
  const { manifest, manifestDigest, tarballDigest } = validateCandidateEnvelope({
    manifestSource,
    manifestSidecar,
    tarballSource,
  });
  const profile = validatePackagedLiveProfile({
    profileSource,
    profileSidecar,
    expectedProfileSha256: manifest.profileSha256,
  });
  const packageIdentity = parsePackageIdentity(packageManifestSource);
  const registry = createScenarioRegistry(profile);

  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestSha256: manifestDigest,
    tarballSha256: tarballDigest,
    package: packageIdentity,
    profile,
    registry,
  });
}

function defaultExtractArchiveFile(_tarballPath, archivePath, tarballSource) {
  return execFileSync("tar", ["-xzOf", "-", `package/${archivePath}`], {
    input: tarballSource,
  });
}

export async function loadLiveCandidate({
  manifestPath,
  manifestSidecarPath,
  tarballPath,
  extractArchiveFile = defaultExtractArchiveFile,
}) {
  const absoluteManifestPath = resolve(manifestPath);
  const absoluteTarballPath = resolve(tarballPath);
  const absoluteSidecarPath =
    manifestSidecarPath === undefined
      ? absoluteManifestPath.endsWith(".json")
        ? `${absoluteManifestPath.slice(0, -5)}.sha256`
        : `${absoluteManifestPath}.sha256`
      : resolve(manifestSidecarPath);
  const [manifestSource, manifestSidecar, tarballSource] = await Promise.all([
    readFile(absoluteManifestPath),
    readFile(absoluteSidecarPath),
    readFile(absoluteTarballPath),
  ]);
  validateCandidateEnvelope({ manifestSource, manifestSidecar, tarballSource });
  const [profileSource, profileSidecar, packageManifestSource] = [
    extractArchiveFile(absoluteTarballPath, "dist/_metadata/operation-profile.json", tarballSource),
    extractArchiveFile(
      absoluteTarballPath,
      "dist/_metadata/operation-profile.sha256",
      tarballSource,
    ),
    extractArchiveFile(absoluteTarballPath, "package.json", tarballSource),
  ];
  const candidate = inspectLiveCandidate({
    manifestSource,
    manifestSidecar,
    tarballSource,
    profileSource,
    profileSidecar,
    packageManifestSource,
  });
  return Object.freeze({
    ...candidate,
    tarballPath: absoluteTarballPath,
    tarballSource,
    profileSource: sourceBytes(profileSource, "Packaged live operation profile"),
    profileSidecar: sourceBytes(profileSidecar, "Packaged live operation profile sidecar"),
  });
}

function defaultRunCommand(command, args, options) {
  execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
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

export async function installLiveCandidate({
  manifestPath,
  manifestSidecarPath,
  tarballPath,
  installDirectory,
  extractArchiveFile,
  runCommand = defaultRunCommand,
}) {
  const candidate = await loadLiveCandidate({
    manifestPath,
    ...(manifestSidecarPath === undefined ? {} : { manifestSidecarPath }),
    tarballPath,
    ...(extractArchiveFile === undefined ? {} : { extractArchiveFile }),
  });
  const destination = resolve(installDirectory);
  const tarballName = basename(candidate.tarballPath);
  if (!tarballName.endsWith(".tgz")) {
    throw new TypeError("Live candidate tarball path must end with .tgz.");
  }
  await mkdir(destination, { recursive: true });
  const verifiedTarballPath = resolve(destination, tarballName);
  await Promise.all([
    writeFile(
      resolve(destination, "package.json"),
      canonicalizeJson({ name: "ahasend-live-acceptance", private: true, version: "1.0.0" }),
      { flag: "wx" },
    ),
    writeFile(verifiedTarballPath, candidate.tarballSource, { flag: "wx" }),
  ]);

  const invocation = npmInvocation([
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-save",
    verifiedTarballPath,
  ]);
  runCommand(invocation.command, invocation.args, { cwd: destination });

  const installedRoot = resolve(destination, "node_modules", "@ahasend", "sdk");
  const [installedPackageSource, installedProfileSource, installedProfileSidecar] =
    await Promise.all([
      readFile(resolve(installedRoot, "package.json")),
      readFile(resolve(installedRoot, "dist/_metadata/operation-profile.json")),
      readFile(resolve(installedRoot, "dist/_metadata/operation-profile.sha256")),
    ]);
  const installedPackage = parsePackageIdentity(installedPackageSource);
  if (
    installedPackage.version !== candidate.package.version ||
    !installedProfileSource.equals(candidate.profileSource) ||
    !installedProfileSidecar.equals(candidate.profileSidecar)
  ) {
    throw new TypeError("Installed candidate does not match the verified tarball contents.");
  }
  return Object.freeze({ ...candidate, installDirectory: destination, installedRoot });
}

function requireScenarioData(value, label) {
  const scenario = requireObject(value, label);
  const operationId = requireString(scenario.operationId, `${label} operationId`);
  if (Object.hasOwn(scenario, "facade") || Object.hasOwn(scenario, "method")) {
    throw new TypeError(`${label} cannot redefine facade mappings from the packaged profile.`);
  }
  return { operationId, scenario };
}

function readonlyMap(source) {
  let view;
  view = Object.freeze({
    get size() {
      return source.size;
    },
    get(key) {
      return source.get(key);
    },
    has(key) {
      return source.has(key);
    },
    entries() {
      return source.entries();
    },
    keys() {
      return source.keys();
    },
    values() {
      return source.values();
    },
    forEach(callback, thisArgument) {
      source.forEach((value, key) => callback.call(thisArgument, value, key, view));
    },
    [Symbol.iterator]() {
      return source[Symbol.iterator]();
    },
    [Symbol.toStringTag]: "Map",
  });
  return view;
}

export function createScenarioRegistry(
  profile,
  scenarioData = profile.operations.map(({ operationId }) => ({ operationId })),
) {
  if (!Array.isArray(scenarioData)) {
    throw new TypeError("Primary scenario data must be an array.");
  }
  const scenariosById = new Map();
  for (const [index, value] of scenarioData.entries()) {
    const { operationId, scenario } = requireScenarioData(
      value,
      `Primary scenario data entry ${index}`,
    );
    if (scenariosById.has(operationId)) {
      throw new TypeError(
        `Primary scenario registry contains duplicate operationId ${operationId}.`,
      );
    }
    scenariosById.set(operationId, scenario);
  }

  const profileOperationIds = new Set(profile.operations.map(({ operationId }) => operationId));
  const missing = profile.operations
    .filter(({ operationId }) => !scenariosById.has(operationId))
    .map(({ operationId }) => operationId);
  const orphaned = [...scenariosById.keys()].filter(
    (operationId) => !profileOperationIds.has(operationId),
  );
  if (missing.length > 0 || orphaned.length > 0) {
    throw new TypeError(
      `Primary scenario registry mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}.`,
    );
  }

  const iteratorByOperationId = new Map(
    profile.iterators.map((iterator) => [iterator.operationId, iterator]),
  );
  const primary = new Map(
    profile.operations.map((mapping) => {
      const scenario = scenariosById.get(mapping.operationId);
      return [
        mapping.operationId,
        Object.freeze({
          ...scenario,
          operationId: mapping.operationId,
          facade: mapping.facade,
          method: mapping.method,
          iterator: iteratorByOperationId.get(mapping.operationId) ?? null,
        }),
      ];
    }),
  );
  const iterators = profile.iterators.map((iterator) =>
    Object.freeze({
      ...iterator,
      primary: primary.get(iterator.operationId),
    }),
  );
  return Object.freeze({ primary: readonlyMap(primary), iterators: Object.freeze(iterators) });
}

function requireMappedClientMethod(value, mapping, label) {
  const client = requireObject(value, "Live client");
  const facade =
    mapping.facade === "client"
      ? client
      : requireObject(client[mapping.facade], `${label} ${mapping.facade} facade`);
  const method = facade[mapping.method];
  if (typeof method !== "function") {
    throw new TypeError(
      `${label} packaged mapping ${mapping.facade}.${mapping.method} must be a function.`,
    );
  }
  return method.bind(facade);
}

function requireDomainRequest(value, label, requiredKeys) {
  const request = requireObject(value, label);
  for (const key of requiredKeys) requireString(request[key], `${label} ${key}`);
  return Object.freeze({ ...request });
}

function requireLivePagination(value, scenarioLabel) {
  const label = `${scenarioLabel} live pagination`;
  const pagination = requireObject(value, label);
  const unexpected = Object.keys(pagination).filter(
    (key) => !["after", "before", "limit"].includes(key),
  );
  if (!Object.hasOwn(pagination, "limit") || unexpected.length > 0) {
    throw new TypeError(
      `${label} fields must contain limit and optional after or before; unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
  if (!Number.isInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100) {
    throw new TypeError(`${label} limit must be an integer from 1 to 100.`);
  }
  if (pagination.after !== undefined && pagination.before !== undefined) {
    throw new TypeError(`${label} must use only one cursor direction.`);
  }
  if (pagination.after !== undefined) {
    requireString(pagination.after, `${label} after`);
  }
  if (pagination.before !== undefined) {
    requireString(pagination.before, `${label} before`);
  }
  return Object.freeze({ ...pagination });
}

function requireDomainResult(value, expectedDomain, label) {
  const result = requireObject(value, label);
  if (result.domain !== expectedDomain) {
    throw new TypeError(`${label} did not return the created domain.`);
  }
  return result;
}

function isNotFoundError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error.status === 404 || error.code === "not_found_error")
  );
}

async function verifyDomainRemoved(getDomain, domain) {
  try {
    await getDomain(domain);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  throw new TypeError("Domain cleanup verification found the created domain.");
}

function assertDomainMappings(profile) {
  const expected = new Set(domainOperationIds);
  const actual = profile.operations.filter(({ facade }) => facade === "domains");
  const actualIds = new Set(actual.map(({ operationId }) => operationId));
  const missing = domainOperationIds.filter((operationId) => !actualIds.has(operationId));
  const orphaned = actual
    .map(({ operationId }) => operationId)
    .filter((operationId) => !expected.has(operationId));
  if (actual.length !== domainOperationIds.length || missing.length > 0 || orphaned.length > 0) {
    throw new TypeError(
      `Packaged domain operation mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}.`,
    );
  }
  const list = actual.find(({ operationId }) => operationId === "getDomains");
  const iterator = profile.iterators.filter(({ facade }) => facade === "domains");
  if (
    list?.method !== "list" ||
    iterator.length !== 1 ||
    iterator[0]?.operationId !== "getDomains" ||
    iterator[0]?.method !== "iterate"
  ) {
    throw new TypeError(
      "Packaged domain iterator must link getDomains iterate to its primary list operation.",
    );
  }
  return Object.freeze({
    operations: new Map(actual.map((mapping) => [mapping.operationId, mapping])),
    iterator: iterator[0],
  });
}

/**
 * Build the six domain lifecycle scenarios while retaining pending entries for
 * every other packaged operation. The packaged profile remains the sole source
 * of facade and method mappings.
 */
export function createDomainScenarioRegistry({
  profile,
  client,
  createRequest,
  updateRequest = { tracking_subdomain: "live" },
  pagination = { limit: 1 },
}) {
  const mappings = assertDomainMappings(profile);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Domain ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getDomains"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "Domain iterator scenario"),
    create: mappedOperation("createDomain"),
    get: mappedOperation("getDomain"),
    update: mappedOperation("updateDomain"),
    checkDns: mappedOperation("checkDomainDNS"),
    delete: mappedOperation("deleteDomain"),
  });
  const createBody = requireDomainRequest(createRequest, "Domain live create request", ["domain"]);
  const updateBody = requireDomainRequest(updateRequest, "Domain live update request", []);
  const pageParams = requireLivePagination(pagination, "Domain");
  const domain = createBody.domain;

  const scenarios = new Map([
    [
      "getDomains",
      {
        operationId: "getDomains",
        async run() {
          const page = requireObject(
            await methods.list(pageParams),
            "Domain list scenario response",
          );
          if (!Array.isArray(page.data)) {
            throw new TypeError("Domain list scenario response data must be an array.");
          }
          requireObject(page.pagination, "Domain list scenario pagination");

          let itemCount = 0;
          for await (const _entry of methods.iterate(pageParams)) {
            itemCount += 1;
            if (itemCount >= pageParams.limit) break;
          }
          return Object.freeze({
            evidence: Object.freeze({
              direction: pageParams.before === undefined ? "forward" : "backward",
              limit: pageParams.limit,
              pageItems: page.data.length,
            }),
            iteratorEvidence: Object.freeze({
              direction: pageParams.before === undefined ? "forward" : "backward",
              items: itemCount,
              limit: pageParams.limit,
            }),
          });
        },
      },
    ],
    [
      "createDomain",
      {
        operationId: "createDomain",
        async run({ cleanup }) {
          const result = await methods.create(createBody);
          cleanup.register("delete and verify domain fixture", async () => {
            try {
              await methods.delete(domain);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await verifyDomainRemoved(methods.get, domain);
          });
          requireDomainResult(result, domain, "Domain create scenario response");
          return Object.freeze({ evidence: Object.freeze({ created: true }) });
        },
      },
    ],
    [
      "getDomain",
      {
        operationId: "getDomain",
        async run() {
          requireDomainResult(await methods.get(domain), domain, "Domain get scenario response");
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "updateDomain",
      {
        operationId: "updateDomain",
        async run() {
          requireDomainResult(
            await methods.update(domain, updateBody),
            domain,
            "Domain update scenario response",
          );
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "checkDomainDNS",
      {
        operationId: "checkDomainDNS",
        async run() {
          requireDomainResult(
            await methods.checkDns(domain),
            domain,
            "Domain DNS-check scenario response",
          );
          return Object.freeze({ evidence: Object.freeze({ checked: true }) });
        },
      },
    ],
    [
      "deleteDomain",
      {
        operationId: "deleteDomain",
        async run() {
          await methods.delete(domain);
          return Object.freeze({ evidence: Object.freeze({ deleted: true }) });
        },
      },
    ],
  ]);

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/**
 * Execute the domain lifecycle in dependency order and always drain registered
 * cleanup. Results can be passed directly to createLiveReport.
 */
async function runLiveScenarios(registry, operationIds, iteratorOperationId, scenarioLabel) {
  const scenarios = new Map();
  for (const operationId of operationIds) {
    const scenario = registry.primary.get(operationId);
    if (scenario === undefined || typeof scenario.run !== "function") {
      throw new TypeError(
        `${scenarioLabel} scenario registry is missing executable ${operationId}.`,
      );
    }
    scenarios.set(operationId, scenario);
  }

  const cleanup = createCleanupRegistry();
  const operationResults = [];
  const iteratorResults = [];
  let failure = null;
  for (const operationId of operationIds) {
    const scenario = scenarios.get(operationId);
    try {
      const result = await scenario.run({ cleanup });
      operationResults.push({
        operationId,
        status: "passed",
        ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      });
      if (operationId === iteratorOperationId) {
        iteratorResults.push({
          operationId,
          status: "passed",
          evidence: result.iteratorEvidence,
        });
      }
    } catch {
      operationResults.push({ operationId, status: "failed" });
      if (operationId === iteratorOperationId) {
        iteratorResults.push({ operationId, status: "failed" });
      }
      failure = Object.freeze({ phase: "operation", operationId });
      break;
    }
  }

  try {
    await cleanup.run();
  } catch {
    if (failure === null) failure = Object.freeze({ phase: "cleanup" });
  }
  return Object.freeze({
    operationResults: Object.freeze(operationResults),
    iteratorResults: Object.freeze(iteratorResults),
    cleanupResults: cleanup.results,
    failure,
  });
}

export function runDomainLiveScenarios(registry) {
  return runLiveScenarios(registry, domainOperationIds, "getDomains", "Domain");
}

function requireSandboxMessageRequest(value, label) {
  const request = requireObject(value, label);
  const from = requireObject(request.from, `${label} from`);
  const email = requireString(from.email, `${label} from.email`);
  if (request.sandbox !== true) {
    throw new TypeError(`${label} sandbox must be true.`);
  }
  return Object.freeze({ request: Object.freeze({ ...request }), email });
}

function requireScheduledSandboxMessageRequest(value, label) {
  const parsed = requireSandboxMessageRequest(value, label);
  const schedule = requireObject(parsed.request.schedule, `${label} schedule`);
  const firstAttempt = requireString(schedule.first_attempt, `${label} schedule.first_attempt`);
  const firstAttemptTime = Date.parse(firstAttempt);
  if (!Number.isFinite(firstAttemptTime) || firstAttemptTime <= Date.now()) {
    throw new TypeError(`${label} schedule.first_attempt must be a future RFC 3339 timestamp.`);
  }
  return parsed;
}

function emailDomain(email, label) {
  const separator = email.lastIndexOf("@");
  if (separator < 1 || separator === email.length - 1) {
    throw new TypeError(`${label} must contain a domain.`);
  }
  return email.slice(separator + 1).toLowerCase();
}

function assertMessageMappings(profile) {
  const expected = new Set(messageOperationIds);
  const actual = profile.operations.filter(
    ({ facade, operationId }) => facade === "messages" || operationId === "ping",
  );
  const actualIds = new Set(actual.map(({ operationId }) => operationId));
  const missing = messageOperationIds.filter((operationId) => !actualIds.has(operationId));
  const orphaned = actual
    .map(({ operationId }) => operationId)
    .filter((operationId) => !expected.has(operationId));
  if (actual.length !== messageOperationIds.length || missing.length > 0 || orphaned.length > 0) {
    throw new TypeError(
      `Packaged message operation mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}.`,
    );
  }

  const ping = actual.find(({ operationId }) => operationId === "ping");
  const list = actual.find(({ operationId }) => operationId === "getMessages");
  const iterator = profile.iterators.filter(({ facade }) => facade === "messages");
  if (
    ping?.facade !== "client" ||
    list?.method !== "list" ||
    iterator.length !== 1 ||
    iterator[0]?.operationId !== "getMessages" ||
    iterator[0]?.method !== "iterate"
  ) {
    throw new TypeError(
      "Packaged message mappings must link client ping and getMessages iterate to its primary list operation.",
    );
  }
  return Object.freeze({
    operations: new Map(actual.map((mapping) => [mapping.operationId, mapping])),
    iterator: iterator[0],
  });
}

function requireSuccessfulSandboxSend(value, label, expectedStatus) {
  const response = requireObject(value, label);
  if (!Array.isArray(response.data) || response.data.length === 0) {
    throw new TypeError(`${label} data must contain at least one result.`);
  }
  const results = response.data.map((value, index) => {
    const resultLabel = `${label} result ${index + 1}`;
    const result = requireObject(value, resultLabel);
    if (!["queued", "scheduled"].includes(result.status)) {
      throw new TypeError(`${resultLabel} must have queued or scheduled status.`);
    }
    if (expectedStatus !== undefined && result.status !== expectedStatus) {
      throw new TypeError(`${resultLabel} must have ${expectedStatus} status.`);
    }
    return Object.freeze({
      id: requireString(result.id, `${resultLabel} id`),
      status: result.status,
    });
  });
  const firstResult = results[0];
  if (firstResult === undefined) {
    throw new TypeError(`${label} data must contain at least one result.`);
  }
  return Object.freeze({
    id: firstResult.id,
    results: results.length,
  });
}

async function requireExpectedSandboxRejection(action, label) {
  try {
    await action();
  } catch (error) {
    const failure = requireObject(error, `${label} rejection`);
    if (failure.status !== 400) {
      throw new TypeError(`${label} must fail with HTTP 400.`);
    }
    return Object.freeze({ rejected: true, status: 400 });
  }
  throw new TypeError(`${label} unexpectedly succeeded.`);
}

/**
 * Build ping and message scenarios while retaining pending entries for every
 * other packaged operation. Negative sends reuse the verified request body so
 * from.email is the only authorization- and domain-state-changing input.
 */
export function createMessageScenarioRegistry({
  profile,
  client,
  verifiedRequest,
  conversationRequest,
  neverRegisteredDomain,
  dnslessCreateRequest,
  pagination = { limit: 1 },
}) {
  const mappings = assertMessageMappings(profile);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Message ${operationId} scenario`,
    );
  const methods = Object.freeze({
    ping: mappedOperation("ping"),
    list: mappedOperation("getMessages"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "Message iterator scenario"),
    send: mappedOperation("createMessage"),
    sendConversation: mappedOperation("createConversationMessage"),
    get: mappedOperation("getMessage"),
    cancel: mappedOperation("cancelMessage"),
    createDomain: requireMappedClientMethod(
      client,
      { facade: "domains", method: "create" },
      "Message DNS-less domain setup",
    ),
    getDomain: requireMappedClientMethod(
      client,
      { facade: "domains", method: "get" },
      "Message DNS-less domain verification",
    ),
    deleteDomain: requireMappedClientMethod(
      client,
      { facade: "domains", method: "delete" },
      "Message DNS-less domain cleanup",
    ),
  });
  const verified = requireScheduledSandboxMessageRequest(
    verifiedRequest,
    "Verified-domain sandbox request",
  );
  const conversation = requireSandboxMessageRequest(
    conversationRequest,
    "Conversation sandbox request",
  );
  const verifiedDomain = emailDomain(verified.email, "Verified-domain sandbox request from.email");
  if (
    emailDomain(conversation.email, "Conversation sandbox request from.email") !== verifiedDomain
  ) {
    throw new TypeError("Conversation sandbox request must use the verified sender domain.");
  }
  const absentDomain = requireString(
    neverRegisteredDomain,
    "Never-registered domain",
  ).toLowerCase();
  const dnslessBody = requireDomainRequest(dnslessCreateRequest, "DNS-less domain create request", [
    "domain",
  ]);
  const dnslessDomain = dnslessBody.domain.toLowerCase();
  if (
    new Set([verifiedDomain, absentDomain, dnslessDomain]).size !== 3 ||
    absentDomain.includes("@") ||
    dnslessDomain.includes("@")
  ) {
    throw new TypeError(
      "Verified, never-registered, and DNS-less sandbox domains must be distinct domain names.",
    );
  }
  const negativeRequest = (domain) =>
    Object.freeze({
      ...verified.request,
      from: Object.freeze({ ...verified.request.from, email: `live-acceptance@${domain}` }),
    });
  const pageParams = requireLivePagination(pagination, "Message");
  const state = { messageId: null };

  const scenarios = new Map([
    [
      "ping",
      {
        operationId: "ping",
        async run() {
          const response = requireObject(await methods.ping(), "Ping scenario response");
          requireString(response.message, "Ping scenario response message");
          return Object.freeze({ evidence: Object.freeze({ authenticated: true }) });
        },
      },
    ],
    [
      "createMessage",
      {
        operationId: "createMessage",
        async run({ cleanup }) {
          const successful = requireSuccessfulSandboxSend(
            await methods.send(verified.request),
            "Verified-domain sandbox response",
            "scheduled",
          );
          state.messageId = successful.id;
          const absent = await requireExpectedSandboxRejection(
            () => methods.send(negativeRequest(absentDomain)),
            "Never-registered-domain sandbox send",
          );

          const createdDomain = await methods.createDomain(dnslessBody);
          cleanup.register("delete and verify DNS-less message domain fixture", async () => {
            try {
              await methods.deleteDomain(dnslessDomain);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await verifyDomainRemoved(methods.getDomain, dnslessDomain);
          });
          requireDomainResult(createdDomain, dnslessBody.domain, "DNS-less domain setup response");
          const dnsless = await requireExpectedSandboxRejection(
            () => methods.send(negativeRequest(dnslessDomain)),
            "DNS-less-domain sandbox send",
          );
          return Object.freeze({
            evidence: Object.freeze({
              senderAuthorization: Object.freeze({ source: "body.from.email" }),
              sandbox: Object.freeze({
                verified: Object.freeze({ accepted: true, results: successful.results }),
                neverRegistered: Object.freeze({ ...absent, reason: "domain_not_registered" }),
                dnsless: Object.freeze({ ...dnsless, reason: "dns_not_verified" }),
              }),
            }),
          });
        },
      },
    ],
    [
      "createConversationMessage",
      {
        operationId: "createConversationMessage",
        async run() {
          const successful = requireSuccessfulSandboxSend(
            await methods.sendConversation(conversation.request),
            "Conversation sandbox response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              accepted: true,
              senderAuthorization: Object.freeze({ source: "body.from.email" }),
              results: successful.results,
              sandbox: true,
            }),
          });
        },
      },
    ],
    [
      "getMessages",
      {
        operationId: "getMessages",
        async run() {
          const page = requireObject(await methods.list(pageParams), "Message list response");
          if (!Array.isArray(page.data)) {
            throw new TypeError("Message list response data must be an array.");
          }
          requireObject(page.pagination, "Message list response pagination");

          let itemCount = 0;
          for await (const _entry of methods.iterate(pageParams)) {
            itemCount += 1;
            if (itemCount >= pageParams.limit) break;
          }
          return Object.freeze({
            evidence: Object.freeze({
              direction: pageParams.before === undefined ? "forward" : "backward",
              limit: pageParams.limit,
              pageItems: page.data.length,
            }),
            iteratorEvidence: Object.freeze({
              direction: pageParams.before === undefined ? "forward" : "backward",
              items: itemCount,
              limit: pageParams.limit,
            }),
          });
        },
      },
    ],
    [
      "getMessage",
      {
        operationId: "getMessage",
        async run() {
          if (state.messageId === null) {
            throw new TypeError("Message get scenario requires the verified sandbox message.");
          }
          requireObject(await methods.get(state.messageId), "Message get response");
          return Object.freeze({ evidence: Object.freeze({ retrieved: true }) });
        },
      },
    ],
    [
      "cancelMessage",
      {
        operationId: "cancelMessage",
        async run() {
          if (state.messageId === null) {
            throw new TypeError("Message cancel scenario requires the verified sandbox message.");
          }
          requireObject(await methods.cancel(state.messageId), "Message cancel response");
          return Object.freeze({ evidence: Object.freeze({ cancelled: true }) });
        },
      },
    ],
  ]);

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/** Execute ping and message scenarios in dependency order and always drain setup cleanup. */
export function runMessageLiveScenarios(registry) {
  return runLiveScenarios(registry, messageOperationIds, "getMessages", "Message");
}

export function createCleanupRegistry() {
  const pending = [];
  const results = [];
  return Object.freeze({
    register(label, action) {
      requireString(label, "Cleanup label");
      if (typeof action !== "function") {
        throw new TypeError("Cleanup action must be a function.");
      }
      pending.push(Object.freeze({ label, action }));
    },
    get size() {
      return pending.length;
    },
    get results() {
      return Object.freeze([...results]);
    },
    async run() {
      const failures = [];
      while (pending.length > 0) {
        const entry = pending.pop();
        try {
          await entry.action();
          results.push(Object.freeze({ label: entry.label, status: "passed" }));
        } catch (error) {
          results.push(Object.freeze({ label: entry.label, status: "failed" }));
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} cleanup action(s) failed.`);
      }
      return Object.freeze([...results]);
    },
  });
}

export async function runWithCleanup(callback) {
  if (typeof callback !== "function") throw new TypeError("Live callback must be a function.");
  const cleanup = createCleanupRegistry();
  let value;
  let operationError;
  let operationFailed = false;
  try {
    value = await callback(cleanup);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError;
  let cleanupFailed = false;
  try {
    await cleanup.run();
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Live acceptance and cleanup both failed.",
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupFailed) throw cleanupError;
  return value;
}

function redactedString(value, secrets) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) return "[REDACTED]";
  let redacted = value.replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
  for (const secret of secrets) {
    if (secret !== "") redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function redactLiveValue(value, secrets = []) {
  const normalizedSecrets = secrets
    .map((secret, index) => requireString(secret, `Redaction secret ${index}`))
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length);
  function visit(current, ancestors) {
    if (typeof current === "string") return redactedString(current, normalizedSecrets);
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Live report numbers must be finite.");
      return current;
    }
    if (typeof current !== "object") {
      throw new TypeError(`Live report cannot contain ${typeof current} values.`);
    }
    if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) {
      return "[REDACTED]";
    }
    if (ancestors.has(current)) throw new TypeError("Live report cannot contain cyclic values.");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((entry) => visit(entry, ancestors));
      }
      const output = {};
      for (const [key, entry] of Object.entries(current)) {
        const normalizedKey = key.replace(/[-_]/gu, "").toLowerCase();
        const redactedKey = redactedString(key, normalizedSecrets);
        output[redactedKey] = sensitiveFieldNames.has(normalizedKey)
          ? "[REDACTED]"
          : visit(entry, ancestors);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, new WeakSet());
}

function resultInventory(mappings, suppliedResults, label) {
  if (!Array.isArray(suppliedResults)) throw new TypeError(`${label} results must be an array.`);
  const suppliedById = new Map();
  for (const [index, value] of suppliedResults.entries()) {
    const result = requireObject(value, `${label} result ${index}`);
    const operationId = requireString(result.operationId, `${label} result ${index} operationId`);
    if (suppliedById.has(operationId)) {
      throw new TypeError(`${label} results contain duplicate operationId ${operationId}.`);
    }
    if (Object.hasOwn(result, "facade") || Object.hasOwn(result, "method")) {
      throw new TypeError(`${label} results cannot redefine packaged facade mappings.`);
    }
    suppliedById.set(operationId, result);
  }
  const mappingIds = new Set(mappings.map(({ operationId }) => operationId));
  const orphaned = [...suppliedById.keys()].filter((operationId) => !mappingIds.has(operationId));
  if (orphaned.length > 0) {
    throw new TypeError(
      `${label} results contain orphaned operationIds ${JSON.stringify(orphaned)}.`,
    );
  }
  return mappings.map((mapping) => ({
    operationId: mapping.operationId,
    facade: mapping.facade,
    method: mapping.method,
    status: "pending",
    ...(suppliedById.get(mapping.operationId) ?? {}),
  }));
}

export function createLiveReport({
  candidate,
  operationResults = [],
  iteratorResults = [],
  cleanupResults = [],
  secrets = [],
}) {
  const report = {
    version: 1,
    candidate: {
      commit: candidate.manifest.commit,
      manifestSha256: candidate.manifestSha256,
    },
    contractSha256: candidate.manifest.contractSha256,
    profileSha256: candidate.profile.profileSha256,
    captureSha256: candidate.manifest.captureSha256,
    keysSha256: candidate.manifest.keysSha256,
    package: candidate.package,
    tarballSha256: candidate.tarballSha256,
    operations: resultInventory(
      candidate.profile.operations,
      operationResults,
      "Primary operation",
    ),
    iterators: resultInventory(candidate.profile.iterators, iteratorResults, "Iterator"),
    cleanup: cleanupResults,
  };
  return redactLiveValue(report, secrets);
}

function validateResultInventory(value, mappings, expectedCount, label, expectedMethod) {
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new TypeError(`${label} must contain exactly ${expectedCount} results.`);
  }
  if (!Array.isArray(mappings) || mappings.length !== expectedCount) {
    throw new TypeError(`Expected ${label.toLowerCase()} must contain ${expectedCount} mappings.`);
  }
  const mappingsById = new Map(mappings.map((mapping) => [mapping.operationId, mapping]));
  const operationIds = new Set();
  for (const [index, entry] of value.entries()) {
    const result = requireObject(entry, `${label} result ${index}`);
    const operationId = requireString(result.operationId, `${label} result ${index} operationId`);
    const facade = requireString(result.facade, `${label} result ${index} facade`);
    const method = requireString(result.method, `${label} result ${index} method`);
    if (expectedMethod !== undefined && method !== expectedMethod) {
      throw new TypeError(`${label} result ${operationId} method must be ${expectedMethod}.`);
    }
    if (!["failed", "passed", "pending", "skipped"].includes(result.status)) {
      throw new TypeError(`${label} result ${operationId} has an invalid status.`);
    }
    if (operationIds.has(operationId)) {
      throw new TypeError(`${label} contains duplicate operationId ${operationId}.`);
    }
    const mapping = mappingsById.get(operationId);
    if (mapping === undefined) {
      throw new TypeError(`${label} result ${operationId} is not present in the packaged profile.`);
    }
    if (facade !== mapping.facade || method !== mapping.method) {
      throw new TypeError(
        `${label} result ${operationId} does not match its packaged facade and method mapping.`,
      );
    }
    operationIds.add(operationId);
  }
}

function validateReportIteratorLinks(operations, iterators) {
  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
  for (const iterator of iterators) {
    const primary = operationsById.get(iterator.operationId);
    if (primary === undefined || primary.facade !== iterator.facade || primary.method !== "list") {
      throw new TypeError(
        `Iterator inventory result ${iterator.operationId} must attach to its corresponding primary list-operation result.`,
      );
    }
  }
}

function requireSameReportValue(actual, expected, label) {
  let actualSource;
  let expectedSource;
  try {
    actualSource = canonicalizeJson(actual);
    expectedSource = canonicalizeJson(expected);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-compatible.`, { cause: error });
  }
  if (!actualSource.equals(expectedSource)) {
    throw new TypeError(`${label} does not match the verified live candidate.`);
  }
}

export function validateLiveReportArtifacts({ reportSource, reportSidecar, candidate: expected }) {
  const source = sourceBytes(reportSource, "Live acceptance report");
  const expectedDigest = parseSha256Sidecar(reportSidecar, "Live acceptance report sidecar");
  const actualDigest = sha256Hex(source);
  if (expectedDigest !== actualDigest) {
    throw new TypeError("Live acceptance report does not match its detached sidecar.");
  }
  const report = parseCanonicalJson(source, "Live acceptance report").value;
  requireExactKeys(
    report,
    [
      "candidate",
      "captureSha256",
      "cleanup",
      "contractSha256",
      "iterators",
      "keysSha256",
      "operations",
      "package",
      "profileSha256",
      "tarballSha256",
      "version",
    ],
    "Live acceptance report",
  );
  if (report.version !== 1) throw new TypeError("Live acceptance report version must be 1.");
  const candidate = requireObject(report.candidate, "Live acceptance report candidate");
  requireExactKeys(candidate, ["commit", "manifestSha256"], "Live acceptance report candidate");
  const candidateCommit = requireSourceCommit(
    candidate.commit,
    "Live acceptance report candidate commit",
  );
  const candidateManifestSha256 = requireHash(
    candidate.manifestSha256,
    "Live acceptance report candidate manifestSha256",
  );
  const contractSha256 = parseSourceHashMap(
    report.contractSha256,
    SOURCE_CONTRACT_PATHS,
    "Live acceptance report contractSha256",
  );
  const profileSha256 = requireHash(report.profileSha256, "Live acceptance report profileSha256");
  const captureSha256 = requireHash(report.captureSha256, "Live acceptance report captureSha256");
  const keysSha256 = parseSourceHashMap(
    report.keysSha256,
    SOURCE_KEY_PATHS,
    "Live acceptance report keysSha256",
  );
  const reportPackage = requireObject(report.package, "Live acceptance report package");
  requireExactKeys(reportPackage, ["name", "version"], "Live acceptance report package");
  const identity = parsePackageIdentity(canonicalizeJson(reportPackage));
  const tarballSha256 = requireHash(report.tarballSha256, "Live acceptance report tarballSha256");
  const expectedCandidate = requireObject(expected, "Verified live candidate");
  const expectedManifest = requireObject(
    expectedCandidate.manifest,
    "Verified live candidate manifest",
  );
  const expectedProfile = requireObject(
    expectedCandidate.profile,
    "Verified live candidate profile",
  );
  const verifiedManifestSha256 = requireHash(
    expectedCandidate.manifestSha256,
    "Verified live candidate manifestSha256",
  );
  if (sha256Hex(canonicalizeJson(expectedManifest)) !== verifiedManifestSha256) {
    throw new TypeError(
      "Verified live candidate manifest does not match its authenticated manifestSha256.",
    );
  }
  const manifestProfileSha256 = requireHash(
    expectedManifest.profileSha256,
    "Verified live candidate manifest profileSha256",
  );
  const candidateProfileSha256 = requireHash(
    expectedProfile.profileSha256,
    "Verified live candidate profileSha256",
  );
  if (candidateProfileSha256 !== manifestProfileSha256) {
    throw new TypeError(
      "Verified live candidate profileSha256 does not match the authenticated candidate manifest.",
    );
  }
  const candidateProfileDigest = digestJsonArtifact({
    version: expectedProfile.version,
    operations: expectedProfile.operations,
    iterators: expectedProfile.iterators,
  });
  if (candidateProfileDigest !== manifestProfileSha256) {
    throw new TypeError(
      "Verified live candidate profile does not match the authenticated candidate manifest.",
    );
  }
  const manifestTarballSha256 = requireHash(
    expectedManifest.tarballSha256,
    "Verified live candidate manifest tarballSha256",
  );
  const candidateTarballSha256 = requireHash(
    expectedCandidate.tarballSha256,
    "Verified live candidate tarballSha256",
  );
  if (candidateTarballSha256 !== manifestTarballSha256) {
    throw new TypeError(
      "Verified live candidate tarballSha256 does not match the authenticated candidate manifest.",
    );
  }
  requireSameReportValue(candidateCommit, expectedManifest.commit, "Live report candidate commit");
  requireSameReportValue(
    candidateManifestSha256,
    verifiedManifestSha256,
    "Live report candidate manifestSha256",
  );
  requireSameReportValue(
    contractSha256,
    expectedManifest.contractSha256,
    "Live report contractSha256",
  );
  requireSameReportValue(profileSha256, manifestProfileSha256, "Live report profileSha256");
  requireSameReportValue(
    captureSha256,
    expectedManifest.captureSha256,
    "Live report captureSha256",
  );
  requireSameReportValue(keysSha256, expectedManifest.keysSha256, "Live report keysSha256");
  requireSameReportValue(identity, expectedCandidate.package, "Live report package");
  requireSameReportValue(tarballSha256, manifestTarballSha256, "Live report tarballSha256");
  validateResultInventory(
    report.operations,
    expectedProfile.operations,
    EXPECTED_LIVE_OPERATION_COUNT,
    "Primary operation inventory",
  );
  validateResultInventory(
    report.iterators,
    expectedProfile.iterators,
    EXPECTED_LIVE_ITERATOR_COUNT,
    "Iterator inventory",
    "iterate",
  );
  validateReportIteratorLinks(report.operations, report.iterators);
  if (!Array.isArray(report.cleanup)) {
    throw new TypeError("Live acceptance report cleanup must be an array.");
  }
  for (const [index, entry] of report.cleanup.entries()) {
    const result = requireObject(entry, `Live acceptance report cleanup result ${index}`);
    requireExactKeys(result, ["label", "status"], `Live acceptance report cleanup result ${index}`);
    requireString(result.label, `Live acceptance report cleanup result ${index} label`);
    if (!["failed", "passed"].includes(result.status)) {
      throw new TypeError(`Live acceptance report cleanup result ${index} has an invalid status.`);
    }
  }
  return Object.freeze({
    report,
    reportSha256: actualDigest,
    package: identity,
    operations: report.operations.length,
    iterators: report.iterators.length,
  });
}

export async function writeLiveReport({
  report,
  candidate,
  reportPath,
  reportSidecarPath,
  secrets = [],
}) {
  const destination = resolve(reportPath);
  const sidecarDestination =
    reportSidecarPath === undefined
      ? destination.endsWith(".json")
        ? `${destination.slice(0, -5)}.sha256`
        : `${destination}.sha256`
      : resolve(reportSidecarPath);
  const source = canonicalizeJson(redactLiveValue(report, secrets));
  const reportSha256 = sha256Hex(source);
  const sidecar = Buffer.from(`${reportSha256}\n`, "utf8");
  validateLiveReportArtifacts({ reportSource: source, reportSidecar: sidecar, candidate });
  await mkdir(dirname(destination), { recursive: true });
  await Promise.all([
    writeFile(destination, source, { flag: "wx" }),
    writeFile(sidecarDestination, sidecar, { flag: "wx" }),
  ]);
  return Object.freeze({
    reportPath: destination,
    reportSidecarPath: sidecarDestination,
    reportSha256,
  });
}

async function main() {
  const [manifestPath, tarballPath, installDirectory, manifestSidecarPath, ...extra] =
    process.argv.slice(2);
  if (
    manifestPath === undefined ||
    tarballPath === undefined ||
    installDirectory === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(
      "Usage: node scripts/live-acceptance.mjs <candidate-manifest.json> <candidate.tgz> <install-directory> [candidate-manifest.sha256]",
    );
  }
  const candidate = await installLiveCandidate({
    manifestPath,
    tarballPath,
    installDirectory,
    ...(manifestSidecarPath === undefined ? {} : { manifestSidecarPath }),
  });
  process.stdout.write(
    `Verified and installed ${candidate.package.name}@${candidate.package.version}: ${candidate.profile.operations.length} primary operations and ${candidate.profile.iterators.length} iterator subcases.\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`live-acceptance: ${message}\n`);
    process.exitCode = 1;
  });
}
