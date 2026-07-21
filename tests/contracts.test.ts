import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { digestYamlArtifact } from "../scripts/digest-artifact.mjs";
import {
  assertInventoryMatches,
  collectContractInventory,
  collectOperations,
  injectNodeSamples,
  parseOpenApi,
  validateCodeSamples,
  validateInternalReferences,
} from "../scripts/generate-contracts.mjs";
import { NODE_CODE_SAMPLES } from "../scripts/node-code-samples.mjs";

interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

type JsonRecord = Record<string, unknown>;

const OPENAPI_PATH = resolve(process.cwd(), "openapi.yaml");
const LOCK_PATH = resolve(process.cwd(), "contracts.lock.json");
const source = readFileSync(OPENAPI_PATH, "utf8");
const document = parseOpenApi(source);
const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
  artifactHashes: Record<string, string>;
  inventories: JsonRecord;
};

function record(value: unknown): JsonRecord {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function samplesFor(operation: JsonRecord): CodeSample[] {
  return operation["x-code-samples"] as CodeSample[];
}

function schema(name: string): JsonRecord {
  const components = record(document.components);
  return record(record(components.schemas)[name]);
}

describe("REST contract normalization", () => {
  it("matches the pinned operation, schema, idempotency, subaccount, and role inventories", () => {
    const inventory = collectContractInventory(document);

    expect(inventory.operationIds).toHaveLength(56);
    expect(new Set(inventory.operationIds)).toHaveLength(56);
    expect(inventory.schemaNames).toHaveLength(68);
    expect(inventory.idempotencyOperationIds).toHaveLength(11);
    expect(inventory.subAccountOperationIds).toHaveLength(13);
    expect(inventory.subAccountSchemaNames).toHaveLength(7);
    expect(inventory.roleAlternativeOperationIds).toHaveLength(23);
    expect(() => assertInventoryMatches(inventory, lock.inventories)).not.toThrow();
  });

  it("resolves every internal reference and matches the detached YAML hash", () => {
    expect(() => validateInternalReferences(document)).not.toThrow();
    expect(digestYamlArtifact(Buffer.from(source, "utf8"))).toBe(
      lock.artifactHashes["openapi.yaml"],
    );
  });

  it("is idempotently normalized", () => {
    expect(injectNodeSamples(source, document)).toBe(source);
    expect(() => validateCodeSamples(document)).not.toThrow();
  });

  it("retains one Go sample and adds one deterministic Node sample to every operation", () => {
    let shellSamples = 0;

    for (const { operationId, operation } of collectOperations(document)) {
      const samples = samplesFor(operation);
      expect(
        samples.filter(({ lang }) => lang === "go"),
        operationId,
      ).toHaveLength(1);
      expect(
        samples.filter(({ lang }) => lang === "javascript"),
        operationId,
      ).toEqual([NODE_CODE_SAMPLES[operationId]]);
      shellSamples += samples.filter(({ lang }) => lang === "shell").length;
    }

    expect(shellSamples).toBe(1);
  });

  it("emits JavaScript samples accepted by Node.js 18+ syntax", () => {
    for (const [operationId, sample] of Object.entries(NODE_CODE_SAMPLES)) {
      const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: sample.source,
        encoding: "utf8",
      });
      expect(result.stderr, operationId).toBe("");
      expect(result.status, operationId).toBe(0);
    }
  });

  it("uses request body fields defined by each operation's schema", () => {
    for (const { operationId, operation } of collectOperations(document)) {
      if (operation.requestBody === undefined) continue;

      const content = record(record(operation.requestBody).content);
      const requestSchema = record(record(content["application/json"]).schema);
      const reference = requestSchema.$ref;
      if (typeof reference !== "string") {
        throw new TypeError(`${operationId} does not use a referenced request body schema`);
      }

      const schemaName = reference.split("/").at(-1);
      if (schemaName === undefined) throw new TypeError(`${operationId} has an invalid schema ref`);
      const allowedFields = new Set(Object.keys(record(schema(schemaName).properties)));

      const sample = NODE_CODE_SAMPLES[operationId];
      if (sample === undefined) throw new TypeError(`${operationId} has no generated Node sample`);
      const bodyMatch = sample.source.match(/body: JSON\.stringify\((\{[\s\S]*?\})\),\n/);
      if (bodyMatch?.[1] === undefined) {
        throw new TypeError(`${operationId} has no JSON request body in its Node sample`);
      }

      const sampleBody = record(JSON.parse(bodyMatch[1]));
      const unknownFields = Object.keys(sampleBody).filter((field) => !allowedFields.has(field));
      expect(unknownFields, operationId).toEqual([]);
    }
  });

  it("preserves OpenAPI 3.1 null unions and quoted replay header values", () => {
    const apiKeyProperties = record(schema("APIKey").properties);
    expect(record(apiKeyProperties.last_used_at).type).toEqual(["string", "null"]);

    const headers = record(record(document.components).headers);
    const replayedSchema = record(record(headers.IdempotentReplayed).schema);
    const inProgressSchema = record(record(headers.IdempotencyInProgress).schema);
    expect(replayedSchema.enum).toEqual(["true"]);
    expect(inProgressSchema.enum).toEqual(["false"]);
  });

  it("preserves scoped-domain refinements, security ORs, and resource authorization prose", () => {
    const webhook = schema("CreateWebhookRequest");
    const refinement = (webhook.allOf as JsonRecord[])[0];
    const domains = record(record(record(refinement).then).properties).domains;
    expect(record(domains).minItems).toBe(1);

    const operations = collectOperations(document);
    const createMessage = operations.find(({ operationId }) => operationId === "createMessage");
    const getRoutes = operations.find(({ operationId }) => operationId === "getRoutes");
    expect(createMessage?.operation.security).toHaveLength(2);
    expect(createMessage?.operation.description).toMatch(/domain in `from\.email`/);
    expect(getRoutes?.operation.description).toMatch(/matching `domain` query parameter/);
  });
});

describe("REST contract rejection checks", () => {
  it("rejects duplicate YAML keys", () => {
    const duplicate = [
      "openapi: 3.1.0",
      "paths: {}",
      "paths: {}",
      "components:",
      "  schemas: {}",
      "",
    ].join("\n");

    expect(() => parseOpenApi(duplicate)).toThrow(/duplicated mapping key/i);
  });

  it("rejects unresolved references", () => {
    const changed = structuredClone(document);
    const components = record(changed.components);
    const schemas = record(components.schemas);
    schemas.Broken = { $ref: "#/components/schemas/DoesNotExist" };

    expect(() => validateInternalReferences(changed)).toThrow(/Unresolved OpenAPI reference/);
  });

  it("rejects inventory drift", () => {
    const changed = structuredClone(collectContractInventory(document));
    changed.operationIds.pop();

    expect(() => assertInventoryMatches(changed, lock.inventories)).toThrow(/inventory drift/);
  });

  it("includes OpenAPI HEAD operations in inventory and sample validation", () => {
    const changed = structuredClone(document);
    const pingPath = record(record(changed.paths)["/v2/ping"]);
    pingPath.head = structuredClone(record(pingPath.get));
    const headPing = record(pingPath.head);
    headPing.operationId = "headPing";
    delete headPing["x-code-samples"];

    expect(collectOperations(changed)).toContainEqual(
      expect.objectContaining({ method: "head", path: "/v2/ping", operationId: "headPing" }),
    );
    expect(collectContractInventory(changed).operationIds).toHaveLength(57);
    expect(() =>
      assertInventoryMatches(collectContractInventory(changed), lock.inventories),
    ).toThrow(/inventory drift/);
    expect(() => validateCodeSamples(changed)).toThrow(/Missing Node sample definitions: headPing/);
  });

  it("rejects operation path drift in the operation-keyed samples", () => {
    const changed = structuredClone(document);
    const paths = record(changed.paths);
    paths["/v2/not-ping"] = paths["/v2/ping"];
    delete paths["/v2/ping"];

    expect(() => validateCodeSamples(changed)).toThrow(/Node sample operation drift for ping/);
  });

  it("rejects missing and orphan operation-keyed sample definitions", () => {
    const missing = Object.fromEntries(
      Object.entries(NODE_CODE_SAMPLES).filter(([operationId]) => operationId !== "ping"),
    );
    const orphan = { ...NODE_CODE_SAMPLES, inventedOperation: NODE_CODE_SAMPLES.ping! };

    expect(() => validateCodeSamples(document, missing)).toThrow(
      /Missing Node sample definitions: ping/,
    );
    expect(() => validateCodeSamples(document, orphan)).toThrow(
      /Orphan Node sample definitions: inventedOperation/,
    );
  });

  it("rejects missing, duplicate, and drifted generated samples", () => {
    const missing = structuredClone(document);
    const missingOperation = collectOperations(missing)[0]!;
    missingOperation.operation["x-code-samples"] = samplesFor(missingOperation.operation).filter(
      ({ lang }) => lang !== "javascript",
    );
    expect(() => validateCodeSamples(missing)).toThrow(/ping must have exactly one Node sample/);

    const duplicate = structuredClone(document);
    const duplicateOperation = collectOperations(duplicate)[0]!;
    samplesFor(duplicateOperation.operation).push({ ...NODE_CODE_SAMPLES.ping! });
    expect(() => validateCodeSamples(duplicate)).toThrow(/ping must have exactly one Node sample/);

    const drifted = structuredClone(document);
    const driftedOperation = collectOperations(drifted)[0]!;
    const nodeSample = samplesFor(driftedOperation.operation).find(
      ({ lang }) => lang === "javascript",
    )!;
    nodeSample.source += "// drift\n";
    expect(() => validateCodeSamples(drifted)).toThrow(/Generated Node sample drift for ping/);
  });

  it.each(["js", "ts"])("rejects duplicate Node samples tagged with the %s alias", (lang) => {
    const duplicate = structuredClone(document);
    const duplicateOperation = collectOperations(duplicate)[0]!;
    samplesFor(duplicateOperation.operation).push({ ...NODE_CODE_SAMPLES.ping!, lang });

    expect(() => validateCodeSamples(duplicate)).toThrow(
      /ping must have exactly one Node sample; received 2/,
    );
    expect(() => injectNodeSamples(source, duplicate)).toThrow(
      /ping must have exactly one Node sample; received 2/,
    );
  });

  it("uses js-yaml without losing inline schema refinements", () => {
    const reparsed = yaml.load(source) as JsonRecord;
    const schemas = record(record(reparsed.components).schemas);
    expect(record(schemas.CreateWebhookRequest).allOf).toBeDefined();
  });
});
