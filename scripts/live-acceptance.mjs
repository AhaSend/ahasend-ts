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
const statisticsOperationIds = Object.freeze([
  "getDeliverabilityStatistics",
  "getBounceStatistics",
  "getDeliveryTimeStatistics",
]);
const apiKeyOperationIds = Object.freeze([
  "getAPIKeys",
  "createAPIKey",
  "getAPIKey",
  "updateAPIKey",
  "deleteAPIKey",
]);
const routeOperationIds = Object.freeze([
  "getRoutes",
  "createRoute",
  "getRoute",
  "updateRoute",
  "deleteRoute",
]);
const webhookOperationIds = Object.freeze([
  "getWebhooks",
  "createWebhook",
  "getWebhook",
  "updateWebhook",
  "deleteWebhook",
]);
const smtpCredentialOperationIds = Object.freeze([
  "getSMTPCredentials",
  "createSMTPCredential",
  "getSMTPCredential",
  "deleteSMTPCredential",
]);
const accountOperationIds = Object.freeze([
  "getAccount",
  "updateAccount",
  "getAccountMembers",
  "addAccountMember",
  "removeAccountMember",
]);
const suppressionOperationIds = Object.freeze([
  "getSuppressions",
  "createSuppression",
  "deleteSuppression",
  "deleteAllSuppressions",
]);
const subAccountOperationIds = Object.freeze([
  "listSubAccounts",
  "createSubAccount",
  "getSubAccountsUsage",
  "getSubAccount",
  "updateSubAccount",
  "suspendSubAccount",
  "unsuspendSubAccount",
  "deleteSubAccount",
]);
const subAccountAPIKeyOperationIds = Object.freeze([
  "listSubAccountAPIKeys",
  "createSubAccountAPIKey",
  "getSubAccountAPIKey",
  "updateSubAccountAPIKey",
  "deleteSubAccountAPIKey",
]);
const disposableSubAccountIds = new WeakMap();
const mutableAccountFields = Object.freeze([
  "name",
  "website",
  "about",
  "track_opens",
  "track_clicks",
  "reject_bad_recipients",
  "reject_mistyped_recipients",
  "message_metadata_retention",
  "message_data_retention",
]);
const restrictedApiKeyAddress = "192.0.2.7";
const canonicalRestrictedApiKeyAddress = `${restrictedApiKeyAddress}/32`;
const selfLockoutAddress = "192.0.2.1/32";
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
  let facade = client;
  if (mapping.facade !== "client") {
    for (const segment of mapping.facade.split(".")) {
      facade = requireObject(facade[segment], `${label} ${mapping.facade} facade`);
    }
  }
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

async function runListIteratorScenario(list, iterate, pageParams, label, validateEntry = () => {}) {
  const page = requireObject(await list(pageParams), `${label} list response`);
  if (!Array.isArray(page.data)) {
    throw new TypeError(`${label} list response data must be an array.`);
  }
  requireObject(page.pagination, `${label} list response pagination`);
  page.data.forEach((entry, index) => validateEntry(entry, `${label} list response item ${index}`));

  let itemCount = 0;
  for await (const entry of iterate(pageParams)) {
    validateEntry(entry, `${label} iterator item ${itemCount}`);
    itemCount += 1;
    if (itemCount >= pageParams.limit) break;
  }
  const direction = pageParams.before === undefined ? "forward" : "backward";
  return Object.freeze({
    evidence: Object.freeze({
      direction,
      limit: pageParams.limit,
      pageItems: page.data.length,
    }),
    iteratorEvidence: Object.freeze({
      direction,
      items: itemCount,
      limit: pageParams.limit,
    }),
  });
}

function requireDomainResult(value, expectedDomain, label) {
  const result = requireObject(value, label);
  if (result.domain !== expectedDomain) {
    throw new TypeError(`${label} did not return the created domain.`);
  }
  return result;
}

function requireDnsInvalidDomainResult(value, expectedDomain, label) {
  const result = requireDomainResult(value, expectedDomain, label);
  if (result.dns_valid !== false) {
    throw new TypeError(`${label} must report dns_valid as false.`);
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

async function requireResourceAbsent(getResource, resourceId, label, resourceName) {
  try {
    await getResource(resourceId);
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
  throw new TypeError(`${label} found the ${resourceName}.`);
}

function requireLifecycleMappings(profile, operationIds, facade, listOperationId, resourceLabel) {
  const expected = new Set(operationIds);
  const actual = profile.operations.filter((mapping) => mapping.facade === facade);
  const actualIds = new Set(actual.map(({ operationId }) => operationId));
  const missing = operationIds.filter((operationId) => !actualIds.has(operationId));
  const orphaned = actual
    .map(({ operationId }) => operationId)
    .filter((operationId) => !expected.has(operationId));
  if (actual.length !== operationIds.length || missing.length > 0 || orphaned.length > 0) {
    throw new TypeError(
      `Packaged ${resourceLabel} operation mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}.`,
    );
  }
  const list = actual.find(({ operationId }) => operationId === listOperationId);
  const iterator = profile.iterators.filter((mapping) => mapping.facade === facade);
  if (
    list?.method !== "list" ||
    iterator.length !== 1 ||
    iterator[0]?.operationId !== listOperationId ||
    iterator[0]?.method !== "iterate"
  ) {
    throw new TypeError(
      `Packaged ${resourceLabel} iterator must link ${listOperationId} iterate to its primary list operation.`,
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
  const mappings = requireLifecycleMappings(
    profile,
    domainOperationIds,
    "domains",
    "getDomains",
    "domain",
  );
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
          return runListIteratorScenario(methods.list, methods.iterate, pageParams, "Domain");
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
            await requireResourceAbsent(
              methods.get,
              domain,
              "Domain cleanup verification",
              "domain",
            );
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

function requireExecutableLiveScenarios(registry, operationIds, scenarioLabel) {
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
  return scenarios;
}

async function executeLiveScenarios(
  registry,
  operationIds,
  iteratorOperationId,
  scenarioLabel,
  cleanup,
) {
  const scenarios = requireExecutableLiveScenarios(registry, operationIds, scenarioLabel);
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
  return Object.freeze({
    operationResults: Object.freeze(operationResults),
    iteratorResults: Object.freeze(iteratorResults),
    failure,
  });
}

async function drainLiveCleanup(cleanup, failure) {
  let resolvedFailure = failure;
  try {
    await cleanup.run();
  } catch {
    if (resolvedFailure === null) resolvedFailure = Object.freeze({ phase: "cleanup" });
  }
  return resolvedFailure;
}

function createLiveRun(execution, cleanupResults, failure = execution.failure) {
  return Object.freeze({
    operationResults: execution.operationResults,
    iteratorResults: execution.iteratorResults,
    cleanupResults,
    failure,
  });
}

function mergeLiveExecutions(...executions) {
  return Object.freeze({
    operationResults: Object.freeze(executions.flatMap((execution) => execution.operationResults)),
    iteratorResults: Object.freeze(executions.flatMap((execution) => execution.iteratorResults)),
    failure: executions.find((execution) => execution.failure !== null)?.failure ?? null,
  });
}

/**
 * Execute a live lifecycle in dependency order and always drain registered
 * cleanup. Results can be passed directly to createLiveReport.
 */
async function runLiveScenarios(registry, operationIds, iteratorOperationId, scenarioLabel) {
  const cleanup = createCleanupRegistry();
  const execution = await executeLiveScenarios(
    registry,
    operationIds,
    iteratorOperationId,
    scenarioLabel,
    cleanup,
  );
  const failure = await drainLiveCleanup(cleanup, execution.failure);
  return createLiveRun(execution, cleanup.results, failure);
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

function requireEmailDomain(value, label) {
  const email = requireString(value, label);
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
  const verifiedDomain = requireEmailDomain(
    verified.email,
    "Verified-domain sandbox request from.email",
  );
  if (
    requireEmailDomain(conversation.email, "Conversation sandbox request from.email") !==
    verifiedDomain
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
          await requireResourceAbsent(
            methods.getDomain,
            absentDomain,
            "Never-registered domain verification",
            "domain",
          );
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
            await requireResourceAbsent(
              methods.getDomain,
              dnslessDomain,
              "DNS-less domain cleanup verification",
              "domain",
            );
          });
          requireDomainResult(createdDomain, dnslessBody.domain, "DNS-less domain setup response");
          requireDnsInvalidDomainResult(
            await methods.getDomain(dnslessDomain),
            dnslessBody.domain,
            "DNS-less domain verification response",
          );
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
          return runListIteratorScenario(methods.list, methods.iterate, pageParams, "Message");
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

function requireStatisticsAuthorizationRule(value, operationId) {
  const label = `Packaged ${operationId} authorization metadata`;
  const rule = requireObject(value, label);
  if (
    rule.kind !== "comma_separated_query_domains" ||
    rule.queryParameter !== "sender_domain" ||
    rule.quantifier !== "every"
  ) {
    throw new TypeError(`${label} must authorize every comma-separated sender_domain value.`);
  }
  const roles = requireObject(rule.roles, `${label} roles`);
  requireString(roles.global, `${label} global role`);
  const domainRole = requireString(roles.domain, `${label} domain role`);
  if (!domainRole.includes("{domain}")) {
    throw new TypeError(`${label} domain role must contain the {domain} placeholder.`);
  }
  return Object.freeze({
    queryParameter: rule.queryParameter,
    quantifier: rule.quantifier,
  });
}

function assertStatisticsMappings(profile, authorization) {
  const expected = new Set(statisticsOperationIds);
  const actual = profile.operations.filter(({ facade }) => facade === "statistics");
  const actualIds = new Set(actual.map(({ operationId }) => operationId));
  const missing = statisticsOperationIds.filter((operationId) => !actualIds.has(operationId));
  const orphaned = actual
    .map(({ operationId }) => operationId)
    .filter((operationId) => !expected.has(operationId));
  if (
    actual.length !== statisticsOperationIds.length ||
    missing.length > 0 ||
    orphaned.length > 0
  ) {
    throw new TypeError(
      `Packaged statistics operation mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}.`,
    );
  }

  const authorizationRegistry = requireObject(authorization, "Packaged authorization registry");
  return Object.freeze({
    operations: new Map(actual.map((mapping) => [mapping.operationId, mapping])),
    authorization: new Map(
      actual.map(({ operationId }) => [
        operationId,
        requireStatisticsAuthorizationRule(authorizationRegistry[operationId], operationId),
      ]),
    ),
  });
}

function requireStatisticsDomains(value) {
  const senderDomains = requireObject(value, "Statistics sender domains");
  const domains = {
    authorized: requireString(senderDomains.authorized, "Authorized statistics sender domain")
      .trim()
      .toLowerCase(),
    unauthorized: requireString(senderDomains.unauthorized, "Unauthorized statistics sender domain")
      .trim()
      .toLowerCase(),
  };
  if (
    Object.values(domains).some(
      (domain) => domain === "" || domain.includes(",") || domain.includes("@"),
    ) ||
    domains.authorized === domains.unauthorized
  ) {
    throw new TypeError(
      "Authorized and unauthorized statistics sender domains must be distinct domain names.",
    );
  }
  return Object.freeze(domains);
}

async function runStatisticsAuthorizationCase({
  method,
  rule,
  senderDomain,
  expectedDomainCount,
  expectedAuthorized,
  label,
}) {
  const params = Object.freeze({ [rule.queryParameter]: senderDomain });
  const suppliedDomains = requireString(
    params[rule.queryParameter],
    `${label} ${rule.queryParameter}`,
  )
    .split(",")
    .map((domain) => domain.trim())
    .filter((domain) => domain !== "");
  if (suppliedDomains.length !== expectedDomainCount) {
    throw new TypeError(`${label} must contain exactly ${expectedDomainCount} sender domains.`);
  }

  let responseValue;
  try {
    responseValue = await method(params);
  } catch (error) {
    if (expectedAuthorized) throw error;
    const failure = requireObject(error, `${label} rejection`);
    if (failure.status !== 403) {
      throw new TypeError(`${label} must fail with HTTP 403.`);
    }
    return Object.freeze({
      authorized: false,
      domainCount: suppliedDomains.length,
      status: 403,
    });
  }
  if (!expectedAuthorized) {
    throw new TypeError(`${label} unexpectedly succeeded.`);
  }

  const response = requireObject(responseValue, `${label} response`);
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new TypeError(`${label} response must be a statistics list.`);
  }
  return Object.freeze({
    authorized: true,
    domainCount: suppliedDomains.length,
    resultBuckets: response.data.length,
  });
}

/**
 * Build one scenario for each statistics operation. Every scenario exercises a
 * permitted domain, a denied domain, and a permitted-first/denied-second pair
 * using the packaged authorization rule that requires every value to pass.
 */
export function createStatisticsScenarioRegistry({
  profile,
  client,
  authorization,
  senderDomains,
}) {
  const mappings = assertStatisticsMappings(profile, authorization);
  const domains = requireStatisticsDomains(senderDomains);
  const scenarios = new Map(
    statisticsOperationIds.map((operationId) => {
      const mapping = mappings.operations.get(operationId);
      const rule = mappings.authorization.get(operationId);
      const method = requireMappedClientMethod(
        client,
        mapping,
        `Statistics ${operationId} scenario`,
      );
      return [
        operationId,
        {
          operationId,
          async run() {
            const singleDomain = await runStatisticsAuthorizationCase({
              method,
              rule,
              senderDomain: domains.authorized,
              expectedDomainCount: 1,
              expectedAuthorized: true,
              label: `${operationId} single-domain authorization`,
            });
            const unauthorizedDomain = await runStatisticsAuthorizationCase({
              method,
              rule,
              senderDomain: domains.unauthorized,
              expectedDomainCount: 1,
              expectedAuthorized: false,
              label: `${operationId} unauthorized-domain authorization`,
            });
            const multiDomain = await runStatisticsAuthorizationCase({
              method,
              rule,
              senderDomain: `${domains.authorized},${domains.unauthorized}`,
              expectedDomainCount: 2,
              expectedAuthorized: false,
              label: `${operationId} multi-domain authorization`,
            });
            return Object.freeze({
              evidence: Object.freeze({
                senderAuthorization: Object.freeze({
                  source: `query.${rule.queryParameter}`,
                  quantifier: rule.quantifier,
                  singleDomain,
                  unauthorizedDomain,
                  multiDomain,
                }),
              }),
            });
          },
        },
      ];
    }),
  );

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/** Execute the three statistics scenarios in packaged operation order. */
export function runStatisticsLiveScenarios(registry) {
  return runLiveScenarios(registry, statisticsOperationIds, null, "Statistics");
}

function requireAPIKeyCreateRequest(value, label) {
  const request = requireObject(value, label);
  const keyLabel = requireString(request.label, `${label} label`);
  if (!Array.isArray(request.scopes) || request.scopes.length === 0) {
    throw new TypeError(`${label} scopes must contain at least one scope.`);
  }
  const scopes = request.scopes.map((scope, index) =>
    requireString(scope, `${label} scope ${index}`),
  );
  if (
    request.ip_allow_list !== undefined &&
    (!Array.isArray(request.ip_allow_list) || request.ip_allow_list.length !== 0)
  ) {
    throw new TypeError(`${label} ip_allow_list must be empty or omitted.`);
  }
  return Object.freeze({ label: keyLabel, scopes: Object.freeze(scopes), ip_allow_list: [] });
}

function requireAPIKeyId(value, label) {
  const result = requireObject(value, label);
  return Object.freeze({
    result,
    id: requireString(result.id, `${label} id`),
  });
}

function requireAPIKeyIPAllowList(value, expected, label) {
  const { result, id } = requireAPIKeyId(value, label);
  if (
    !Array.isArray(result.ip_allow_list) ||
    result.ip_allow_list.length !== expected.length ||
    result.ip_allow_list.some((entry, index) => entry !== expected[index])
  ) {
    throw new TypeError(`${label} returned an unexpected IP allow list.`);
  }
  return Object.freeze({ result, id });
}

function isConflictError(error) {
  return typeof error === "object" && error !== null && error.status === 409;
}

/**
 * Build the five parent API-key scenarios. The create scenario provisions both
 * the lifecycle fixture and a disposable secondary credential. Only the
 * secondary credential attempts a self-locking update; parent authentication
 * remains unrestricted and owns every cleanup action.
 */
export function createAPIKeyScenarioRegistry({
  profile,
  client,
  createSecondaryClient,
  createRequest,
  secondaryCreateRequest,
  pagination = { limit: 1 },
}) {
  if (typeof createSecondaryClient !== "function") {
    throw new TypeError("Secondary API-key client factory must be a function.");
  }
  const mappings = requireLifecycleMappings(
    profile,
    apiKeyOperationIds,
    "apiKeys",
    "getAPIKeys",
    "API-key",
  );
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `API-key ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getAPIKeys"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "API-key iterator scenario"),
    create: mappedOperation("createAPIKey"),
    get: mappedOperation("getAPIKey"),
    update: mappedOperation("updateAPIKey"),
    delete: mappedOperation("deleteAPIKey"),
  });
  const primaryBody = requireAPIKeyCreateRequest(
    createRequest,
    "Primary API-key live create request",
  );
  const secondaryBody = requireAPIKeyCreateRequest(
    secondaryCreateRequest,
    "Secondary API-key live create request",
  );
  const pageParams = requireLivePagination(pagination, "API-key");
  const omittedTransitionLabel = `${primaryBody.label} updated`;
  const nullTransitionLabel = `${primaryBody.label} null-preserved`;
  if (omittedTransitionLabel.length > 255 || nullTransitionLabel.length > 255) {
    throw new TypeError("Primary API-key live create request label is too long for transitions.");
  }

  let primaryKeyId;
  let secondaryKeyId;
  let secondaryClient;
  const requireFixtureId = (value, label) => requireString(value, label);
  const scenarios = new Map([
    [
      "getAPIKeys",
      {
        operationId: "getAPIKeys",
        async run() {
          return runListIteratorScenario(methods.list, methods.iterate, pageParams, "API-key");
        },
      },
    ],
    [
      "createAPIKey",
      {
        operationId: "createAPIKey",
        async run({ cleanup }) {
          const primary = requireAPIKeyId(
            await methods.create(primaryBody),
            "Primary API-key create scenario response",
          );
          primaryKeyId = primary.id;
          cleanup.register("delete and verify primary API-key fixture", async () => {
            try {
              await methods.delete(primary.id);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              methods.get,
              primary.id,
              "Primary API-key cleanup verification",
              "API key",
            );
          });
          requireAPIKeyIPAllowList(primary.result, [], "Primary API-key create scenario response");
          requireString(
            primary.result.secret_key,
            "Primary API-key create scenario response secret",
          );

          const secondary = requireAPIKeyId(
            await methods.create(secondaryBody),
            "Secondary API-key create scenario response",
          );
          secondaryKeyId = secondary.id;
          cleanup.register("delete and verify secondary API-key fixture", async () => {
            try {
              await methods.delete(secondary.id);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              methods.get,
              secondary.id,
              "Secondary API-key cleanup verification",
              "API key",
            );
          });
          requireAPIKeyIPAllowList(
            secondary.result,
            [],
            "Secondary API-key create scenario response",
          );
          const secret = requireString(
            secondary.result.secret_key,
            "Secondary API-key create scenario response secret",
          );
          secondaryClient = createSecondaryClient(secret);
          requireMappedClientMethod(
            secondaryClient,
            mappings.operations.get("updateAPIKey"),
            "Secondary API-key self-lockout scenario",
          );
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: 2,
              created: 2,
              secretsReported: false,
            }),
          });
        },
      },
    ],
    [
      "getAPIKey",
      {
        operationId: "getAPIKey",
        async run() {
          const keyId = requireFixtureId(primaryKeyId, "Primary API-key fixture id");
          const result = requireAPIKeyIPAllowList(
            await methods.get(keyId),
            [],
            "API-key get scenario response",
          );
          if (result.id !== keyId) {
            throw new TypeError("API-key get scenario returned the wrong key.");
          }
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "updateAPIKey",
      {
        operationId: "updateAPIKey",
        async run() {
          const keyId = requireFixtureId(primaryKeyId, "Primary API-key fixture id");
          requireAPIKeyIPAllowList(
            await methods.update(keyId, { label: omittedTransitionLabel }),
            [],
            "API-key omitted IP-list transition",
          );
          requireAPIKeyIPAllowList(
            await methods.update(keyId, {
              ip_allow_list: [restrictedApiKeyAddress, canonicalRestrictedApiKeyAddress],
            }),
            [canonicalRestrictedApiKeyAddress],
            "API-key restricted IP-list transition",
          );
          requireAPIKeyIPAllowList(
            await methods.update(keyId, {
              label: nullTransitionLabel,
              ip_allow_list: null,
            }),
            [canonicalRestrictedApiKeyAddress],
            "API-key null IP-list transition",
          );
          requireAPIKeyIPAllowList(
            await methods.update(keyId, { ip_allow_list: [] }),
            [],
            "API-key clear IP-list transition",
          );

          const disposableKeyId = requireFixtureId(secondaryKeyId, "Secondary API-key fixture id");
          const selfUpdate = requireMappedClientMethod(
            secondaryClient,
            mappings.operations.get("updateAPIKey"),
            "Secondary API-key self-lockout scenario",
          );
          try {
            await selfUpdate(disposableKeyId, { ip_allow_list: [selfLockoutAddress] });
          } catch (error) {
            if (!isConflictError(error)) throw error;
            requireAPIKeyIPAllowList(
              await methods.get(disposableKeyId),
              [],
              "Secondary API-key self-lockout persistence check",
            );
            return Object.freeze({
              evidence: Object.freeze({
                ipAllowList: Object.freeze({
                  cleared: true,
                  nullPreserved: true,
                  omittedPreserved: true,
                  restrictedCanonicalized: true,
                }),
                selfLockout: Object.freeze({ persisted: false, status: 409 }),
              }),
            });
          }
          throw new TypeError("Secondary API-key self-lockout update unexpectedly succeeded.");
        },
      },
    ],
    [
      "deleteAPIKey",
      {
        operationId: "deleteAPIKey",
        async run() {
          const keyId = requireFixtureId(primaryKeyId, "Primary API-key fixture id");
          await methods.delete(keyId);
          await requireResourceAbsent(
            methods.get,
            keyId,
            "API-key delete scenario verification",
            "API key",
          );
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

/** Execute parent API-key scenarios in lifecycle order and always drain cleanup. */
export function runAPIKeyLiveScenarios(registry) {
  return runLiveScenarios(registry, apiKeyOperationIds, "getAPIKeys", "API-key");
}

function requireRouteAuthorizationRule(value, operationId) {
  const label = `Packaged ${operationId} authorization metadata`;
  const rule = requireObject(value, label);
  const roles = requireObject(rule.roles, `${label} roles`);
  requireString(roles.global, `${label} global role`);
  const domainRole = requireString(roles.domain, `${label} domain role`);
  if (!domainRole.includes("{domain}")) {
    throw new TypeError(`${label} domain role must contain the {domain} placeholder.`);
  }

  if (operationId === "getRoutes") {
    if (
      rule.kind !== "query_domain_required_for_scoped" ||
      rule.queryParameter !== "domain" ||
      rule.condition !== "scoped_role_requires_filter"
    ) {
      throw new TypeError(`${label} must require the domain query for scoped access.`);
    }
    return Object.freeze({
      kind: rule.kind,
      source: `query.${rule.queryParameter}`,
    });
  }
  if (operationId === "createRoute") {
    if (rule.kind !== "body_domain" || rule.bodyPath !== "recipient" || rule.quantifier !== "one") {
      throw new TypeError(`${label} must authorize the domain in body.recipient.`);
    }
    return Object.freeze({
      kind: rule.kind,
      quantifier: rule.quantifier,
      source: `body.${rule.bodyPath}`,
    });
  }
  if (
    rule.kind !== "existing_and_replacement_domain" ||
    rule.resource !== "route" ||
    rule.resourceIdParameter !== "route_id" ||
    rule.existingPath !== "recipient" ||
    rule.replacementBodyPath !== "recipient" ||
    rule.quantifier !== "every"
  ) {
    throw new TypeError(`${label} must authorize the existing and replacement recipient domains.`);
  }
  return Object.freeze({
    kind: rule.kind,
    quantifier: rule.quantifier,
    sources: Object.freeze([`existing.${rule.existingPath}`, `body.${rule.replacementBodyPath}`]),
  });
}

function assertRouteMappings(profile, authorization) {
  const mappings = requireLifecycleMappings(
    profile,
    routeOperationIds,
    "routes",
    "getRoutes",
    "route",
  );
  const authorizationRegistry = requireObject(authorization, "Packaged authorization registry");
  return Object.freeze({
    ...mappings,
    authorization: Object.freeze({
      list: requireRouteAuthorizationRule(authorizationRegistry.getRoutes, "getRoutes"),
      create: requireRouteAuthorizationRule(authorizationRegistry.createRoute, "createRoute"),
      update: requireRouteAuthorizationRule(authorizationRegistry.updateRoute, "updateRoute"),
    }),
  });
}

function requireControlledRouteDomains(value) {
  const controlledDomains = requireObject(value, "Controlled route domains");
  const domains = {
    existing: requireString(
      controlledDomains.existing,
      "Existing controlled route domain",
    ).toLowerCase(),
    replacement: requireString(
      controlledDomains.replacement,
      "Replacement controlled route domain",
    ).toLowerCase(),
  };
  if (
    Object.values(domains).some(
      (domain) =>
        domain.trim() !== domain || domain === "" || domain.includes("@") || domain.includes(","),
    ) ||
    domains.existing === domains.replacement
  ) {
    throw new TypeError(
      "Existing and replacement controlled route domains must be distinct domain names.",
    );
  }
  return Object.freeze(domains);
}

function requireRouteRequest(value, label, expectedDomain, requiredKeys) {
  const request = requireObject(value, label);
  for (const key of requiredKeys) requireString(request[key], `${label} ${key}`);
  const actualDomain = requireEmailDomain(request.recipient, `${label} recipient`);
  if (actualDomain !== expectedDomain) {
    throw new TypeError(`${label} recipient must use its controlled route domain.`);
  }
  return Object.freeze({ ...request });
}

function requireRouteResult(value, routeId, expectedDomain, label) {
  const result = requireObject(value, label);
  if (requireString(result.id, `${label} id`) !== routeId) {
    throw new TypeError(`${label} returned the wrong route.`);
  }
  if (requireEmailDomain(result.recipient, `${label} recipient`) !== expectedDomain) {
    throw new TypeError(`${label} returned the wrong recipient domain.`);
  }
  return result;
}

/**
 * Build the five route lifecycle scenarios. The controlled domains define the
 * scoped list filter and the required create/update recipient transition.
 */
export function createRouteScenarioRegistry({
  profile,
  client,
  authorization,
  controlledDomains,
  createRequest,
  updateRequest,
  pagination = { limit: 1 },
}) {
  const mappings = assertRouteMappings(profile, authorization);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Route ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getRoutes"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "Route iterator scenario"),
    create: mappedOperation("createRoute"),
    get: mappedOperation("getRoute"),
    update: mappedOperation("updateRoute"),
    delete: mappedOperation("deleteRoute"),
  });
  const domains = requireControlledRouteDomains(controlledDomains);
  const createBody = requireRouteRequest(
    createRequest,
    "Route live create request",
    domains.existing,
    ["name", "url"],
  );
  const updateBody = requireRouteRequest(
    updateRequest,
    "Route live update request",
    domains.replacement,
    [],
  );
  const pageParams = Object.freeze({
    ...requireLivePagination(pagination, "Route"),
    domain: domains.existing,
  });

  let routeId;
  const fixtureId = () => requireString(routeId, "Route fixture id");
  const scenarios = new Map([
    [
      "getRoutes",
      {
        operationId: "getRoutes",
        async run() {
          const result = await runListIteratorScenario(
            methods.list,
            methods.iterate,
            pageParams,
            "Route",
          );
          return Object.freeze({
            evidence: Object.freeze({
              ...result.evidence,
              scopedAuthorization: Object.freeze({
                domainFilterSupplied: true,
                source: mappings.authorization.list.source,
              }),
            }),
            iteratorEvidence: result.iteratorEvidence,
          });
        },
      },
    ],
    [
      "createRoute",
      {
        operationId: "createRoute",
        async run({ cleanup }) {
          const result = requireObject(
            await methods.create(createBody),
            "Route create scenario response",
          );
          const createdRouteId = requireString(result.id, "Route create scenario response id");
          routeId = createdRouteId;
          cleanup.register("delete and verify route fixture", async () => {
            try {
              await methods.delete(createdRouteId);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              methods.get,
              createdRouteId,
              "Route cleanup verification",
              "route",
            );
          });
          requireRouteResult(
            result,
            createdRouteId,
            domains.existing,
            "Route create scenario response",
          );
          requireString(result.secret, "Route create scenario response secret");
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              recipientAuthorization: Object.freeze({
                controlled: true,
                quantifier: mappings.authorization.create.quantifier,
                source: mappings.authorization.create.source,
              }),
              secretsReported: false,
            }),
          });
        },
      },
    ],
    [
      "getRoute",
      {
        operationId: "getRoute",
        async run() {
          const id = fixtureId();
          requireRouteResult(
            await methods.get(id),
            id,
            domains.existing,
            "Route get scenario response",
          );
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "updateRoute",
      {
        operationId: "updateRoute",
        async run() {
          const id = fixtureId();
          requireRouteResult(
            await methods.get(id),
            id,
            domains.existing,
            "Route existing recipient authorization check",
          );
          requireRouteResult(
            await methods.update(id, updateBody),
            id,
            domains.replacement,
            "Route update scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              recipientAuthorization: Object.freeze({
                existingControlled: true,
                quantifier: mappings.authorization.update.quantifier,
                replacementControlled: true,
                sources: mappings.authorization.update.sources,
              }),
            }),
          });
        },
      },
    ],
    [
      "deleteRoute",
      {
        operationId: "deleteRoute",
        async run() {
          const id = fixtureId();
          await methods.delete(id);
          await requireResourceAbsent(
            methods.get,
            id,
            "Route delete scenario verification",
            "route",
          );
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

/** Execute route scenarios in lifecycle order and always drain cleanup. */
export function runRouteLiveScenarios(registry) {
  return runLiveScenarios(registry, routeOperationIds, "getRoutes", "Route");
}

function requireAllBodyDomainsAuthorizationRule(value, operationId, resourceLabel) {
  const label = `Packaged ${operationId} authorization metadata`;
  const rule = requireObject(value, label);
  const roles = requireObject(rule.roles, `${label} roles`);
  requireString(roles.global, `${label} global role`);
  const domainRole = requireString(roles.domain, `${label} domain role`);
  if (!domainRole.includes("{domain}")) {
    throw new TypeError(`${label} domain role must contain the {domain} placeholder.`);
  }

  if (
    rule.kind !== "all_body_domains" ||
    rule.bodyPath !== "domains" ||
    rule.scopeBodyPath !== "scope" ||
    rule.globalValue !== "global" ||
    rule.quantifier !== "every" ||
    rule.condition !== "global_scope_requires_global_role"
  ) {
    throw new TypeError(
      `${label} must authorize every scoped ${resourceLabel} domain and require the global role for global scope.`,
    );
  }
  return Object.freeze({
    globalRoleRequired: true,
    quantifier: rule.quantifier,
    scopeSource: `body.${rule.scopeBodyPath}`,
    source: `body.${rule.bodyPath}`,
  });
}

function requireWebhookAuthorizationRule(value, operationId) {
  if (operationId === "createWebhook") {
    return requireAllBodyDomainsAuthorizationRule(value, operationId, "configured-webhook");
  }
  const label = `Packaged ${operationId} authorization metadata`;
  const rule = requireObject(value, label);
  const roles = requireObject(rule.roles, `${label} roles`);
  requireString(roles.global, `${label} global role`);
  const domainRole = requireString(roles.domain, `${label} domain role`);
  if (!domainRole.includes("{domain}")) {
    throw new TypeError(`${label} domain role must contain the {domain} placeholder.`);
  }
  if (
    rule.kind !== "existing_and_new_domains" ||
    rule.resource !== "webhook" ||
    rule.resourceIdParameter !== "webhook_id" ||
    rule.existingPath !== "domains" ||
    rule.newBodyPath !== "domains" ||
    rule.scopeBodyPath !== "scope" ||
    rule.globalValue !== "global" ||
    rule.quantifier !== "every" ||
    rule.transition !== "global_scope_requires_global_role"
  ) {
    throw new TypeError(
      `${label} must authorize existing and new domains and require the global role for global transitions.`,
    );
  }
  return Object.freeze({
    existingSource: `existing.${rule.existingPath}`,
    globalRoleRequired: true,
    newSource: `body.${rule.newBodyPath}`,
    quantifier: rule.quantifier,
    scopeSource: `body.${rule.scopeBodyPath}`,
  });
}

function assertWebhookMappings(profile, authorization) {
  const mappings = requireLifecycleMappings(
    profile,
    webhookOperationIds,
    "webhooks",
    "getWebhooks",
    "configured-webhook",
  );
  const authorizationRegistry = requireObject(authorization, "Packaged authorization registry");
  return Object.freeze({
    ...mappings,
    authorization: Object.freeze({
      create: requireWebhookAuthorizationRule(authorizationRegistry.createWebhook, "createWebhook"),
      update: requireWebhookAuthorizationRule(authorizationRegistry.updateWebhook, "updateWebhook"),
    }),
  });
}

function requireControlledDomainList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one domain.`);
  }
  const normalized = value.map((domain, index) =>
    requireString(domain, `${label} entry ${index}`).toLowerCase(),
  );
  if (
    normalized.some(
      (domain) =>
        domain.trim() !== domain || domain === "" || domain.includes("@") || domain.includes(","),
    ) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new TypeError(`${label} must contain distinct domain names.`);
  }
  return Object.freeze(normalized);
}

function requireControlledWebhookDomains(value) {
  const controlledDomains = requireObject(value, "Controlled configured-webhook domains");
  const existing = requireControlledDomainList(
    controlledDomains.existing,
    "Existing controlled webhook domains",
  );
  const newlySupplied = requireControlledDomainList(
    controlledDomains.newlySupplied,
    "Newly supplied controlled webhook domains",
  );
  if (newlySupplied.some((domain) => existing.includes(domain))) {
    throw new TypeError("Existing and newly supplied controlled webhook domains must be distinct.");
  }
  return Object.freeze({ existing, newlySupplied });
}

function requireWebhookRequest(value, label, expectedDomains, requiredKeys) {
  const request = requireObject(value, label);
  for (const key of requiredKeys) requireString(request[key], `${label} ${key}`);
  if (request.scope !== "scoped") {
    throw new TypeError(`${label} scope must be scoped.`);
  }
  requireExactDomains(request.domains, expectedDomains, `${label} domains`);
  return Object.freeze({ ...request, domains: Object.freeze([...expectedDomains]) });
}

function requireExactDomains(value, expectedDomains, label) {
  if (!Array.isArray(value) || value.length !== expectedDomains.length) {
    throw new TypeError(`${label} must contain every controlled domain.`);
  }
  const actual = value.map((domain, index) =>
    requireString(domain, `${label} entry ${index}`).toLowerCase(),
  );
  if (
    new Set(actual).size !== actual.length ||
    expectedDomains.some((domain) => !actual.includes(domain))
  ) {
    throw new TypeError(`${label} must contain every controlled domain.`);
  }
  return Object.freeze(actual);
}

function requireWebhookResult(value, webhookId, scope, expectedDomains, label) {
  const result = requireObject(value, label);
  if (requireString(result.id, `${label} id`) !== webhookId) {
    throw new TypeError(`${label} returned the wrong configured webhook.`);
  }
  if (result.scope !== scope) {
    throw new TypeError(`${label} returned the wrong configured-webhook scope.`);
  }
  requireExactDomains(result.domains, expectedDomains, `${label} domains`);
  return result;
}

/**
 * Build the five configured-webhook lifecycle scenarios. The update primary
 * covers existing associations, new domains, scoped clearing, and the
 * global-scope authorization transition without reporting domain values.
 */
export function createWebhookScenarioRegistry({
  profile,
  client,
  authorization,
  controlledDomains,
  createRequest,
  updateRequest,
  pagination = { limit: 1 },
}) {
  const mappings = assertWebhookMappings(profile, authorization);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Configured-webhook ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getWebhooks"),
    iterate: requireMappedClientMethod(
      client,
      mappings.iterator,
      "Configured-webhook iterator scenario",
    ),
    create: mappedOperation("createWebhook"),
    get: mappedOperation("getWebhook"),
    update: mappedOperation("updateWebhook"),
    delete: mappedOperation("deleteWebhook"),
  });
  const domains = requireControlledWebhookDomains(controlledDomains);
  const createBody = requireWebhookRequest(
    createRequest,
    "Configured-webhook live create request",
    domains.existing,
    ["name", "url"],
  );
  const updateBody = requireWebhookRequest(
    updateRequest,
    "Configured-webhook live update request",
    domains.newlySupplied,
    [],
  );
  const pageParams = requireLivePagination(pagination, "Configured-webhook");

  let webhookId;
  const fixtureId = () => requireString(webhookId, "Configured-webhook fixture id");
  const scenarios = new Map([
    [
      "getWebhooks",
      {
        operationId: "getWebhooks",
        async run() {
          return runListIteratorScenario(
            methods.list,
            methods.iterate,
            pageParams,
            "Configured-webhook",
          );
        },
      },
    ],
    [
      "createWebhook",
      {
        operationId: "createWebhook",
        async run({ cleanup }) {
          const result = requireObject(
            await methods.create(createBody),
            "Configured-webhook create scenario response",
          );
          const createdWebhookId = requireString(
            result.id,
            "Configured-webhook create scenario response id",
          );
          webhookId = createdWebhookId;
          cleanup.register("delete and verify configured-webhook fixture", async () => {
            try {
              await methods.delete(createdWebhookId);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              methods.get,
              createdWebhookId,
              "Configured-webhook cleanup verification",
              "configured webhook",
            );
          });
          requireWebhookResult(
            result,
            createdWebhookId,
            "scoped",
            domains.existing,
            "Configured-webhook create scenario response",
          );
          requireString(result.secret, "Configured-webhook create scenario response secret");
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              scopedAuthorization: Object.freeze({
                controlled: true,
                domainsVerified: domains.existing.length,
                quantifier: mappings.authorization.create.quantifier,
                source: mappings.authorization.create.source,
              }),
              secretsReported: false,
            }),
          });
        },
      },
    ],
    [
      "getWebhook",
      {
        operationId: "getWebhook",
        async run() {
          const id = fixtureId();
          requireWebhookResult(
            await methods.get(id),
            id,
            "scoped",
            domains.existing,
            "Configured-webhook get scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              existingAssociationsVerified: domains.existing.length,
            }),
          });
        },
      },
    ],
    [
      "updateWebhook",
      {
        operationId: "updateWebhook",
        async run() {
          const id = fixtureId();
          requireWebhookResult(
            await methods.get(id),
            id,
            "scoped",
            domains.existing,
            "Configured-webhook existing-association authorization check",
          );
          requireWebhookResult(
            await methods.update(id, updateBody),
            id,
            "scoped",
            domains.newlySupplied,
            "Configured-webhook new-domain update response",
          );
          requireWebhookResult(
            await methods.update(id, { scope: "scoped", domains: [] }),
            id,
            "scoped",
            [],
            "Configured-webhook scoped-clearing response",
          );
          requireWebhookResult(
            await methods.update(id, { scope: "global" }),
            id,
            "global",
            [],
            "Configured-webhook global-transition response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              domainAuthorization: Object.freeze({
                existingAssociationsVerified: domains.existing.length,
                existingSource: mappings.authorization.update.existingSource,
                globalRoleRequired: mappings.authorization.update.globalRoleRequired,
                newDomainsVerified: domains.newlySupplied.length,
                newSource: mappings.authorization.update.newSource,
                quantifier: mappings.authorization.update.quantifier,
                scopeSource: mappings.authorization.update.scopeSource,
              }),
              globalTransitionVerified: true,
              scopedClearingVerified: true,
            }),
          });
        },
      },
    ],
    [
      "deleteWebhook",
      {
        operationId: "deleteWebhook",
        async run() {
          const id = fixtureId();
          await methods.delete(id);
          await requireResourceAbsent(
            methods.get,
            id,
            "Configured-webhook delete scenario verification",
            "configured webhook",
          );
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

/** Execute configured-webhook scenarios in lifecycle order and always drain cleanup. */
export function runWebhookLiveScenarios(registry) {
  return runLiveScenarios(registry, webhookOperationIds, "getWebhooks", "Configured-webhook");
}

function assertSMTPCredentialMappings(profile, authorization) {
  const mappings = requireLifecycleMappings(
    profile,
    smtpCredentialOperationIds,
    "smtpCredentials",
    "getSMTPCredentials",
    "SMTP credential",
  );
  const authorizationRegistry = requireObject(authorization, "Packaged authorization registry");
  return Object.freeze({
    ...mappings,
    authorization: requireAllBodyDomainsAuthorizationRule(
      authorizationRegistry.createSMTPCredential,
      "createSMTPCredential",
      "SMTP credential",
    ),
  });
}

function requireScopedSMTPCredentialRequest(value, expectedDomains) {
  const label = "Scoped SMTP-credential live create request";
  const request = requireObject(value, label);
  requireString(request.name, `${label} name`);
  if (request.scope !== "scoped") {
    throw new TypeError(`${label} scope must be scoped.`);
  }
  requireExactDomains(request.domains, expectedDomains, `${label} domains`);
  return Object.freeze({ ...request, domains: Object.freeze([...expectedDomains]) });
}

function requireGlobalSMTPCredentialRequest(value, expectedDomains) {
  const label = "Global SMTP-credential live create request";
  const request = requireObject(value, label);
  requireString(request.name, `${label} name`);
  if (request.scope !== "global") {
    throw new TypeError(`${label} scope must be global.`);
  }
  requireExactDomains(request.domains, expectedDomains, `${label} domains`);
  return Object.freeze({ ...request, domains: Object.freeze([...expectedDomains]) });
}

function requireSMTPCredentialResult(value, credentialId, scope, expectedDomains, label) {
  const result = requireObject(value, label);
  if (requireString(result.id, `${label} id`) !== credentialId) {
    throw new TypeError(`${label} returned the wrong SMTP credential.`);
  }
  if (result.scope !== scope) {
    throw new TypeError(`${label} returned the wrong SMTP-credential scope.`);
  }
  requireExactDomains(result.domains, expectedDomains, `${label} domains`);
  return result;
}

/**
 * Build the four SMTP-credential lifecycle scenarios. The create primary
 * verifies scoped authorization and the API's accepted-but-ignored global
 * domains behavior without retaining either one-time password.
 */
export function createSMTPCredentialScenarioRegistry({
  profile,
  client,
  authorization,
  controlledDomains,
  scopedCreateRequest,
  globalCreateRequest,
  pagination = { limit: 1 },
}) {
  const mappings = assertSMTPCredentialMappings(profile, authorization);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `SMTP credential ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getSMTPCredentials"),
    iterate: requireMappedClientMethod(
      client,
      mappings.iterator,
      "SMTP credential iterator scenario",
    ),
    create: mappedOperation("createSMTPCredential"),
    get: mappedOperation("getSMTPCredential"),
    delete: mappedOperation("deleteSMTPCredential"),
  });
  const domains = requireControlledDomainList(
    controlledDomains,
    "Controlled SMTP-credential domains",
  );
  const scopedCreateBody = requireScopedSMTPCredentialRequest(scopedCreateRequest, domains);
  const globalCreateBody = requireGlobalSMTPCredentialRequest(globalCreateRequest, domains);
  const pageParams = requireLivePagination(pagination, "SMTP credential");

  let scopedCredentialId;
  const fixtureId = () => requireString(scopedCredentialId, "Scoped SMTP-credential fixture id");
  const registerCleanup = (cleanup, credentialId, label) => {
    cleanup.register(label, async () => {
      try {
        await methods.delete(credentialId);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      await requireResourceAbsent(
        methods.get,
        credentialId,
        "SMTP-credential cleanup verification",
        "SMTP credential",
      );
    });
  };
  const scenarios = new Map([
    [
      "getSMTPCredentials",
      {
        operationId: "getSMTPCredentials",
        async run() {
          return runListIteratorScenario(
            methods.list,
            methods.iterate,
            pageParams,
            "SMTP credential",
          );
        },
      },
    ],
    [
      "createSMTPCredential",
      {
        operationId: "createSMTPCredential",
        async run({ cleanup }) {
          const scopedResult = requireObject(
            await methods.create(scopedCreateBody),
            "Scoped SMTP-credential create scenario response",
          );
          const createdScopedId = requireString(
            scopedResult.id,
            "Scoped SMTP-credential create scenario response id",
          );
          scopedCredentialId = createdScopedId;
          registerCleanup(
            cleanup,
            createdScopedId,
            "delete and verify scoped SMTP-credential fixture",
          );
          requireSMTPCredentialResult(
            scopedResult,
            createdScopedId,
            "scoped",
            domains,
            "Scoped SMTP-credential create scenario response",
          );
          requireString(
            scopedResult.password,
            "Scoped SMTP-credential create scenario response password",
          );

          const globalResult = requireObject(
            await methods.create(globalCreateBody),
            "Global SMTP-credential create scenario response",
          );
          const createdGlobalId = requireString(
            globalResult.id,
            "Global SMTP-credential create scenario response id",
          );
          registerCleanup(
            cleanup,
            createdGlobalId,
            "delete and verify global SMTP-credential fixture",
          );
          requireSMTPCredentialResult(
            globalResult,
            createdGlobalId,
            "global",
            [],
            "Global SMTP-credential create scenario response",
          );
          requireString(
            globalResult.password,
            "Global SMTP-credential create scenario response password",
          );
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: 2,
              globalAuthorization: Object.freeze({
                domainsSupplied: domains.length,
                globalRoleRequired: mappings.authorization.globalRoleRequired,
                scopeSource: mappings.authorization.scopeSource,
                suppliedDomainsIgnored: true,
              }),
              scopedAuthorization: Object.freeze({
                controlled: true,
                domainsVerified: domains.length,
                quantifier: mappings.authorization.quantifier,
                source: mappings.authorization.source,
              }),
              secretsReported: false,
            }),
          });
        },
      },
    ],
    [
      "getSMTPCredential",
      {
        operationId: "getSMTPCredential",
        async run() {
          const id = fixtureId();
          requireSMTPCredentialResult(
            await methods.get(id),
            id,
            "scoped",
            domains,
            "SMTP-credential get scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({ scopedDomainsVerified: domains.length }),
          });
        },
      },
    ],
    [
      "deleteSMTPCredential",
      {
        operationId: "deleteSMTPCredential",
        async run() {
          const id = fixtureId();
          await methods.delete(id);
          await requireResourceAbsent(
            methods.get,
            id,
            "SMTP-credential delete scenario verification",
            "SMTP credential",
          );
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

/** Execute SMTP-credential scenarios in lifecycle order and always drain cleanup. */
export function runSMTPCredentialLiveScenarios(registry) {
  return runLiveScenarios(
    registry,
    smtpCredentialOperationIds,
    "getSMTPCredentials",
    "SMTP credential",
  );
}

function assertAccountMappings(profile) {
  const expected = new Set(accountOperationIds);
  const actual = profile.operations.filter(({ facade }) => facade === "accounts");
  const actualIds = new Set(actual.map(({ operationId }) => operationId));
  const missing = accountOperationIds.filter((operationId) => !actualIds.has(operationId));
  const orphaned = actual
    .map(({ operationId }) => operationId)
    .filter((operationId) => !expected.has(operationId));
  const iterators = profile.iterators.filter(({ facade }) => facade === "accounts");
  if (
    actual.length !== accountOperationIds.length ||
    missing.length > 0 ||
    orphaned.length > 0 ||
    iterators.length > 0
  ) {
    throw new TypeError(
      `Packaged account operation mismatch: missing ${JSON.stringify(missing)}, orphaned ${JSON.stringify(orphaned)}, iterators ${iterators.length}.`,
    );
  }
  return Object.freeze({
    operations: new Map(actual.map((mapping) => [mapping.operationId, mapping])),
  });
}

function requireDisposableAccountId(client, disposableAccountId) {
  const liveClient = requireObject(client, "Live client");
  const expected = requireString(disposableAccountId, "Disposable parent account id");
  if (requireString(liveClient.accountId, "Live client accountId") !== expected) {
    throw new TypeError("Live client must be bound to the disposable parent account.");
  }
  return expected;
}

function requireMemberRequest(value, disposableMailbox) {
  const request = requireObject(value, "Account-member live add request");
  const email = requireString(request.email, "Account-member live add request email");
  const mailbox = requireString(disposableMailbox, "Disposable member mailbox");
  if (email.toLowerCase() !== mailbox.toLowerCase() || !email.includes("@")) {
    throw new TypeError("Account-member live add request must use the disposable member mailbox.");
  }
  if (!["Administrator", "Developer", "Analyst", "Billing Manager"].includes(request.role)) {
    throw new TypeError("Account-member live add request role is invalid.");
  }
  if (request.name !== undefined) {
    requireString(request.name, "Account-member live add request name");
  }
  return Object.freeze({ ...request });
}

function requireAccountMutation(value) {
  const request = requireObject(value, "Account live update request");
  const suppliedFields = Object.keys(request);
  const unexpected = suppliedFields.filter((field) => !mutableAccountFields.includes(field));
  if (suppliedFields.length === 0 || unexpected.length > 0) {
    throw new TypeError(
      `Account live update request must contain mutable account fields only; unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
  for (const field of suppliedFields) {
    if (request[field] === undefined || request[field] === null) {
      throw new TypeError(`Account live update request ${field} must be restorable.`);
    }
  }
  return Object.freeze({ ...request });
}

function requireMutableAccountState(value, expectedAccountId, label) {
  const account = requireObject(value, label);
  if (requireString(account.id, `${label} id`) !== expectedAccountId) {
    throw new TypeError(`${label} returned the wrong account.`);
  }
  const state = {};
  for (const field of mutableAccountFields) {
    const fieldValue = account[field];
    if (
      !(
        fieldValue === undefined ||
        fieldValue === null ||
        typeof fieldValue === "string" ||
        typeof fieldValue === "boolean" ||
        (typeof fieldValue === "number" && Number.isInteger(fieldValue))
      )
    ) {
      throw new TypeError(`${label} ${field} must be present and restorable.`);
    }
    state[field] = fieldValue;
  }
  return Object.freeze(state);
}

function requireAccountFields(value, expectedAccountId, expected, label) {
  const account = requireObject(value, label);
  if (requireString(account.id, `${label} id`) !== expectedAccountId) {
    throw new TypeError(`${label} returned the wrong account.`);
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (account[field] !== expectedValue) {
      throw new TypeError(`${label} did not preserve ${field}.`);
    }
  }
  return account;
}

function requireAccountMembers(value, expectedAccountId, label) {
  const response = requireObject(value, label);
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new TypeError(`${label} must contain account-member data.`);
  }
  for (const [index, entry] of response.data.entries()) {
    const member = requireObject(entry, `${label} member ${index}`);
    if (
      requireString(member.account_id, `${label} member ${index} account_id`) !== expectedAccountId
    ) {
      throw new TypeError(`${label} returned a member from another account.`);
    }
    requireString(member.user_id, `${label} member ${index} user_id`);
  }
  return response;
}

/**
 * Build account and member scenarios for one explicitly identified disposable
 * parent account. Restoration and member removal are registered before any
 * later validation that could fail.
 */
export function createAccountScenarioRegistry({
  profile,
  client,
  disposableAccountId,
  disposableMailbox,
  updateRequest,
  memberRequest,
}) {
  const mappings = assertAccountMappings(profile);
  const accountId = requireDisposableAccountId(client, disposableAccountId);
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Account ${operationId} scenario`,
    );
  const methods = Object.freeze({
    get: mappedOperation("getAccount"),
    update: mappedOperation("updateAccount"),
    listMembers: mappedOperation("getAccountMembers"),
    addMember: mappedOperation("addAccountMember"),
    removeMember: mappedOperation("removeAccountMember"),
  });
  const updateBody = requireAccountMutation(updateRequest);
  const addBody = requireMemberRequest(memberRequest, disposableMailbox);
  let memberId;

  const scenarios = new Map([
    [
      "getAccount",
      {
        operationId: "getAccount",
        async run() {
          requireMutableAccountState(
            await methods.get(),
            accountId,
            "Account get scenario response",
          );
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "updateAccount",
      {
        operationId: "updateAccount",
        async run({ cleanup }) {
          const priorState = requireMutableAccountState(
            await methods.get(),
            accountId,
            "Account prior-state capture",
          );
          const restorationBody = Object.freeze(
            Object.fromEntries(
              Object.keys(updateBody).map((field) => {
                const priorValue = priorState[field];
                if (priorValue === undefined || priorValue === null) {
                  throw new TypeError(
                    `Account prior-state capture ${field} cannot be restored by the update operation.`,
                  );
                }
                return [field, priorValue];
              }),
            ),
          );
          if (
            Object.entries(updateBody).every(
              ([field, updatedValue]) => priorState[field] === updatedValue,
            )
          ) {
            throw new TypeError("Account live update request must change the prior account state.");
          }
          cleanup.register("restore and verify disposable parent account", async () => {
            await methods.update(restorationBody);
            requireAccountFields(
              await methods.get(),
              accountId,
              priorState,
              "Account restoration verification",
            );
          });
          requireAccountFields(
            await methods.update(updateBody),
            accountId,
            updateBody,
            "Account update scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              priorStateCaptured: mutableAccountFields.length,
              restorationRegistered: true,
              updatedFields: Object.keys(updateBody).length,
            }),
          });
        },
      },
    ],
    [
      "getAccountMembers",
      {
        operationId: "getAccountMembers",
        async run() {
          const response = requireAccountMembers(
            await methods.listMembers(),
            accountId,
            "Account-member list scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({ membersObserved: response.data.length }),
          });
        },
      },
    ],
    [
      "addAccountMember",
      {
        operationId: "addAccountMember",
        async run({ cleanup }) {
          const result = requireObject(
            await methods.addMember(addBody),
            "Account-member add scenario response",
          );
          const createdMemberId = requireString(
            result.user_id,
            "Account-member add scenario response user_id",
          );
          memberId = createdMemberId;
          cleanup.register("remove and verify disposable account member", async () => {
            try {
              await methods.removeMember(createdMemberId);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            const members = requireAccountMembers(
              await methods.listMembers(),
              accountId,
              "Account-member cleanup verification",
            );
            if (members.data.some(({ user_id: userId }) => userId === createdMemberId)) {
              throw new TypeError("Account-member cleanup verification found the member.");
            }
          });
          if (result.account_id !== accountId || result.role !== addBody.role) {
            throw new TypeError("Account-member add scenario returned the wrong relationship.");
          }
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              disposableMailboxUsed: true,
              invitationDataReported: false,
            }),
          });
        },
      },
    ],
    [
      "removeAccountMember",
      {
        operationId: "removeAccountMember",
        async run() {
          const id = requireString(memberId, "Disposable account-member fixture id");
          await methods.removeMember(id);
          const members = requireAccountMembers(
            await methods.listMembers(),
            accountId,
            "Account-member removal verification",
          );
          if (members.data.some(({ user_id: userId }) => userId === id)) {
            throw new TypeError("Account-member removal verification found the member.");
          }
          return Object.freeze({ evidence: Object.freeze({ removed: true }) });
        },
      },
    ],
  ]);

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/** Execute account and member scenarios in dependency order and always drain cleanup. */
export function runAccountLiveScenarios(registry) {
  return runLiveScenarios(registry, accountOperationIds, null, "Account");
}

function requireDisposableSuppressionRequest(value, disposableDomain, label) {
  const request = requireObject(value, label);
  const email = requireString(request.email, `${label} email`);
  if (
    email.indexOf("@") < 1 ||
    email.lastIndexOf("@") === email.length - 1 ||
    requireString(request.domain, `${label} domain`) !== disposableDomain
  ) {
    throw new TypeError(`${label} must use an email and the disposable suppression domain.`);
  }
  const expiresAt = requireString(request.expires_at, `${label} expires_at`);
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new TypeError(`${label} expires_at must be an RFC 3339 date-time.`);
  }
  if (request.reason !== undefined) requireString(request.reason, `${label} reason`);
  return Object.freeze({ ...request, email, domain: disposableDomain, expires_at: expiresAt });
}

function requireSuppressionList(value, label) {
  const response = requireObject(value, label);
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new TypeError(`${label} must contain suppression data.`);
  }
  requireObject(response.pagination, `${label} pagination`);
  return response;
}

function matchesSuppression(entry, target, label) {
  const suppression = requireObject(entry, label);
  return suppression.email === target.email && suppression.domain === target.domain;
}

function requireCreatedSuppression(value, target, label) {
  const response = requireObject(value, label);
  if (response.object !== "list" || !Array.isArray(response.data)) {
    throw new TypeError(`${label} must contain created suppression data.`);
  }
  const created = response.data.find((entry, index) =>
    matchesSuppression(entry, target, `${label} suppression ${index}`),
  );
  if (created === undefined) {
    throw new TypeError(`${label} did not return the disposable suppression.`);
  }
  requireString(created.id, `${label} suppression id`);
  return response;
}

async function requireSuppressionAbsent(list, target, label) {
  const response = requireSuppressionList(
    await list({ email: target.email, domain: target.domain, limit: 1 }),
    label,
  );
  if (
    response.data.some((entry, index) =>
      matchesSuppression(entry, target, `${label} suppression ${index}`),
    )
  ) {
    throw new TypeError(`${label} found the disposable suppression.`);
  }
}

/**
 * Build the suppression lifecycle from two domain-scoped disposable records.
 * Every create is followed immediately by cleanup registration, before its
 * response is validated.
 */
export function createSuppressionScenarioRegistry({
  profile,
  client,
  disposableDomain,
  createRequest,
  wipeCreateRequest,
  pagination = { limit: 1 },
}) {
  const mappings = requireLifecycleMappings(
    profile,
    suppressionOperationIds,
    "suppressions",
    "getSuppressions",
    "suppression",
  );
  const domain = requireString(disposableDomain, "Disposable suppression domain");
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Suppression ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("getSuppressions"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "Suppression iterator scenario"),
    create: mappedOperation("createSuppression"),
    delete: mappedOperation("deleteSuppression"),
    wipe: mappedOperation("deleteAllSuppressions"),
  });
  const createBody = requireDisposableSuppressionRequest(
    createRequest,
    domain,
    "Suppression live create request",
  );
  const wipeCreateBody = requireDisposableSuppressionRequest(
    wipeCreateRequest,
    domain,
    "Suppression live wipe fixture request",
  );
  if (createBody.email.toLowerCase() === wipeCreateBody.email.toLowerCase()) {
    throw new TypeError("Suppression create and wipe fixtures must use different emails.");
  }
  const pageParams = requireLivePagination(pagination, "Suppression");
  const deleteParams = (target) => Object.freeze({ email: target.email, domain: target.domain });
  const registerCleanup = (cleanup, target, label) => {
    cleanup.register(label, async () => {
      try {
        await methods.delete(deleteParams(target));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      await requireSuppressionAbsent(methods.list, target, "Suppression cleanup verification");
    });
  };

  const scenarios = new Map([
    [
      "getSuppressions",
      {
        operationId: "getSuppressions",
        async run() {
          return runListIteratorScenario(methods.list, methods.iterate, pageParams, "Suppression");
        },
      },
    ],
    [
      "createSuppression",
      {
        operationId: "createSuppression",
        async run({ cleanup }) {
          const result = await methods.create(createBody);
          registerCleanup(cleanup, createBody, "delete and verify disposable suppression fixture");
          requireCreatedSuppression(result, createBody, "Suppression create scenario response");
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              disposableDataUsed: true,
            }),
          });
        },
      },
    ],
    [
      "deleteSuppression",
      {
        operationId: "deleteSuppression",
        async run() {
          await methods.delete(deleteParams(createBody));
          await requireSuppressionAbsent(
            methods.list,
            createBody,
            "Suppression delete scenario verification",
          );
          return Object.freeze({
            evidence: Object.freeze({ cleanupVerified: true, deleted: true }),
          });
        },
      },
    ],
    [
      "deleteAllSuppressions",
      {
        operationId: "deleteAllSuppressions",
        async run({ cleanup }) {
          const result = await methods.create(wipeCreateBody);
          registerCleanup(
            cleanup,
            wipeCreateBody,
            "delete and verify disposable wipe suppression fixture",
          );
          requireCreatedSuppression(
            result,
            wipeCreateBody,
            "Suppression wipe fixture create response",
          );
          await methods.wipe({ domain });
          await requireSuppressionAbsent(
            methods.list,
            wipeCreateBody,
            "Suppression wipe scenario verification",
          );
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              cleanupVerified: true,
              domainScoped: true,
            }),
          });
        },
      },
    ],
  ]);

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/** Execute suppression scenarios in lifecycle order and always drain cleanup. */
export function runSuppressionLiveScenarios(registry) {
  return runLiveScenarios(registry, suppressionOperationIds, "getSuppressions", "Suppression");
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireSubAccountCredit(value, label) {
  requireNonNegativeSafeInteger(value, label);
  if (value > 1_000_000_000) {
    throw new TypeError(`${label} must not exceed 1000000000.`);
  }
  return value;
}

function requireSubAccountCreateRequest(value) {
  const request = requireObject(value, "Sub-account live create request");
  const unexpected = Object.keys(request).filter(
    (field) => !["monthly_credit", "name", "website"].includes(field),
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `Sub-account live create request contains unexpected fields ${JSON.stringify(unexpected)}.`,
    );
  }
  const name = requireString(request.name, "Sub-account live create request name");
  const website = requireString(request.website, "Sub-account live create request website");
  if (request.monthly_credit !== undefined) {
    requireSubAccountCredit(
      request.monthly_credit,
      "Sub-account live create request monthly_credit",
    );
  }
  return Object.freeze({ ...request, name, website });
}

function requireSubAccountUpdateRequest(value, createBody) {
  const request = requireObject(value, "Sub-account live update request");
  const fields = Object.keys(request);
  const unexpected = fields.filter(
    (field) => !["monthly_credit", "name", "website"].includes(field),
  );
  if (fields.length === 0 || unexpected.length > 0) {
    throw new TypeError(
      `Sub-account live update request must contain editable fields only; unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
  for (const field of fields) {
    const fieldValue = request[field];
    if (fieldValue === undefined || fieldValue === null) {
      throw new TypeError(`Sub-account live update request ${field} must be non-null.`);
    }
    if (field === "monthly_credit") {
      requireSubAccountCredit(fieldValue, "Sub-account live update request monthly_credit");
    } else {
      requireString(fieldValue, `Sub-account live update request ${field}`);
    }
  }
  if (fields.every((field) => request[field] === createBody[field])) {
    throw new TypeError("Sub-account live update request must change the created sub account.");
  }
  return Object.freeze({ ...request });
}

function requireSubAccountResult(value, expectedId, expectedParentId, label) {
  const result = requireObject(value, label);
  if (
    result.object !== "sub_account" ||
    requireString(result.id, `${label} id`) !== expectedId ||
    requireString(result.parent_account_id, `${label} parent_account_id`) !== expectedParentId
  ) {
    throw new TypeError(`${label} returned the wrong sub account.`);
  }
  requireString(result.name, `${label} name`);
  requireString(result.website, `${label} website`);
  requireString(result.created_at, `${label} created_at`);
  requireSubAccountCredit(result.monthly_credit, `${label} monthly_credit`);
  requireNonNegativeSafeInteger(result.domain_count, `${label} domain_count`);
  requireNonNegativeSafeInteger(result.member_count, `${label} member_count`);
  if (!["active", "deleted", "parent-suspended", "suspended"].includes(result.status)) {
    throw new TypeError(`${label} status is invalid.`);
  }
  if (result.last_activity_at !== null) {
    requireString(result.last_activity_at, `${label} last_activity_at`);
  }
  return result;
}

function requireSubAccountFields(result, expected, label) {
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (result[field] !== expectedValue) {
      throw new TypeError(`${label} did not preserve ${field}.`);
    }
  }
  return result;
}

function requireSubAccountStatus(result, expectedStatus, label) {
  if (result.status !== expectedStatus) {
    throw new TypeError(`${label} status must be ${expectedStatus}.`);
  }
  return result;
}

function requireUsageBreakdown(value, label, requireIdentity = false) {
  const breakdown = requireObject(value, label);
  requireNonNegativeSafeInteger(breakdown.reception_count, `${label} reception_count`);
  if (
    typeof breakdown.allocated_cost !== "number" ||
    !Number.isFinite(breakdown.allocated_cost) ||
    breakdown.allocated_cost < 0
  ) {
    throw new TypeError(`${label} allocated_cost must be a non-negative finite number.`);
  }
  if (requireIdentity) {
    requireString(breakdown.account_id, `${label} account_id`);
    if (breakdown.name !== undefined) requireString(breakdown.name, `${label} name`);
  }
  return breakdown;
}

function requireSubAccountUsage(value, expectedParentId, label) {
  const response = requireObject(value, label);
  const billingPeriod = requireObject(response.billing_period, `${label} billing_period`);
  for (const field of ["start", "end"]) {
    const dateTime = requireString(billingPeriod[field], `${label} billing_period ${field}`);
    if (!Number.isFinite(Date.parse(dateTime))) {
      throw new TypeError(`${label} billing_period ${field} must be an RFC 3339 date-time.`);
    }
  }
  requireString(response.currency, `${label} currency`);
  requireString(response.allocation_note, `${label} allocation_note`);
  if (response.allocation_method !== "proportional") {
    throw new TypeError(`${label} allocation_method must be proportional.`);
  }
  const parent = requireUsageBreakdown(response.parent, `${label} parent`, true);
  if (parent.account_id !== expectedParentId) {
    throw new TypeError(`${label} returned usage for the wrong parent account.`);
  }
  if (!Array.isArray(response.sub_accounts)) {
    throw new TypeError(`${label} sub_accounts must be an array.`);
  }
  for (const [index, entry] of response.sub_accounts.entries()) {
    const breakdown = requireUsageBreakdown(entry, `${label} sub_account ${index}`, true);
    requireString(breakdown.name, `${label} sub_account ${index} name`);
  }
  requireUsageBreakdown(response.removed_sub_accounts, `${label} removed_sub_accounts`);
  requireUsageBreakdown(response.total, `${label} total`);
  return response;
}

function requireSubAccountSuspendRequest(value) {
  const request = requireObject(value, "Sub-account live suspend request");
  const fields = Object.keys(request);
  if (fields.length !== 1 || fields[0] !== "reason") {
    throw new TypeError("Sub-account live suspend request must contain only reason.");
  }
  const reason = requireString(request.reason, "Sub-account live suspend request reason");
  if (reason.length > 500) {
    throw new TypeError("Sub-account live suspend request reason must not exceed 500 characters.");
  }
  return Object.freeze({ reason });
}

/**
 * Build the parent sub-account lifecycle around one disposable child. Cleanup
 * is registered as soon as the created child ID is available, before the
 * response's remaining fields are validated.
 */
export function createSubAccountScenarioRegistry({
  profile,
  client,
  createRequest,
  updateRequest,
  suspendRequest,
  pagination = { limit: 1 },
}) {
  const mappings = requireLifecycleMappings(
    profile,
    subAccountOperationIds,
    "subAccounts",
    "listSubAccounts",
    "sub-account",
  );
  const liveClient = requireObject(client, "Live client");
  const parentAccountId = requireString(liveClient.accountId, "Live client accountId");
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Sub-account ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("listSubAccounts"),
    iterate: requireMappedClientMethod(client, mappings.iterator, "Sub-account iterator scenario"),
    create: mappedOperation("createSubAccount"),
    usage: mappedOperation("getSubAccountsUsage"),
    get: mappedOperation("getSubAccount"),
    update: mappedOperation("updateSubAccount"),
    delete: mappedOperation("deleteSubAccount"),
    suspend: mappedOperation("suspendSubAccount"),
    unsuspend: mappedOperation("unsuspendSubAccount"),
  });
  const createBody = requireSubAccountCreateRequest(createRequest);
  const updateBody = requireSubAccountUpdateRequest(updateRequest, createBody);
  const suspendBody = requireSubAccountSuspendRequest(suspendRequest);
  const pageParams = requireLivePagination(pagination, "Sub-account");
  let subAccountId;
  const fixtureId = () => requireString(subAccountId, "Disposable sub-account fixture id");

  const scenarios = new Map([
    [
      "listSubAccounts",
      {
        operationId: "listSubAccounts",
        async run() {
          return runListIteratorScenario(methods.list, methods.iterate, pageParams, "Sub-account");
        },
      },
    ],
    [
      "createSubAccount",
      {
        operationId: "createSubAccount",
        async run({ cleanup }) {
          const result = requireObject(
            await methods.create(createBody),
            "Sub-account create scenario response",
          );
          const createdId = requireString(result.id, "Sub-account create scenario response id");
          subAccountId = createdId;
          cleanup.register("delete and verify disposable sub-account fixture", async () => {
            try {
              await methods.delete(createdId);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              methods.get,
              createdId,
              "Sub-account cleanup verification",
              "sub account",
            );
          });
          requireSubAccountFields(
            requireSubAccountStatus(
              requireSubAccountResult(
                result,
                createdId,
                parentAccountId,
                "Sub-account create scenario response",
              ),
              "active",
              "Sub-account create scenario response",
            ),
            createBody,
            "Sub-account create scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              cleanupRegistered: true,
              disposableDataReported: false,
              status: "active",
            }),
          });
        },
      },
    ],
    [
      "getSubAccountsUsage",
      {
        operationId: "getSubAccountsUsage",
        async run() {
          const response = requireSubAccountUsage(
            await methods.usage(),
            parentAccountId,
            "Sub-account usage scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              allocationMethod: "proportional",
              safeIntegersVerified: true,
              subAccountBuckets: response.sub_accounts.length,
            }),
          });
        },
      },
    ],
    [
      "getSubAccount",
      {
        operationId: "getSubAccount",
        async run() {
          requireSubAccountStatus(
            requireSubAccountResult(
              await methods.get(fixtureId()),
              fixtureId(),
              parentAccountId,
              "Sub-account get scenario response",
            ),
            "active",
            "Sub-account get scenario response",
          );
          return Object.freeze({ evidence: Object.freeze({ matched: true, status: "active" }) });
        },
      },
    ],
    [
      "updateSubAccount",
      {
        operationId: "updateSubAccount",
        async run() {
          const id = fixtureId();
          requireSubAccountFields(
            requireSubAccountStatus(
              requireSubAccountResult(
                await methods.update(id, updateBody),
                id,
                parentAccountId,
                "Sub-account update scenario response",
              ),
              "active",
              "Sub-account update scenario response",
            ),
            updateBody,
            "Sub-account update scenario response",
          );
          return Object.freeze({
            evidence: Object.freeze({
              status: "active",
              updatedFields: Object.keys(updateBody).length,
            }),
          });
        },
      },
    ],
    [
      "suspendSubAccount",
      {
        operationId: "suspendSubAccount",
        async run() {
          const id = fixtureId();
          requireSubAccountStatus(
            requireSubAccountResult(
              await methods.suspend(id, suspendBody),
              id,
              parentAccountId,
              "Sub-account suspend scenario response",
            ),
            "suspended",
            "Sub-account suspend scenario response",
          );
          requireSubAccountStatus(
            requireSubAccountResult(
              await methods.get(id),
              id,
              parentAccountId,
              "Sub-account suspend verification",
            ),
            "suspended",
            "Sub-account suspend verification",
          );
          return Object.freeze({
            evidence: Object.freeze({ status: "suspended", transitionVerified: true }),
          });
        },
      },
    ],
    [
      "unsuspendSubAccount",
      {
        operationId: "unsuspendSubAccount",
        async run() {
          const id = fixtureId();
          requireSubAccountStatus(
            requireSubAccountResult(
              await methods.unsuspend(id),
              id,
              parentAccountId,
              "Sub-account unsuspend scenario response",
            ),
            "active",
            "Sub-account unsuspend scenario response",
          );
          requireSubAccountStatus(
            requireSubAccountResult(
              await methods.get(id),
              id,
              parentAccountId,
              "Sub-account unsuspend verification",
            ),
            "active",
            "Sub-account unsuspend verification",
          );
          return Object.freeze({
            evidence: Object.freeze({ status: "active", transitionVerified: true }),
          });
        },
      },
    ],
    [
      "deleteSubAccount",
      {
        operationId: "deleteSubAccount",
        async run() {
          const id = fixtureId();
          await methods.delete(id);
          await requireResourceAbsent(
            methods.get,
            id,
            "Sub-account delete scenario verification",
            "sub account",
          );
          return Object.freeze({
            evidence: Object.freeze({ cleanupVerified: true, deleted: true }),
          });
        },
      },
    ],
  ]);

  const registry = createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
  disposableSubAccountIds.set(registry, fixtureId);
  return registry;
}

/** Execute the disposable child lifecycle and always drain registered cleanup. */
export function runSubAccountLiveScenarios(registry) {
  return runLiveScenarios(registry, subAccountOperationIds, "listSubAccounts", "Sub-account");
}

function isUnsupportedChildAPIKeyScope(scope) {
  return scope.startsWith("sub-accounts:") || scope.startsWith("sub-account-api-keys:");
}

function assertSupportedChildAPIKeyScopes(scopes, label) {
  const unsupported = scopes.filter(isUnsupportedChildAPIKeyScope);
  if (unsupported.length > 0) {
    throw new TypeError(
      `${label} cannot grant child credentials sub-account management authority.`,
    );
  }
}

function requireChildAPIKeyScopes(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one scope.`);
  }
  const scopes = value.map((scope, index) => requireString(scope, `${label} ${index}`));
  assertSupportedChildAPIKeyScopes(scopes, label);
  return Object.freeze(scopes);
}

function requireChildAPIKeyCreateRequest(value) {
  const label = "Child API-key live create request";
  const request = requireObject(value, label);
  const unexpected = Object.keys(request).filter(
    (field) => !["ip_allow_list", "label", "scopes"].includes(field),
  );
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unexpected fields ${JSON.stringify(unexpected)}.`);
  }
  const body = requireAPIKeyCreateRequest(request, label);
  assertSupportedChildAPIKeyScopes(body.scopes, `${label} scopes`);
  return body;
}

function requireChildAPIKeyUpdateRequest(value, createBody) {
  const request = requireObject(value, "Child API-key live update request");
  const fields = Object.keys(request);
  const unexpected = fields.filter(
    (field) => !["ip_allow_list", "label", "scopes"].includes(field),
  );
  if (fields.length === 0 || unexpected.length > 0) {
    throw new TypeError(
      `Child API-key live update request must contain editable fields only; unexpected ${JSON.stringify(unexpected)}.`,
    );
  }
  const body = {};
  if (Object.hasOwn(request, "label")) {
    body.label =
      request.label === null
        ? null
        : requireString(request.label, "Child API-key live update request label");
  }
  if (Object.hasOwn(request, "scopes")) {
    body.scopes =
      request.scopes === null
        ? null
        : requireChildAPIKeyScopes(request.scopes, "Child API-key live update request scopes");
  }
  if (Object.hasOwn(request, "ip_allow_list")) {
    if (request.ip_allow_list === null) {
      body.ip_allow_list = null;
    } else if (!Array.isArray(request.ip_allow_list)) {
      throw new TypeError(
        "Child API-key live update request ip_allow_list must be an array or null.",
      );
    } else {
      body.ip_allow_list = Object.freeze(
        request.ip_allow_list.map((entry, index) =>
          requireString(entry, `Child API-key live update request ip_allow_list ${index}`),
        ),
      );
    }
  }
  const sameValue = (left, right) =>
    Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((entry, index) => entry === right[index])
      : left === right;
  const changedFields = fields.filter(
    (field) => body[field] !== null && !sameValue(body[field], createBody[field]),
  );
  if (changedFields.length === 0) {
    throw new TypeError("Child API-key live update request must change the created API key.");
  }
  return Object.freeze({
    body: Object.freeze(body),
    changedFields: Object.freeze(changedFields),
  });
}

function requireChildAPIKeyResult(value, subAccountId, label, expectedId) {
  const result = requireObject(value, label);
  const id = requireString(result.id, `${label} id`);
  if (
    result.object !== "api_key" ||
    result.account_id !== subAccountId ||
    (expectedId !== undefined && id !== expectedId)
  ) {
    throw new TypeError(`${label} returned the wrong child API key.`);
  }
  requireString(result.label, `${label} label`);
  const scopes = requireChildAPIKeyScopes(
    result.scopes.map((scope, index) => {
      const record = requireObject(scope, `${label} scope ${index}`);
      return record.scope;
    }),
    `${label} scopes`,
  );
  if (!Array.isArray(result.ip_allow_list)) {
    throw new TypeError(`${label} ip_allow_list must be an array.`);
  }
  const ipAllowList = Object.freeze(
    result.ip_allow_list.map((entry, index) =>
      requireString(entry, `${label} ip_allow_list ${index}`),
    ),
  );
  return Object.freeze({ id, ipAllowList, result, scopes });
}

function requireChildAPIKeyReadResult(value, subAccountId, label, expectedId) {
  const parsed = requireChildAPIKeyResult(value, subAccountId, label, expectedId);
  if (Object.hasOwn(parsed.result, "secret_key")) {
    throw new TypeError(`${label} must not expose the creation-only secret.`);
  }
  return parsed;
}

/**
 * Build the five child API-key scenarios beneath an already disposable child.
 * The parent client owns all nested-key mutations and cleanup. The one-time
 * secret is passed only to the child-client bootstrap factory.
 */
export function createSubAccountAPIKeyScenarioRegistry({
  profile,
  client,
  subAccountId,
  createChildClient,
  createRequest,
  updateRequest,
  pagination = { limit: 1 },
}) {
  if (typeof createChildClient !== "function") {
    throw new TypeError("Child API-key client factory must be a function.");
  }
  const childId = requireString(subAccountId, "Disposable sub-account id");
  const mappings = requireLifecycleMappings(
    profile,
    subAccountAPIKeyOperationIds,
    "subAccounts.apiKeys",
    "listSubAccountAPIKeys",
    "child API-key",
  );
  const mappedOperation = (operationId) =>
    requireMappedClientMethod(
      client,
      mappings.operations.get(operationId),
      `Child API-key ${operationId} scenario`,
    );
  const methods = Object.freeze({
    list: mappedOperation("listSubAccountAPIKeys"),
    iterate: requireMappedClientMethod(
      client,
      mappings.iterator,
      "Child API-key iterator scenario",
    ),
    create: mappedOperation("createSubAccountAPIKey"),
    get: mappedOperation("getSubAccountAPIKey"),
    update: mappedOperation("updateSubAccountAPIKey"),
    delete: mappedOperation("deleteSubAccountAPIKey"),
  });
  const createBody = requireChildAPIKeyCreateRequest(createRequest);
  const update = requireChildAPIKeyUpdateRequest(updateRequest, createBody);
  const pageParams = requireLivePagination(pagination, "Child API-key");
  let keyId;
  const fixtureId = () => requireString(keyId, "Disposable child API-key fixture id");
  const validateReadEntry = (entry, label) => requireChildAPIKeyReadResult(entry, childId, label);

  const scenarios = new Map([
    [
      "listSubAccountAPIKeys",
      {
        operationId: "listSubAccountAPIKeys",
        async run() {
          return runListIteratorScenario(
            (params) => methods.list(childId, params),
            (params) => methods.iterate(childId, params),
            pageParams,
            "Child API-key",
            validateReadEntry,
          );
        },
      },
    ],
    [
      "createSubAccountAPIKey",
      {
        operationId: "createSubAccountAPIKey",
        async run({ cleanup }) {
          const created = requireObject(
            await methods.create(childId, createBody),
            "Child API-key create scenario response",
          );
          const createdId = requireString(created.id, "Child API-key create scenario response id");
          keyId = createdId;
          cleanup.register("delete and verify disposable child API-key fixture", async () => {
            try {
              await methods.delete(childId, createdId);
            } catch (error) {
              if (!isNotFoundError(error)) throw error;
            }
            await requireResourceAbsent(
              (id) => methods.get(childId, id),
              createdId,
              "Child API-key cleanup verification",
              "child API key",
            );
          });
          const parsed = requireChildAPIKeyResult(
            created,
            childId,
            "Child API-key create scenario response",
            createdId,
          );
          const secret = requireString(
            parsed.result.secret_key,
            "Child API-key create scenario response secret",
          );
          const childClient = requireObject(
            createChildClient(secret, childId),
            "Bootstrapped child client",
          );
          if (childClient.accountId !== childId) {
            throw new TypeError(
              "Bootstrapped child client must use the disposable sub-account id.",
            );
          }
          const ping = requireMappedClientMethod(
            childClient,
            { facade: "client", method: "ping" },
            "Bootstrapped child client",
          );
          const response = requireObject(await ping(), "Bootstrapped child client ping response");
          requireString(response.message, "Bootstrapped child client ping response message");
          return Object.freeze({
            evidence: Object.freeze({
              bootstrapAuthenticated: true,
              cleanupRegistered: true,
              parentManaged: true,
              secretsReported: false,
              unsupportedAuthorityGranted: false,
            }),
          });
        },
      },
    ],
    [
      "getSubAccountAPIKey",
      {
        operationId: "getSubAccountAPIKey",
        async run() {
          const id = fixtureId();
          requireChildAPIKeyReadResult(
            await methods.get(childId, id),
            childId,
            "Child API-key get scenario response",
            id,
          );
          return Object.freeze({ evidence: Object.freeze({ matched: true }) });
        },
      },
    ],
    [
      "updateSubAccountAPIKey",
      {
        operationId: "updateSubAccountAPIKey",
        async run() {
          const id = fixtureId();
          const updated = requireChildAPIKeyReadResult(
            await methods.update(childId, id, update.body),
            childId,
            "Child API-key update scenario response",
            id,
          );
          for (const field of update.changedFields) {
            const expected = update.body[field];
            const actual =
              field === "scopes"
                ? updated.scopes
                : field === "ip_allow_list"
                  ? updated.ipAllowList
                  : updated.result[field];
            if (
              Array.isArray(expected)
                ? !(
                    Array.isArray(actual) &&
                    expected.length === actual.length &&
                    expected.every((entry, index) => entry === actual[index])
                  )
                : actual !== expected
            ) {
              throw new TypeError(`Child API-key update scenario did not preserve ${field}.`);
            }
          }
          return Object.freeze({
            evidence: Object.freeze({
              parentManaged: true,
              updatedFields: update.changedFields.length,
            }),
          });
        },
      },
    ],
    [
      "deleteSubAccountAPIKey",
      {
        operationId: "deleteSubAccountAPIKey",
        async run() {
          const id = fixtureId();
          await methods.delete(childId, id);
          await requireResourceAbsent(
            (key) => methods.get(childId, key),
            id,
            "Child API-key delete scenario verification",
            "child API key",
          );
          return Object.freeze({
            evidence: Object.freeze({ cleanupVerified: true, deleted: true }),
          });
        },
      },
    ],
  ]);

  return createScenarioRegistry(
    profile,
    profile.operations.map(({ operationId }) => scenarios.get(operationId) ?? { operationId }),
  );
}

/** Execute child API-key scenarios in lifecycle order and always drain cleanup. */
export function runSubAccountAPIKeyLiveScenarios(registry) {
  return runLiveScenarios(
    registry,
    subAccountAPIKeyOperationIds,
    "listSubAccountAPIKeys",
    "Child API-key",
  );
}

/**
 * Reuse the disposable sub-account from the parent lifecycle for child API-key
 * scenarios. Both lifecycles share one cleanup registry, and the parent delete
 * runs only after the nested key lifecycle has finished.
 */
export async function runSubAccountAndAPIKeyLiveScenarios(
  subAccountRegistry,
  createAPIKeyRegistry,
) {
  if (typeof createAPIKeyRegistry !== "function") {
    throw new TypeError("Child API-key scenario registry factory must be a function.");
  }
  const fixtureId = disposableSubAccountIds.get(subAccountRegistry);
  if (fixtureId === undefined) {
    throw new TypeError(
      "Combined child API-key scenarios require a disposable sub-account scenario registry.",
    );
  }

  const cleanup = createCleanupRegistry();
  const parentLifecycleIds = subAccountOperationIds.slice(0, -1);
  const parentLifecycle = await executeLiveScenarios(
    subAccountRegistry,
    parentLifecycleIds,
    "listSubAccounts",
    "Sub-account",
    cleanup,
  );
  let childLifecycle = null;
  let parentDelete = null;
  let lifecycleError;
  let lifecycleFailed = false;
  if (parentLifecycle.failure === null) {
    try {
      const childRegistry = createAPIKeyRegistry(fixtureId());
      childLifecycle = await executeLiveScenarios(
        childRegistry,
        subAccountAPIKeyOperationIds,
        "listSubAccountAPIKeys",
        "Child API-key",
        cleanup,
      );
      if (childLifecycle.failure === null) {
        parentDelete = await executeLiveScenarios(
          subAccountRegistry,
          ["deleteSubAccount"],
          null,
          "Sub-account",
          cleanup,
        );
      }
    } catch (error) {
      lifecycleFailed = true;
      lifecycleError = error;
    }
  }

  const parentExecution = mergeLiveExecutions(
    parentLifecycle,
    ...(parentDelete === null ? [] : [parentDelete]),
  );
  const operationFailure =
    parentExecution.failure !== null
      ? Object.freeze({ ...parentExecution.failure, suite: "subAccounts" })
      : childLifecycle?.failure !== null && childLifecycle?.failure !== undefined
        ? Object.freeze({ ...childLifecycle.failure, suite: "subAccounts.apiKeys" })
        : null;
  const failure = await drainLiveCleanup(cleanup, operationFailure);
  if (lifecycleFailed) throw lifecycleError;

  const cleanupResults = cleanup.results;
  return Object.freeze({
    subAccounts: createLiveRun(parentExecution, cleanupResults),
    subAccountAPIKeys:
      childLifecycle === null ? null : createLiveRun(childLifecycle, cleanupResults),
    cleanupResults,
    failure,
  });
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
    const primaryEvidence = requireObject(
      primary.evidence,
      `Primary list-operation result ${primary.operationId} evidence`,
    );
    const iteratorEvidence = requireObject(
      iterator.evidence,
      `Iterator inventory result ${iterator.operationId} evidence`,
    );
    const primaryLimit = primaryEvidence.limit;
    const iteratorLimit = iteratorEvidence.limit;
    if (
      !Number.isInteger(primaryLimit) ||
      primaryLimit <= 0 ||
      iteratorLimit !== primaryLimit ||
      !Number.isInteger(iteratorEvidence.items) ||
      iteratorEvidence.items < 0 ||
      !["backward", "forward"].includes(primaryEvidence.direction) ||
      iteratorEvidence.direction !== primaryEvidence.direction
    ) {
      throw new TypeError(
        `Iterator inventory result ${iterator.operationId} must record one linked positive-limit list subcase.`,
      );
    }
  }
}

function requirePassedResults(results, label) {
  const unexpected = results
    .filter(({ status }) => status !== "passed")
    .map(({ operationId, status }) => ({ operationId, status }));
  if (unexpected.length > 0) {
    throw new TypeError(
      `${label} requires every result to pass; unexpected outcomes ${JSON.stringify(unexpected)}.`,
    );
  }
}

function resultEvidenceByOperationId(operations, operationId) {
  const result = operations.find((entry) => entry.operationId === operationId);
  if (result === undefined) {
    throw new TypeError(`Required live outcome ${operationId} is missing.`);
  }
  return requireObject(result.evidence, `Live outcome ${operationId} evidence`);
}

const positiveIntegerOutcome = Symbol("positive integer live outcome");

function requireOutcomePath(evidence, path, label) {
  const segments = path.split(".");
  let current = evidence;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) return current[segment];
    current = requireObject(current[segment], `${label} ${segments.slice(0, index + 1).join(".")}`);
  }
}

function requireOperationOutcomes(operations, operationId, expectations) {
  const evidence = resultEvidenceByOperationId(operations, operationId);
  for (const [path, expected] of expectations) {
    const label = `Live outcome ${operationId} ${path}`;
    const actual = requireOutcomePath(evidence, path, label);
    if (expected === positiveIntegerOutcome) {
      if (!Number.isInteger(actual) || actual <= 0) {
        throw new TypeError(`${label} must be a positive integer.`);
      }
    } else if (
      Array.isArray(expected)
        ? !Array.isArray(actual) ||
          actual.length !== expected.length ||
          actual.some((entry, index) => entry !== expected[index])
        : actual !== expected
    ) {
      throw new TypeError(`${label} must be ${JSON.stringify(expected)}.`);
    }
  }
}

function requireSandboxOutcomes(operations) {
  requireOperationOutcomes(operations, "createMessage", [
    ["senderAuthorization.source", "body.from.email"],
    ["sandbox.verified.accepted", true],
    ["sandbox.verified.results", positiveIntegerOutcome],
    ["sandbox.neverRegistered.rejected", true],
    ["sandbox.neverRegistered.status", 400],
    ["sandbox.neverRegistered.reason", "domain_not_registered"],
    ["sandbox.dnsless.rejected", true],
    ["sandbox.dnsless.status", 400],
    ["sandbox.dnsless.reason", "dns_not_verified"],
  ]);
}

const requiredAuthorizationOutcomes = Object.freeze([
  ["createConversationMessage", [["senderAuthorization.source", "body.from.email"]]],
  [
    "getRoutes",
    [
      ["scopedAuthorization.domainFilterSupplied", true],
      ["scopedAuthorization.source", "query.domain"],
    ],
  ],
  [
    "createRoute",
    [
      ["recipientAuthorization.controlled", true],
      ["recipientAuthorization.quantifier", "one"],
      ["recipientAuthorization.source", "body.recipient"],
    ],
  ],
  [
    "updateRoute",
    [
      ["recipientAuthorization.existingControlled", true],
      ["recipientAuthorization.replacementControlled", true],
      ["recipientAuthorization.quantifier", "every"],
      ["recipientAuthorization.sources", ["existing.recipient", "body.recipient"]],
    ],
  ],
  [
    "createWebhook",
    [
      ["scopedAuthorization.controlled", true],
      ["scopedAuthorization.domainsVerified", positiveIntegerOutcome],
      ["scopedAuthorization.quantifier", "every"],
      ["scopedAuthorization.source", "body.domains"],
    ],
  ],
  [
    "updateWebhook",
    [
      ["domainAuthorization.existingAssociationsVerified", positiveIntegerOutcome],
      ["domainAuthorization.newDomainsVerified", positiveIntegerOutcome],
      ["domainAuthorization.quantifier", "every"],
      ["domainAuthorization.globalRoleRequired", true],
      ["domainAuthorization.existingSource", "existing.domains"],
      ["domainAuthorization.newSource", "body.domains"],
      ["domainAuthorization.scopeSource", "body.scope"],
      ["globalTransitionVerified", true],
      ["scopedClearingVerified", true],
    ],
  ],
  [
    "createSMTPCredential",
    [
      ["scopedAuthorization.controlled", true],
      ["scopedAuthorization.domainsVerified", positiveIntegerOutcome],
      ["scopedAuthorization.quantifier", "every"],
      ["scopedAuthorization.source", "body.domains"],
      ["globalAuthorization.globalRoleRequired", true],
      ["globalAuthorization.domainsSupplied", positiveIntegerOutcome],
      ["globalAuthorization.scopeSource", "body.scope"],
      ["globalAuthorization.suppliedDomainsIgnored", true],
    ],
  ],
]);

function requireAuthorizationOutcomes(operations) {
  for (const [operationId, expectations] of requiredAuthorizationOutcomes) {
    requireOperationOutcomes(operations, operationId, expectations);
  }
  for (const operationId of statisticsOperationIds) {
    requireOperationOutcomes(operations, operationId, [
      ["senderAuthorization.source", "query.sender_domain"],
      ["senderAuthorization.quantifier", "every"],
      ["senderAuthorization.singleDomain.authorized", true],
      ["senderAuthorization.singleDomain.domainCount", 1],
      ["senderAuthorization.unauthorizedDomain.authorized", false],
      ["senderAuthorization.unauthorizedDomain.domainCount", 1],
      ["senderAuthorization.unauthorizedDomain.status", 403],
      ["senderAuthorization.multiDomain.authorized", false],
      ["senderAuthorization.multiDomain.domainCount", 2],
      ["senderAuthorization.multiDomain.status", 403],
    ]);
  }
}

function countLeakedSecrets(value, source) {
  let leaks = SECRET_PATTERNS.filter((pattern) => pattern.test(source)).length;
  if (/\bBearer\s+(?!\[REDACTED\])\S+/u.test(source)) leaks += 1;
  function visit(current) {
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry);
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const normalizedKey = key.replace(/[-_]/gu, "").toLowerCase();
      if (sensitiveFieldNames.has(normalizedKey) && entry !== "[REDACTED]") {
        leaks += 1;
      }
      visit(entry);
    }
  }
  visit(value);
  return leaks;
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
  requirePassedResults(report.operations, "Primary operation inventory");
  requirePassedResults(report.iterators, "Iterator inventory");
  validateReportIteratorLinks(report.operations, report.iterators);
  requireSandboxOutcomes(report.operations);
  requireAuthorizationOutcomes(report.operations);
  if (!Array.isArray(report.cleanup)) {
    throw new TypeError("Live acceptance report cleanup must be an array.");
  }
  let cleanupFailures = 0;
  for (const [index, entry] of report.cleanup.entries()) {
    const result = requireObject(entry, `Live acceptance report cleanup result ${index}`);
    requireExactKeys(result, ["label", "status"], `Live acceptance report cleanup result ${index}`);
    requireString(result.label, `Live acceptance report cleanup result ${index} label`);
    if (!["failed", "passed"].includes(result.status)) {
      throw new TypeError(`Live acceptance report cleanup result ${index} has an invalid status.`);
    }
    if (result.status === "failed") cleanupFailures += 1;
  }
  if (cleanupFailures > 0) {
    throw new TypeError(
      `Live acceptance report requires zero cleanup failures; received ${cleanupFailures}.`,
    );
  }
  const leakedSecrets = countLeakedSecrets(report, source.toString("utf8"));
  if (leakedSecrets > 0) {
    throw new TypeError(
      `Live acceptance report requires zero leaked secrets; detected ${leakedSecrets}.`,
    );
  }
  return Object.freeze({
    report,
    reportSha256: actualDigest,
    package: identity,
    operations: report.operations.length,
    iterators: report.iterators.length,
    authorizationOutcomes: 11,
    sandboxOutcomes: 3,
    unexpectedFailures: 0,
    cleanupFailures: 0,
    leakedSecrets: 0,
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
