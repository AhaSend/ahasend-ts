#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { canonicalizeJson, digestYamlArtifact } from "./digest-artifact.mjs";
import { NODE_CODE_SAMPLES, NODE_OPERATION_KEYS } from "./node-code-samples.mjs";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
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

function assertRecord(value, location) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${location} must be a mapping`);
  }
  return value;
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

export function validateCodeSamples(
  document,
  nodeSamples = NODE_CODE_SAMPLES,
  { allowMissingNodeSamples = false, allowNodeSampleDrift = false } = {},
) {
  const operations = collectOperations(document);
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

function lockWithHash(lock, openApiBytes) {
  return {
    ...lock,
    artifactHashes: {
      ...assertRecord(lock.artifactHashes, "contracts.lock.json artifactHashes"),
      "openapi.yaml": digestYamlArtifact(openApiBytes),
    },
  };
}

async function run({ check }) {
  const root = process.cwd();
  const openApiPath = resolve(root, "openapi.yaml");
  const lockPath = resolve(root, "contracts.lock.json");
  const [source, lockSource] = await Promise.all([
    readFile(openApiPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const lock = assertRecord(JSON.parse(lockSource), "contracts.lock.json");
  const document = parseOpenApi(source);
  validateInternalReferences(document);
  const inventory = collectContractInventory(document);
  assertInventoryMatches(inventory, lock.inventories);

  if (check) {
    validateCodeSamples(document);
    const expectedHash = assertRecord(lock.artifactHashes, "artifactHashes")["openapi.yaml"];
    const actualHash = digestYamlArtifact(Buffer.from(source, "utf8"));
    if (actualHash !== expectedHash) {
      throw new TypeError(
        `openapi.yaml artifact hash drift: expected ${JSON.stringify(expectedHash)}, received ${actualHash}`,
      );
    }
    const normalized = injectNodeSamples(source, document);
    if (normalized !== source)
      throw new TypeError("openapi.yaml generated samples are not normalized");
    process.stdout.write(
      `REST contract OK: ${inventory.operationIds.length} operations, ${inventory.schemaNames.length} schemas\n`,
    );
    return;
  }

  const generatedSource = injectNodeSamples(source, document);
  const generatedDocument = parseOpenApi(generatedSource);
  validateInternalReferences(generatedDocument);
  assertInventoryMatches(collectContractInventory(generatedDocument), lock.inventories);
  validateCodeSamples(generatedDocument);

  const generatedBytes = Buffer.from(generatedSource, "utf8");
  const updatedLock = lockWithHash(lock, generatedBytes);
  await Promise.all([
    writeFile(openApiPath, generatedBytes),
    writeFile(lockPath, canonicalizeJson(updatedLock)),
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
