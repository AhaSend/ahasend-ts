#!/usr/bin/env node

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import yaml from "js-yaml";
import ts from "typescript";
import {
  canonicalizeJson,
  digestJsonArtifact,
  digestYamlArtifact,
  sha256Hex,
} from "./digest-artifact.mjs";
import {
  NODE_CODE_SAMPLES,
  NODE_OPERATION_KEYS,
  NODE_SAMPLE_REGISTRY,
} from "./node-code-samples.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const require = createRequire(import.meta.url);
const operationProfile = require("../src/generated/operation-profile.json");
const PUBLIC_OPERATION_FACADES = Object.freeze(
  Object.fromEntries(
    operationProfile.operations.map(({ operationId, facade, method }) => [
      operationId,
      facade === "client" ? `client.${method}` : `client.${facade}.${method}`,
    ]),
  ),
);
const INVENTORY_KEYS = [
  "operationIds",
  "schemaNames",
  "idempotencyOperationIds",
  "subAccountOperationIds",
  "subAccountSchemaNames",
  "roleAlternativeOperationIds",
];
const NODE_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "js",
  "ts",
  "node",
  "nodejs",
  "node.js",
]);
const IDEMPOTENCY_PARAMETER = "#/components/parameters/IdempotencyKey";
const SANDBOX_OPERATION_IDS = new Set(["createMessage", "createConversationMessage"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SIGNATURE_PATTERN = /^v1,[A-Za-z0-9+/]{43}=$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_PATH = "contracts/webhooks/captured";
const TYPESCRIPT_RESULTS_PATH = `${EVIDENCE_PATH}/typescript-results.json`;
const TYPESCRIPT_RESULTS_SIDECAR_PATH = `${EVIDENCE_PATH}/typescript-results.sha256`;
const SYNTHETIC_PATH = "contracts/webhooks/synthetic";
const HEADER_RECORD_FORMAT =
  "webhook-id:{webhookId}\nwebhook-timestamp:{webhookTimestamp}\nwebhook-signature:{signature}\n";
const SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".betterborg-runtime",
  ".betterborg-task",
  ".git",
  "coverage",
  "dist",
  "node_modules",
]);
const SECRET_CLASSIFICATIONS = new Map([
  [`${EVIDENCE_PATH}/keys/configured-webhook.key`, "captured-webhook-signing-key"],
  [`${EVIDENCE_PATH}/keys/route.key`, "captured-route-signing-key"],
  [`${SYNTHETIC_PATH}/keys/configured-webhook.key`, "synthetic-test-signing-key"],
]);
const execFileAsync = promisify(execFile);

function assertRecord(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${location} must be a mapping`);
  }
  return value;
}

function assertArray(value, location) {
  if (!Array.isArray(value)) throw new TypeError(`${location} must be an array`);
  return value;
}

function assertExactKeys(value, expected, location) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new TypeError(
      `${location} fields must be ${JSON.stringify(sortedExpected)}; received ${JSON.stringify(actual)}`,
    );
  }
}

function assertString(value, location, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${location} must be a valid non-empty string`);
  }
  return value;
}

function parseJson(source, location) {
  try {
    return JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid JSON in ${location}: ${message}`, { cause: error });
  }
}

function isPathWithin(directory, target) {
  const relativePath = relative(directory, target);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function resolveSyntheticFixturePath(root, syntheticRoot, path, fixtureId) {
  if (typeof path !== "string" || !path.startsWith(`${SYNTHETIC_PATH}/`)) {
    throw new TypeError(`${fixtureId} must remain in the synthetic fixture tree`);
  }
  const resolvedSyntheticRoot = resolve(root, SYNTHETIC_PATH);
  const resolvedPath = resolve(root, path);
  if (!isPathWithin(resolvedSyntheticRoot, resolvedPath)) {
    throw new TypeError(`${fixtureId} must remain in the synthetic fixture tree`);
  }
  const canonicalPath = await realpath(resolvedPath);
  if (!isPathWithin(syntheticRoot, canonicalPath)) {
    throw new TypeError(`${fixtureId} must remain in the synthetic fixture tree`);
  }
  return canonicalPath;
}

function keyBytesFromFile(bytes, location) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!source.endsWith("\n") || source.slice(0, -1).includes("\n")) {
    throw new TypeError(`${location} must contain one UTF-8 signing key followed by one LF`);
  }
  const key = source.slice(0, -1);
  if (key.length === 0 || key.trim() !== key) {
    throw new TypeError(`${location} contains an invalid signing key`);
  }
  return Buffer.from(key, "utf8");
}

function headerRecord(capture, format) {
  return Buffer.from(
    format
      .replaceAll("{webhookId}", capture.webhookId)
      .replaceAll("{webhookTimestamp}", capture.webhookTimestamp)
      .replaceAll("{signature}", capture.signature),
    "utf8",
  );
}

function hmacSignature(keyBytes, webhookId, webhookTimestamp, rawBody) {
  const digest = createHmac("sha256", keyBytes)
    .update(webhookId, "utf8")
    .update(".", "utf8")
    .update(webhookTimestamp, "utf8")
    .update(".", "utf8")
    .update(rawBody)
    .digest("base64");
  return `v1,${digest}`;
}

function compileCapturedManifestSchema(schema) {
  const root = assertRecord(schema, "Captured evidence manifest schema");
  if (root.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new TypeError("Captured evidence manifest schema must use JSON Schema 2020-12");
  }
  if (root.type !== "object" || root.additionalProperties !== false) {
    throw new TypeError("Captured evidence manifest schema must define a closed object");
  }
  const required = assertArray(root.required, "Captured evidence schema required fields");
  for (const field of ["$schema", "version", "serverCommit", "headerRecordFormat", "captures"]) {
    if (!required.includes(field))
      throw new TypeError(`Captured evidence schema must require ${field}`);
  }
  const definitions = assertRecord(root.$defs, "Captured evidence schema definitions");
  const capture = assertRecord(definitions.capture, "Captured evidence capture schema");
  const captureRequired = assertArray(
    capture.required,
    "Captured evidence capture required fields",
  );
  for (const field of [
    "fixtureId",
    "bodyPath",
    "rawBodySha256",
    "signingResource",
    "webhookId",
    "webhookTimestamp",
    "signature",
    "headersSha256",
    "provenance",
    "expectedResult",
  ]) {
    if (!captureRequired.includes(field)) {
      throw new TypeError(`Captured evidence schema must require capture.${field}`);
    }
  }
  if (capture.additionalProperties !== false) {
    throw new TypeError("Captured evidence capture schema must reject additional fields");
  }

  // This manifest schema uses the JSON Schema 2020-12 spelling `$defs`, but otherwise stays
  // within the draft-07 validation vocabulary supported by the repository's existing Ajv.
  // Point Ajv at its bundled meta-schema while retaining `$defs` for local reference resolution.
  const validationSchema = structuredClone(root);
  validationSchema.$schema = "http://json-schema.org/draft-07/schema#";
  try {
    return {
      root,
      validate: new Ajv({ allErrors: true, jsonPointers: true }).compile(validationSchema),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Captured evidence manifest schema is invalid: ${message}`, {
      cause: error,
    });
  }
}

export function validateCapturedManifestSchema(schema) {
  return compileCapturedManifestSchema(schema).root;
}

export function validateCapturedManifest(manifest, schema) {
  const { validate } = compileCapturedManifestSchema(schema);
  if (!validate(manifest)) {
    throw new TypeError(
      `Captured evidence manifest does not match its JSON Schema: ${JSON.stringify(validate.errors)}`,
    );
  }
  const root = assertRecord(manifest, "Captured evidence manifest");
  assertExactKeys(
    root,
    ["$schema", "version", "serverCommit", "headerRecordFormat", "captures"],
    "Manifest",
  );
  if (root.$schema !== "manifest.schema.json" || root.version !== 1) {
    throw new TypeError("Captured evidence manifest must use schema and version 1");
  }
  if (root.headerRecordFormat !== HEADER_RECORD_FORMAT) {
    throw new TypeError("Captured evidence manifest has an unknown header record format");
  }
  assertString(root.serverCommit, "Captured evidence manifest serverCommit", GIT_COMMIT_PATTERN);

  const captures = assertArray(root.captures, "Captured evidence captures");
  if (captures.length < 2)
    throw new TypeError("Captured evidence must include both resource types");
  const fixtureIds = new Set();
  const resourceTypes = new Set();

  for (const [index, value] of captures.entries()) {
    const location = `Captured evidence captures[${index}]`;
    const capture = assertRecord(value, location);
    assertExactKeys(
      capture,
      [
        "fixtureId",
        "bodyPath",
        "rawBodySha256",
        "signingResource",
        "webhookId",
        "webhookTimestamp",
        "signature",
        "headersSha256",
        "provenance",
        "expectedResult",
      ],
      location,
    );
    const fixtureId = assertString(capture.fixtureId, `${location}.fixtureId`, /^[a-z0-9-]+$/);
    if (fixtureIds.has(fixtureId)) throw new TypeError(`Duplicate fixtureId ${fixtureId}`);
    fixtureIds.add(fixtureId);
    if (capture.bodyPath !== `${EVIDENCE_PATH}/bodies/${fixtureId}.json`) {
      throw new TypeError(`${location}.bodyPath must be bound to its fixtureId`);
    }
    assertString(capture.rawBodySha256, `${location}.rawBodySha256`, SHA256_PATTERN);
    assertString(capture.webhookId, `${location}.webhookId`);
    assertString(capture.webhookTimestamp, `${location}.webhookTimestamp`, /^\d+$/);
    assertString(capture.signature, `${location}.signature`, SIGNATURE_PATTERN);
    assertString(capture.headersSha256, `${location}.headersSha256`, SHA256_PATTERN);
    if (capture.expectedResult !== "valid") {
      throw new TypeError(`${location}.expectedResult must be valid`);
    }

    const resource = assertRecord(capture.signingResource, `${location}.signingResource`);
    assertExactKeys(
      resource,
      ["type", "id", "idSha256", "keyPath", "keySha256", "bindingSha256"],
      `${location}.signingResource`,
    );
    if (resource.type !== "configured-webhook" && resource.type !== "route") {
      throw new TypeError(`${location}.signingResource.type is invalid`);
    }
    resourceTypes.add(resource.type);
    assertString(resource.id, `${location}.signingResource.id`, UUID_PATTERN);
    assertString(resource.idSha256, `${location}.signingResource.idSha256`, SHA256_PATTERN);
    assertString(resource.keySha256, `${location}.signingResource.keySha256`, SHA256_PATTERN);
    assertString(
      resource.bindingSha256,
      `${location}.signingResource.bindingSha256`,
      SHA256_PATTERN,
    );
    if (resource.keyPath !== `${EVIDENCE_PATH}/keys/${resource.type}.key`) {
      throw new TypeError(`${location}.signingResource.keyPath does not match its resource type`);
    }

    const provenance = assertRecord(capture.provenance, `${location}.provenance`);
    assertExactKeys(
      provenance,
      ["kind", "environment", "capturedAt", "source"],
      `${location}.provenance`,
    );
    if (provenance.kind !== "captured") throw new TypeError(`${location} is not captured evidence`);
    assertString(provenance.environment, `${location}.provenance.environment`);
    assertString(provenance.source, `${location}.provenance.source`);
    const capturedAt = assertString(provenance.capturedAt, `${location}.provenance.capturedAt`);
    if (Number.isNaN(Date.parse(capturedAt))) {
      throw new TypeError(`${location}.provenance.capturedAt must be an ISO date-time`);
    }
  }
  if (!resourceTypes.has("configured-webhook") || !resourceTypes.has("route")) {
    throw new TypeError("Captured evidence must include configured-webhook and route resources");
  }
  return captures;
}

export function validateSignedFixture(
  captureValue,
  rawBody,
  keyFileBytes,
  { captured, headerRecordFormat },
) {
  const capture = assertRecord(captureValue, "Webhook fixture");
  const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const keyBytes = keyBytesFromFile(
    keyFileBytes,
    capture.signingResource?.keyPath ?? capture.keyPath,
  );
  if (sha256Hex(bodyBytes) !== capture.rawBodySha256) {
    throw new TypeError(`${capture.fixtureId} raw body digest mismatch`);
  }
  if (sha256Hex(keyBytes) !== (capture.signingResource?.keySha256 ?? capture.keySha256)) {
    throw new TypeError(`${capture.fixtureId} signing key digest mismatch`);
  }
  const expectedSignature = hmacSignature(
    keyBytes,
    capture.webhookId,
    capture.webhookTimestamp,
    bodyBytes,
  );
  if (capture.signature !== expectedSignature) {
    throw new TypeError(`${capture.fixtureId} signature mismatch`);
  }
  const payload = assertRecord(
    parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes), capture.bodyPath),
    `${capture.fixtureId} body`,
  );

  // Captures are immutable transport evidence and may predate the currently pinned payload
  // schema. Current payload semantics are enforced on the separately generated synthetic fixture.
  if (!captured && payload.type !== "message.routing") {
    assertString(payload.webhook_id, `${capture.fixtureId} body.webhook_id`, UUID_PATTERN);
  }

  if (captured) {
    if (headerRecordFormat !== HEADER_RECORD_FORMAT) {
      throw new TypeError(`${capture.fixtureId} has an unknown header record format`);
    }
    const resource = assertRecord(capture.signingResource, `${capture.fixtureId}.signingResource`);
    const expectedResourceHash = sha256Hex(Buffer.from(`${resource.type}:${resource.id}`, "utf8"));
    if (resource.idSha256 !== expectedResourceHash) {
      throw new TypeError(`${capture.fixtureId} signing resource digest mismatch`);
    }
    const expectedBindingHash = sha256Hex(
      Buffer.from(`${resource.type}:${resource.id}:${resource.keySha256}`, "utf8"),
    );
    if (resource.bindingSha256 !== expectedBindingHash) {
      throw new TypeError(`${capture.fixtureId} resource/key binding mismatch`);
    }
    if (sha256Hex(headerRecord(capture, headerRecordFormat)) !== capture.headersSha256) {
      throw new TypeError(`${capture.fixtureId} signed header record digest mismatch`);
    }
    if (
      (resource.type === "route" &&
        (payload.type !== "message.routing" || payload.route_id !== resource.id)) ||
      (resource.type === "configured-webhook" &&
        (payload.type === "message.routing" ||
          (payload.webhook_id !== undefined && payload.webhook_id !== resource.id)))
    ) {
      throw new TypeError(`${capture.fixtureId} body does not match its signing resource`);
    }
  }
}

async function collectFiles(root, directory = root, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push({ path: relative(root, path).replaceAll("\\", "/"), bytes: await readFile(path) });
    }
  }
  return files;
}

export async function validateSecretScanAllowlist(policyValue, root) {
  const policy = assertRecord(policyValue, "Secret scan allowlist");
  assertExactKeys(policy, ["version", "rules"], "Secret scan allowlist");
  if (policy.version !== 1) throw new TypeError("Secret scan allowlist version must be 1");
  const rules = assertArray(policy.rules, "Secret scan allowlist rules");
  if (rules.length !== 3)
    throw new TypeError("Secret scan allowlist must classify three fixture keys");
  const files = await collectFiles(root);
  const ids = new Set();
  const allowedPaths = new Set();

  for (const [index, value] of rules.entries()) {
    const location = `Secret scan allowlist rules[${index}]`;
    const rule = assertRecord(value, location);
    assertExactKeys(
      rule,
      ["id", "classification", "detector", "secretSha256", "allowedPath", "expectedOccurrences"],
      location,
    );
    const id = assertString(rule.id, `${location}.id`);
    if (ids.has(id)) throw new TypeError(`Duplicate secret scan rule ${id}`);
    ids.add(id);
    assertString(rule.classification, `${location}.classification`);
    if (rule.detector !== "literal-sha256" || rule.expectedOccurrences !== 1) {
      throw new TypeError(`${location} must allow one literal secret occurrence`);
    }
    assertString(rule.secretSha256, `${location}.secretSha256`, SHA256_PATTERN);
    const allowedPath = assertString(rule.allowedPath, `${location}.allowedPath`);
    if (allowedPaths.has(allowedPath)) {
      throw new TypeError(`Duplicate secret scan allowed path ${allowedPath}`);
    }
    allowedPaths.add(allowedPath);
    if (rule.classification !== SECRET_CLASSIFICATIONS.get(allowedPath)) {
      throw new TypeError(`${id} has an invalid scanner classification for ${allowedPath}`);
    }
    const secretBytes = keyBytesFromFile(await readFile(resolve(root, allowedPath)), allowedPath);
    if (sha256Hex(secretBytes) !== rule.secretSha256) {
      throw new TypeError(`${id} allowlisted secret digest mismatch`);
    }
    const occurrences = [];
    for (const file of files) {
      let offset = 0;
      while ((offset = file.bytes.indexOf(secretBytes, offset)) !== -1) {
        occurrences.push(file.path);
        offset += secretBytes.length;
      }
    }
    if (occurrences.length !== 1 || occurrences[0] !== allowedPath) {
      throw new TypeError(
        `${id} secret scan classification violation: expected only ${allowedPath}, received ${JSON.stringify(occurrences)}`,
      );
    }
  }
  const expectedPaths = [...SECRET_CLASSIFICATIONS.keys()].sort();
  const actualPaths = [...allowedPaths].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new TypeError(
      `Secret scan allowlist paths must be ${JSON.stringify(expectedPaths)}; received ${JSON.stringify(actualPaths)}`,
    );
  }
  return rules;
}

export async function validateWebhookEvidence(root, { checkDigest = true } = {}) {
  const manifestPath = resolve(root, EVIDENCE_PATH, "manifest.json");
  const schemaPath = resolve(root, EVIDENCE_PATH, "manifest.schema.json");
  const digestPath = resolve(root, EVIDENCE_PATH, "manifest.sha256");
  const syntheticManifestPath = resolve(root, SYNTHETIC_PATH, "manifest.json");
  const policyPath = resolve(root, "security/secret-scan-allowlist.json");
  const [manifestSource, schemaSource, detachedDigest, syntheticSource, policySource] =
    await Promise.all([
      readFile(manifestPath, "utf8"),
      readFile(schemaPath, "utf8"),
      readFile(digestPath, "utf8"),
      readFile(syntheticManifestPath, "utf8"),
      readFile(policyPath, "utf8"),
    ]);
  const manifest = parseJson(manifestSource, `${EVIDENCE_PATH}/manifest.json`);
  const schema = parseJson(schemaSource, `${EVIDENCE_PATH}/manifest.schema.json`);
  const syntheticManifest = assertRecord(
    parseJson(syntheticSource, `${SYNTHETIC_PATH}/manifest.json`),
    "Synthetic fixture manifest",
  );
  const policy = parseJson(policySource, "security/secret-scan-allowlist.json");
  const captures = validateCapturedManifest(manifest, schema);
  const manifestDigest = digestJsonArtifact(manifest);
  if (checkDigest && detachedDigest !== `${manifestDigest}\n`) {
    throw new TypeError("Captured evidence detached manifest digest mismatch");
  }
  for (const capture of captures) {
    const resource = assertRecord(capture.signingResource, `${capture.fixtureId}.signingResource`);
    const [body, key] = await Promise.all([
      readFile(resolve(root, capture.bodyPath)),
      readFile(resolve(root, resource.keyPath)),
    ]);
    validateSignedFixture(capture, body, key, {
      captured: true,
      headerRecordFormat: manifest.headerRecordFormat,
    });
  }

  assertExactKeys(syntheticManifest, ["version", "fixtures"], "Synthetic fixture manifest");
  if (syntheticManifest.version !== 1) throw new TypeError("Synthetic fixture version must be 1");
  const syntheticFixtures = assertArray(syntheticManifest.fixtures, "Synthetic fixtures");
  if (syntheticFixtures.length === 0) throw new TypeError("Synthetic fixture manifest is empty");
  const syntheticRoot = await realpath(resolve(root, SYNTHETIC_PATH));
  for (const value of syntheticFixtures) {
    const fixture = assertRecord(value, "Synthetic fixture");
    const [bodyPath, keyPath] = await Promise.all([
      resolveSyntheticFixturePath(root, syntheticRoot, fixture.bodyPath, fixture.fixtureId),
      resolveSyntheticFixturePath(root, syntheticRoot, fixture.keyPath, fixture.fixtureId),
    ]);
    const [body, key] = await Promise.all([readFile(bodyPath), readFile(keyPath)]);
    validateSignedFixture(fixture, body, key, { captured: false });
  }
  await validateSecretScanAllowlist(policy, root);

  return {
    manifestDigest,
    schemaDigest: digestJsonArtifact(schema),
    syntheticDigest: digestJsonArtifact(syntheticManifest),
    policyDigest: digestJsonArtifact(policy),
    captureCount: captures.length,
    syntheticCount: syntheticFixtures.length,
  };
}

export function parseOpenApi(source) {
  let document;
  try {
    document = yaml.load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid OpenAPI YAML: ${message}`, { cause: error });
  }

  const root = assertRecord(document, "OpenAPI document");
  if (root.openapi !== "3.1.0") {
    throw new TypeError(`Expected OpenAPI 3.1.0, received ${JSON.stringify(root.openapi)}`);
  }
  assertRecord(root.paths, "OpenAPI paths");
  assertRecord(assertRecord(root.components, "OpenAPI components").schemas, "OpenAPI schemas");
  return root;
}

export function parseWebhookContract(source) {
  let document;
  try {
    document = yaml.load(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid webhook YAML: ${message}`, { cause: error });
  }

  const root = assertRecord(document, "Webhook document");
  if (root.openapi !== "3.1.0") {
    throw new TypeError(`Expected webhook OpenAPI 3.1.0, received ${JSON.stringify(root.openapi)}`);
  }
  const info = assertRecord(root.info, "Webhook info");
  if (typeof info.version !== "string" || info.version.length === 0) {
    throw new TypeError("Webhook info.version must be a non-empty string");
  }
  assertRecord(root.webhooks, "Webhook definitions");
  assertRecord(assertRecord(root.components, "Webhook components").schemas, "Webhook schemas");
  return root;
}

export function validateWebhookContract(document) {
  const root = assertRecord(document, "Webhook document");
  const webhooks = assertRecord(root.webhooks, "Webhook definitions");
  if (!Object.hasOwn(webhooks, "message.routing") || Object.hasOwn(webhooks, "route.message")) {
    throw new TypeError(
      "Webhook definitions must use canonical message.routing and must not define route.message",
    );
  }

  const schemas = assertRecord(
    assertRecord(root.components, "Webhook components").schemas,
    "Webhook schemas",
  );
  const routePayload = assertRecord(schemas.RouteWebhookPayload, "RouteWebhookPayload");
  const routeProperties = assertRecord(routePayload.properties, "RouteWebhookPayload.properties");
  const routeType = assertRecord(routeProperties.type, "RouteWebhookPayload.properties.type");
  if (JSON.stringify(routeType.enum) !== JSON.stringify(["message.routing", "route.message"])) {
    throw new TypeError(
      "RouteWebhookPayload.type must accept canonical message.routing and deprecated route.message",
    );
  }
  if (JSON.stringify(routeType["x-deprecated-values"]) !== JSON.stringify(["route.message"])) {
    throw new TypeError("RouteWebhookPayload.type must mark route.message as deprecated input");
  }

  for (const schemaName of ["MessageWebhookData", "MessageClickedWebhookData"]) {
    const eventData = assertRecord(schemas[schemaName], schemaName);
    const properties = assertRecord(eventData.properties, `${schemaName}.properties`);
    const isBot = assertRecord(properties.is_bot, `${schemaName}.properties.is_bot`);
    if (isBot.type !== "boolean") {
      throw new TypeError(`${schemaName}.is_bot must be a boolean`);
    }
    if (Array.isArray(eventData.required) && eventData.required.includes("is_bot")) {
      throw new TypeError(`${schemaName}.is_bot must be optional`);
    }
  }

  const description = assertRecord(root.info, "Webhook info").description;
  if (
    typeof description !== "string" ||
    !description.includes("literal UTF-8 bytes") ||
    !description.includes("Do not Base64-decode") ||
    !description.includes("compatibility with stock libraries is not unconditional")
  ) {
    throw new TypeError(
      "Webhook documentation must preserve the literal UTF-8 secret and Standard Webhooks compatibility boundary",
    );
  }
}

export function collectOperations(document) {
  const root = assertRecord(document, "OpenAPI document");
  const paths = assertRecord(root.paths, "OpenAPI paths");
  const operations = [];

  for (const [path, pathItemValue] of Object.entries(paths)) {
    const pathItem = assertRecord(pathItemValue, `Path item ${path}`);
    for (const method of HTTP_METHODS) {
      if (pathItem[method] === undefined) continue;
      const operation = assertRecord(pathItem[method], `${method.toUpperCase()} ${path}`);
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0) {
        throw new TypeError(`${method.toUpperCase()} ${path} has no operationId`);
      }
      operations.push({ method, path, operationId: operation.operationId, operation });
    }
  }

  return operations;
}

export function collectContractInventory(document) {
  const operations = collectOperations(document);
  const operationIds = operations.map(({ operationId }) => operationId);
  const duplicateOperationIds = operationIds.filter(
    (operationId, index) => operationIds.indexOf(operationId) !== index,
  );
  if (duplicateOperationIds.length > 0) {
    throw new TypeError(
      `Duplicate operationId values: ${[...new Set(duplicateOperationIds)].join(", ")}`,
    );
  }

  const components = assertRecord(
    assertRecord(document, "OpenAPI document").components,
    "components",
  );
  const schemaNames = Object.keys(assertRecord(components.schemas, "components.schemas"));

  return {
    operationIds,
    schemaNames,
    idempotencyOperationIds: operations
      .filter(({ operation }) =>
        Array.isArray(operation.parameters)
          ? operation.parameters.some(
              (parameter) =>
                parameter !== null &&
                typeof parameter === "object" &&
                parameter.$ref === "#/components/parameters/IdempotencyKey",
            )
          : false,
      )
      .map(({ operationId }) => operationId),
    subAccountOperationIds: operations
      .filter(({ path }) => path.includes("/sub-accounts"))
      .map(({ operationId }) => operationId),
    subAccountSchemaNames: schemaNames.filter((name) => name.toLowerCase().includes("subaccount")),
    roleAlternativeOperationIds: operations
      .filter(({ operation }) => Array.isArray(operation.security) && operation.security.length > 1)
      .map(({ operationId }) => operationId),
  };
}

function decodePointerToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveInternalReference(document, reference) {
  if (!reference.startsWith("#/")) {
    throw new TypeError(`Only internal OpenAPI references are supported: ${reference}`);
  }

  let current = document;
  for (const token of reference.slice(2).split("/").map(decodePointerToken)) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current) ||
      !Object.hasOwn(current, token)
    ) {
      throw new TypeError(`Unresolved OpenAPI reference: ${reference}`);
    }
    current = current[token];
  }
  return current;
}

export function validateInternalReferences(document) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;

    if (Object.hasOwn(value, "$ref")) {
      if (typeof value.$ref !== "string")
        throw new TypeError("OpenAPI $ref values must be strings");
      resolveInternalReference(document, value.$ref);
    }
    for (const nested of Object.values(value)) visit(nested);
  };

  visit(document);
}

export function assertInventoryMatches(actual, expected) {
  const actualInventory = assertRecord(actual, "Actual contract inventory");
  const expectedInventory = assertRecord(expected, "Locked contract inventory");

  for (const key of INVENTORY_KEYS) {
    const actualValue = actualInventory[key];
    const expectedValue = expectedInventory[key];
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new TypeError(
        `Contract inventory drift for ${key}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

function normalizeLanguage(value) {
  return typeof value === "string" ? value.toLowerCase().replaceAll(/[^a-z.]/g, "") : "";
}

function propertyPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const parent = propertyPath(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.name.text}`;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    const parent = propertyPath(node.expression);
    return parent === undefined ? undefined : `${parent}.${node.argumentExpression.text}`;
  }
  return undefined;
}

function sourceFileForSample(operationId, source) {
  const sourceFile = ts.createSourceFile(
    `${operationId}.mjs`,
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostics = sourceFile.parseDiagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
    throw new TypeError(
      `${operationId} sample is not valid ESM JavaScript: ${diagnostics.join("; ")}`,
    );
  }
  return sourceFile;
}

function collectNodes(sourceFile, predicate) {
  const nodes = [];
  function visit(node) {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return nodes;
}

function statementTerminates(statement) {
  if (ts.isThrowStatement(statement) || ts.isReturnStatement(statement)) return true;
  if (ts.isBlock(statement)) {
    const last = statement.statements.at(-1);
    return last !== undefined && statementTerminates(last);
  }
  return false;
}

function isMutationGuard(statement) {
  if (!ts.isIfStatement(statement) || !statementTerminates(statement.thenStatement)) return false;
  const condition = statement.expression;
  if (
    !ts.isBinaryExpression(condition) ||
    (condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      condition.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    return false;
  }
  return (
    (propertyPath(condition.left) === "process.env.AHASEND_ALLOW_MUTATIONS" &&
      ts.isStringLiteral(condition.right) &&
      condition.right.text === "1") ||
    (propertyPath(condition.right) === "process.env.AHASEND_ALLOW_MUTATIONS" &&
      ts.isStringLiteral(condition.left) &&
      condition.left.text === "1")
  );
}

function objectProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteral(property.name) && property.name.text === name)),
  );
}

function argumentProperty(call, argumentIndex, name) {
  const argument = call.arguments.at(argumentIndex);
  const property = argument === undefined ? undefined : objectProperty(argument, name);
  return property !== undefined && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined;
}

function requestBodyArgumentIndex(contractOperation) {
  return [...contractOperation.path.matchAll(/\{([^}]+)\}/gu)].filter(
    (match) => match[1] !== "account_id",
  ).length;
}

function requestOptionsArgumentIndex(contractOperation) {
  return (
    requestBodyArgumentIndex(contractOperation) +
    (contractOperation.operation.requestBody === undefined ? 0 : 1)
  );
}

function validatePublicImport(operationId, sourceFile) {
  const dynamicImports = collectNodes(
    sourceFile,
    (node) => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword,
  );
  if (dynamicImports.length > 0) {
    throw new TypeError(`${operationId} sample must not use dynamic imports`);
  }

  const imports = sourceFile.statements.filter(ts.isImportDeclaration);
  if (imports.length !== 1) {
    throw new TypeError(`${operationId} sample must have exactly one public SDK import`);
  }
  const declaration = imports[0];
  if (
    !ts.isStringLiteral(declaration.moduleSpecifier) ||
    declaration.moduleSpecifier.text !== "@ahasend/sdk"
  ) {
    throw new TypeError(`${operationId} sample imports a non-public SDK module`);
  }
  const bindings = declaration.importClause?.namedBindings;
  const binding =
    bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements[0] : undefined;
  if (
    bindings === undefined ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 1 ||
    binding === undefined ||
    (binding.propertyName?.text ?? binding.name.text) !== "AhaSendClient" ||
    binding.name.text !== "AhaSendClient"
  ) {
    throw new TypeError(`${operationId} sample must import only AhaSendClient from @ahasend/sdk`);
  }
}

function containsFetchReference(sourceFile) {
  return (
    collectNodes(
      sourceFile,
      (node) =>
        (ts.isIdentifier(node) && node.text === "fetch") ||
        (ts.isElementAccessExpression(node) &&
          node.argumentExpression !== undefined &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "fetch"),
    ).length > 0
  );
}

function validateSelfContained(operationId, sourceFile) {
  const declared = new Set(["console", "Error", "fetch", "globalThis", "process", "URL"]);
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
        declared.add(binding.name.text);
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declared.add(declaration.name.text);
      }
    }
  }

  const references = collectNodes(sourceFile, (node) => {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent)
    ) {
      return false;
    }
    return true;
  });
  const unbound = [...new Set(references.map(({ text }) => text))].filter(
    (identifier) => !declared.has(identifier),
  );
  if (unbound.length > 0) {
    throw new TypeError(
      `${operationId} sample is not self-contained; undeclared values: ${unbound.join(", ")}`,
    );
  }
}

function validateSafeOutput(operationId, sourceFile) {
  const consoleCalls = collectNodes(
    sourceFile,
    (node) =>
      ts.isCallExpression(node) &&
      /^(?:console|log|logger)\.(?:log|debug|info|warn|error)$/u.test(
        propertyPath(node.expression) ?? "",
      ),
  );
  if (consoleCalls.length === 0) {
    throw new TypeError(`${operationId} sample must log safe response metadata`);
  }
  for (const call of consoleCalls) {
    const [message, ...metadata] = call.arguments;
    if (
      message === undefined ||
      (!ts.isStringLiteral(message) && !ts.isNoSubstitutionTemplateLiteral(message)) ||
      metadata.length === 0 ||
      metadata.some(
        (argument) =>
          !ts.isObjectLiteralExpression(argument) ||
          argument.properties.some(
            (property) =>
              !ts.isPropertyAssignment(property) ||
              propertyPath(property.initializer)?.includes(".") !== true,
          ),
      )
    ) {
      throw new TypeError(`${operationId} sample must log metadata instead of response bodies`);
    }
    const sensitive = collectNodes(call, (node) => {
      const path = propertyPath(node) ?? "";
      return /(?:^|\.)(?:secret|secret_key|password|idempotencyKey)$/u.test(path);
    });
    if (sensitive.length > 0) {
      throw new TypeError(`${operationId} sample prints a credential or one-time secret`);
    }
  }
}

function sampleLiteralValue(operationId, node, location) {
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new TypeError(`${operationId} sample ${location} must use literal values`);
      }
      const name =
        ts.isIdentifier(property.name) ||
        ts.isStringLiteral(property.name) ||
        ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;
      if (name === undefined) {
        throw new TypeError(`${operationId} sample ${location} must use literal property names`);
      }
      value[name] = sampleLiteralValue(operationId, property.initializer, `${location}.${name}`);
    }
    return value;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element, index) =>
      sampleLiteralValue(operationId, element, `${location}[${index}]`),
    );
  }
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand) &&
    (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken)
  ) {
    const value = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  throw new TypeError(`${operationId} sample ${location} must use literal values`);
}

function validateRequestBody(operationId, facadeCall, contractOperation, components) {
  const requestBody = contractOperation.operation.requestBody;
  if (requestBody === undefined) return;

  const body = facadeCall.arguments.at(requestBodyArgumentIndex(contractOperation));
  if (body === undefined) {
    throw new TypeError(`${operationId} sample must pass the operation request body`);
  }
  const content = assertRecord(assertRecord(requestBody, `${operationId} request body`).content);
  const mediaType = assertRecord(content["application/json"], `${operationId} JSON request body`);
  const requestSchema = assertRecord(mediaType.schema, `${operationId} request body schema`);
  const validate = new Ajv({
    allErrors: true,
    jsonPointers: true,
    logger: false,
    nullable: true,
    unknownFormats: "ignore",
  }).compile({ ...requestSchema, components });
  const value = sampleLiteralValue(operationId, body, "request body");
  if (!validate(value)) {
    const details = (validate.errors ?? [])
      .map(({ dataPath, message }) => `${dataPath || "/"} ${message ?? "is invalid"}`)
      .join("; ");
    throw new TypeError(`${operationId} sample request body does not match its schema: ${details}`);
  }
}

function operationHasIdempotency(operation) {
  return (
    Array.isArray(operation.parameters) &&
    operation.parameters.some(
      (parameter) =>
        parameter !== null &&
        typeof parameter === "object" &&
        parameter.$ref === IDEMPOTENCY_PARAMETER,
    )
  );
}

function validateRegistrySample(entry, contractOperation, components) {
  const { operationId, facade, sample } = entry;
  const sourceFile = sourceFileForSample(operationId, sample.source);
  validatePublicImport(operationId, sourceFile);
  validateSelfContained(operationId, sourceFile);

  if (
    containsFetchReference(sourceFile) ||
    /\bnew\s+URL\s*\(|api\.ahasend\.com|\bAuthorization\b|\bBearer\b/iu.test(sample.source)
  ) {
    throw new TypeError(`${operationId} sample must not construct raw API requests`);
  }

  const clientDeclarations = collectNodes(
    sourceFile,
    (node) =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "client",
  );
  const clientDeclaration = clientDeclarations[0];
  const clientInitializer = clientDeclaration?.initializer;
  if (
    clientDeclarations.length !== 1 ||
    clientDeclaration === undefined ||
    !ts.isVariableDeclarationList(clientDeclaration.parent) ||
    (clientDeclaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    clientInitializer === undefined ||
    !ts.isCallExpression(clientInitializer) ||
    propertyPath(clientInitializer.expression) !== "AhaSendClient.fromEnv" ||
    clientInitializer.arguments.length !== 0
  ) {
    throw new TypeError(`${operationId} sample must assign client from AhaSendClient.fromEnv()`);
  }
  const calls = collectNodes(sourceFile, ts.isCallExpression);
  const clientCalls = calls.filter((call) =>
    (propertyPath(call.expression) ?? "").startsWith("client."),
  );
  if (clientCalls.length !== 1 || propertyPath(clientCalls[0].expression) !== facade) {
    const received = clientCalls.map((call) => propertyPath(call.expression)).join(", ") || "none";
    throw new TypeError(
      `${operationId} sample calls the wrong facade: expected ${facade}, received ${received}`,
    );
  }

  const facadeCall = clientCalls[0];
  if (SANDBOX_OPERATION_IDS.has(operationId)) {
    const sandbox = argumentProperty(facadeCall, 0, "sandbox");
    if (sandbox?.kind !== ts.SyntaxKind.TrueKeyword) {
      throw new TypeError(`${operationId} sample must send with sandbox: true`);
    }
  }
  if (contractOperation.method !== "get") {
    const guarded = sourceFile.statements.some(
      (statement) =>
        statement.getStart(sourceFile) < facadeCall.getStart(sourceFile) &&
        isMutationGuard(statement),
    );
    if (!guarded) {
      throw new TypeError(`${operationId} sample must guard the mutation before calling the SDK`);
    }
  }

  if (operationHasIdempotency(contractOperation.operation)) {
    const key = argumentProperty(
      facadeCall,
      requestOptionsArgumentIndex(contractOperation),
      "idempotencyKey",
    );
    if (key === undefined || !ts.isStringLiteral(key) || key.text.length < 8) {
      throw new TypeError(`${operationId} sample must use a stable caller idempotency key`);
    }
  }

  validateRequestBody(operationId, facadeCall, contractOperation, components);
  validateSafeOutput(operationId, sourceFile);
}

export function validateNodeSampleRegistry(document, registry = NODE_SAMPLE_REGISTRY) {
  if (!Array.isArray(registry)) throw new TypeError("Node sample registry must be an array");
  const components = assertRecord(
    assertRecord(document, "OpenAPI document").components,
    "OpenAPI components",
  );
  const operations = collectOperations(document);
  const operationsById = new Map(operations.map((operation) => [operation.operationId, operation]));
  const entriesById = new Map();

  for (const [index, value] of registry.entries()) {
    const entry = assertRecord(value, `Node sample registry[${index}]`);
    assertExactKeys(
      entry,
      ["operationId", "operationKey", "facade", "sample"],
      `Node sample registry[${index}]`,
    );
    const operationId = assertString(
      entry.operationId,
      `Node sample registry[${index}].operationId`,
    );
    assertString(entry.operationKey, `Node sample registry[${index}].operationKey`);
    assertString(
      entry.facade,
      `Node sample registry[${index}].facade`,
      /^client(?:\.[A-Za-z_$][\w$]*)+$/u,
    );
    const sample = assertRecord(entry.sample, `Node sample registry[${index}].sample`);
    assertExactKeys(sample, ["lang", "label", "source"], `Node sample registry[${index}].sample`);
    if (sample.lang !== "javascript") {
      throw new TypeError(`${operationId} registry sample must use the javascript language tag`);
    }
    assertString(sample.label, `${operationId} sample label`);
    assertString(sample.source, `${operationId} sample source`);
    if (entriesById.has(operationId)) {
      throw new TypeError(`Duplicate Node sample registry mappings: ${operationId}`);
    }
    entriesById.set(operationId, entry);
  }

  const missing = operations.filter(({ operationId }) => !entriesById.has(operationId));
  const orphaned = [...entriesById.keys()].filter(
    (operationId) => !operationsById.has(operationId),
  );
  if (missing.length > 0) {
    throw new TypeError(
      `Missing Node sample registry mappings: ${missing.map(({ operationId }) => operationId).join(", ")}`,
    );
  }
  if (orphaned.length > 0) {
    throw new TypeError(`Orphan Node sample registry mappings: ${orphaned.join(", ")}`);
  }

  for (const operation of operations) {
    const registryEntry = entriesById.get(operation.operationId);
    const actualKey = `${operation.method.toUpperCase()} ${operation.path}`;
    if (registryEntry.operationKey !== actualKey) {
      throw new TypeError(
        `Node sample operation drift for ${operation.operationId}: expected ${JSON.stringify(registryEntry.operationKey)}, received ${JSON.stringify(actualKey)}`,
      );
    }
    if (registryEntry.facade !== PUBLIC_OPERATION_FACADES[operation.operationId]) {
      throw new TypeError(
        `Wrong facade mapping for ${operation.operationId}: expected ${PUBLIC_OPERATION_FACADES[operation.operationId]}, received ${registryEntry.facade}`,
      );
    }
    validateRegistrySample(registryEntry, operation, components);
  }

  return entriesById;
}

export function validateCodeSamples(
  document,
  nodeSamples = NODE_CODE_SAMPLES,
  { allowMissingNodeSamples = false, allowNodeSampleDrift = false } = {},
) {
  const operations = collectOperations(document);
  validateNodeSampleRegistry(document);
  const operationIds = new Set(operations.map(({ operationId }) => operationId));
  const sampleOperationIds = Object.keys(assertRecord(nodeSamples, "Node code samples"));
  const missingDefinitions = [...operationIds].filter(
    (operationId) => !Object.hasOwn(nodeSamples, operationId),
  );
  const orphanDefinitions = sampleOperationIds.filter(
    (operationId) => !operationIds.has(operationId),
  );

  if (missingDefinitions.length > 0) {
    throw new TypeError(`Missing Node sample definitions: ${missingDefinitions.join(", ")}`);
  }
  if (orphanDefinitions.length > 0) {
    throw new TypeError(`Orphan Node sample definitions: ${orphanDefinitions.join(", ")}`);
  }

  for (const { method, path, operationId } of operations) {
    const actualKey = `${method.toUpperCase()} ${path}`;
    if (NODE_OPERATION_KEYS[operationId] !== actualKey) {
      throw new TypeError(
        `Node sample operation drift for ${operationId}: expected ${JSON.stringify(NODE_OPERATION_KEYS[operationId])}, received ${JSON.stringify(actualKey)}`,
      );
    }
  }

  let shellSampleCount = 0;
  for (const { operationId, operation } of operations) {
    if (!Array.isArray(operation["x-code-samples"])) {
      throw new TypeError(`${operationId} has no x-code-samples array`);
    }
    const samples = operation["x-code-samples"];
    const goSamples = samples.filter((sample) => normalizeLanguage(sample?.lang) === "go");
    const nodeCodeSamples = samples.filter((sample) =>
      NODE_LANGUAGES.has(normalizeLanguage(sample?.lang)),
    );
    shellSampleCount += samples.filter(
      (sample) => normalizeLanguage(sample?.lang) === "shell",
    ).length;

    if (goSamples.length !== 1) {
      throw new TypeError(
        `${operationId} must have exactly one Go sample; received ${goSamples.length}`,
      );
    }
    if (nodeCodeSamples.length > 1 || (!allowMissingNodeSamples && nodeCodeSamples.length !== 1)) {
      throw new TypeError(
        `${operationId} must have exactly one Node sample; received ${nodeCodeSamples.length}`,
      );
    }
    if (nodeCodeSamples.length === 1 && !allowNodeSampleDrift) {
      const expected = nodeSamples[operationId];
      const actual = nodeCodeSamples[0];
      if (
        actual.lang !== expected.lang ||
        actual.label !== expected.label ||
        actual.source !== expected.source
      ) {
        throw new TypeError(`Generated Node sample drift for ${operationId}`);
      }
    }
  }

  if (shellSampleCount !== 1) {
    throw new TypeError(
      `The contract must retain exactly one shell bootstrap sample; received ${shellSampleCount}`,
    );
  }
}

function yamlSampleLines(sample) {
  const sourceLines = sample.source.split("\n");
  return [
    `        - lang: ${sample.lang}`,
    `          label: ${sample.label}`,
    "          source: |",
    ...sourceLines.map((line) => (line === "" ? "" : `            ${line}`)),
  ];
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function locateSampleBlock(lines, operationId) {
  const operationLine = lines.findIndex(
    (line) => line.match(/^ {6}operationId:\s*(.+?)\s*$/)?.[1] === operationId,
  );
  if (operationLine < 0)
    throw new TypeError(`Cannot locate operationId ${operationId} in YAML source`);

  let operationEnd = lines.length;
  for (let index = operationLine + 1; index < lines.length; index += 1) {
    if (
      /^ {4}(?:get|put|post|delete|options|head|patch|trace):\s*$/.test(lines[index]) ||
      /^ {2}\//.test(lines[index])
    ) {
      operationEnd = index;
      break;
    }
  }

  const samplesLine = lines.findIndex(
    (line, index) =>
      index > operationLine && index < operationEnd && /^ {6}x-code-samples:\s*$/.test(line),
  );
  if (samplesLine < 0) throw new TypeError(`${operationId} has no source x-code-samples block`);

  let samplesEnd = operationEnd;
  for (let index = samplesLine + 1; index < operationEnd; index += 1) {
    const line = lines[index];
    if (line.trim() !== "" && line.match(/^ */)[0].length <= 6) {
      samplesEnd = index;
      break;
    }
  }
  return { samplesLine, samplesEnd };
}

export function injectNodeSamples(source, document, nodeSamples = NODE_CODE_SAMPLES) {
  validateCodeSamples(document, nodeSamples, {
    allowMissingNodeSamples: true,
    allowNodeSampleDrift: true,
  });
  const lines = source.split("\n");
  const operationIds = collectOperations(document)
    .map(({ operationId }) => operationId)
    .reverse();

  for (const operationId of operationIds) {
    const { samplesLine, samplesEnd } = locateSampleBlock(lines, operationId);
    const itemStarts = [];
    for (let index = samplesLine + 1; index < samplesEnd; index += 1) {
      const match = lines[index].match(/^ {8}- lang:\s*(.+?)\s*$/);
      if (match !== null)
        itemStarts.push({ index, language: normalizeLanguage(unquoteYamlScalar(match[1])) });
    }
    const nodeItems = itemStarts.filter(({ language }) => NODE_LANGUAGES.has(language));
    if (nodeItems.length > 1) {
      throw new TypeError(`${operationId} has duplicate Node samples`);
    }

    const replacement = yamlSampleLines(nodeSamples[operationId]);
    if (nodeItems.length === 0) {
      lines.splice(samplesEnd, 0, ...replacement);
      continue;
    }

    const start = nodeItems[0].index;
    const nextItem = itemStarts.find(({ index }) => index > start);
    const end = nextItem?.index ?? samplesEnd;
    lines.splice(start, end - start, ...replacement);
  }

  return lines.join("\n");
}

function lockWithHashes(lock, openApiBytes, webhookBytes, evidence) {
  return {
    ...lock,
    artifactHashes: {
      ...assertRecord(lock.artifactHashes, "contracts.lock.json artifactHashes"),
      "openapi.yaml": digestYamlArtifact(openApiBytes),
      "webhooks.yaml": digestYamlArtifact(webhookBytes),
      [`${EVIDENCE_PATH}/manifest.json`]: evidence.manifestDigest,
      [`${EVIDENCE_PATH}/manifest.schema.json`]: evidence.schemaDigest,
      [TYPESCRIPT_RESULTS_PATH]: evidence.typescriptResultsDigest,
      [TYPESCRIPT_RESULTS_SIDECAR_PATH]: evidence.typescriptResultsSidecarDigest,
      [`${SYNTHETIC_PATH}/manifest.json`]: evidence.syntheticDigest,
      "security/secret-scan-allowlist.json": evidence.policyDigest,
    },
  };
}

async function buildAndRunWebhookFixtures(root) {
  await execFileAsync(process.execPath, [resolve(root, "scripts/build.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      AHASEND_EXPECT_BUILD_ROOT: root,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve(root, "scripts/run-webhook-fixture-results.mjs")],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const resultsBytes = Buffer.from(stdout);
  const results = assertRecord(
    parseJson(resultsBytes.toString("utf8"), TYPESCRIPT_RESULTS_PATH),
    "TypeScript webhook results",
  );
  const captures = assertArray(results.results, "TypeScript webhook result rows");
  const manifest = assertRecord(
    parseJson(
      await readFile(resolve(root, EVIDENCE_PATH, "manifest.json"), "utf8"),
      `${EVIDENCE_PATH}/manifest.json`,
    ),
    "Captured evidence manifest",
  );
  const expectedCaptures = assertArray(manifest.captures, "Captured evidence captures");
  if (captures.length !== expectedCaptures.length) {
    throw new TypeError("TypeScript webhook result count does not match captured evidence");
  }
  for (const [index, capture] of expectedCaptures.entries()) {
    const row = assertRecord(captures[index], `TypeScript webhook results[${index}]`);
    if (row.fixture !== capture.fixtureId || row.result !== capture.expectedResult) {
      throw new TypeError(
        `${capture.fixtureId} public verifier result ${JSON.stringify(row.result)} does not match ${JSON.stringify(capture.expectedResult)}`,
      );
    }
  }
  const resultsDigest = sha256Hex(resultsBytes);
  const sidecarBytes = Buffer.from(`${resultsDigest}\n`, "utf8");
  return {
    resultsBytes,
    sidecarBytes,
    resultsDigest,
    sidecarDigest: sha256Hex(sidecarBytes),
  };
}

function assertLockedHash(lock, path, actualHash) {
  const expectedHash = assertRecord(lock.artifactHashes, "artifactHashes")[path];
  if (actualHash !== expectedHash) {
    throw new TypeError(
      `${path} artifact hash drift: expected ${JSON.stringify(expectedHash)}, received ${actualHash}`,
    );
  }
}

async function run({ check }) {
  const root = process.cwd();
  const openApiPath = resolve(root, "openapi.yaml");
  const webhookPath = resolve(root, "webhooks.yaml");
  const lockPath = resolve(root, "contracts.lock.json");
  const [source, webhookSource, lockSource] = await Promise.all([
    readFile(openApiPath, "utf8"),
    readFile(webhookPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const lock = assertRecord(JSON.parse(lockSource), "contracts.lock.json");
  const document = parseOpenApi(source);
  const webhookDocument = parseWebhookContract(webhookSource);
  validateInternalReferences(document);
  validateInternalReferences(webhookDocument);
  validateWebhookContract(webhookDocument);
  const inventory = collectContractInventory(document);
  assertInventoryMatches(inventory, lock.inventories);
  const evidence = await validateWebhookEvidence(root, { checkDigest: check });
  const observed = await buildAndRunWebhookFixtures(root);
  evidence.typescriptResultsDigest = observed.resultsDigest;
  evidence.typescriptResultsSidecarDigest = observed.sidecarDigest;

  if (check) {
    validateCodeSamples(document);
    const actualHash = digestYamlArtifact(Buffer.from(source, "utf8"));
    assertLockedHash(lock, "openapi.yaml", actualHash);
    const actualWebhookHash = digestYamlArtifact(Buffer.from(webhookSource, "utf8"));
    assertLockedHash(lock, "webhooks.yaml", actualWebhookHash);
    assertLockedHash(lock, `${EVIDENCE_PATH}/manifest.json`, evidence.manifestDigest);
    assertLockedHash(lock, `${EVIDENCE_PATH}/manifest.schema.json`, evidence.schemaDigest);
    assertLockedHash(lock, TYPESCRIPT_RESULTS_PATH, observed.resultsDigest);
    assertLockedHash(lock, TYPESCRIPT_RESULTS_SIDECAR_PATH, observed.sidecarDigest);
    assertLockedHash(lock, `${SYNTHETIC_PATH}/manifest.json`, evidence.syntheticDigest);
    assertLockedHash(lock, "security/secret-scan-allowlist.json", evidence.policyDigest);
    const [committedResults, committedSidecar] = await Promise.all([
      readFile(resolve(root, TYPESCRIPT_RESULTS_PATH)),
      readFile(resolve(root, TYPESCRIPT_RESULTS_SIDECAR_PATH)),
    ]);
    if (!committedResults.equals(observed.resultsBytes)) {
      throw new TypeError("Built public verifier results drift from the committed artifact");
    }
    if (!committedSidecar.equals(observed.sidecarBytes)) {
      throw new TypeError("Built public verifier result sidecar drift from the committed artifact");
    }
    const normalized = injectNodeSamples(source, document);
    if (normalized !== source)
      throw new TypeError("openapi.yaml generated samples are not normalized");
    process.stdout.write(
      `Contracts OK: ${inventory.operationIds.length} REST operations, ${inventory.schemaNames.length} REST schemas, ${Object.keys(webhookDocument.webhooks).length} webhook definitions, ${evidence.captureCount} captured webhook fixtures, ${evidence.syntheticCount} synthetic webhook fixtures\n`,
    );
    return;
  }

  const generatedSource = injectNodeSamples(source, document);
  const generatedDocument = parseOpenApi(generatedSource);
  validateInternalReferences(generatedDocument);
  assertInventoryMatches(collectContractInventory(generatedDocument), lock.inventories);
  validateCodeSamples(generatedDocument);

  const generatedBytes = Buffer.from(generatedSource, "utf8");
  const updatedLock = lockWithHashes(
    lock,
    generatedBytes,
    Buffer.from(webhookSource, "utf8"),
    evidence,
  );
  await Promise.all([
    writeFile(openApiPath, generatedBytes),
    writeFile(lockPath, canonicalizeJson(updatedLock)),
    writeFile(resolve(root, EVIDENCE_PATH, "manifest.sha256"), `${evidence.manifestDigest}\n`),
    writeFile(resolve(root, TYPESCRIPT_RESULTS_PATH), observed.resultsBytes),
    writeFile(resolve(root, TYPESCRIPT_RESULTS_SIDECAR_PATH), observed.sidecarBytes),
  ]);
  process.stdout.write(`Generated Node samples for ${inventory.operationIds.length} operations\n`);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
    throw new TypeError("Usage: node scripts/generate-contracts.mjs [--check]");
  }
  await run({ check: arguments_[0] === "--check" });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`generate-contracts: ${message}\n`);
    process.exitCode = 1;
  });
}
