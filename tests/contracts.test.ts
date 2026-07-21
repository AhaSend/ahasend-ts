import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { digestJsonArtifact, digestYamlArtifact } from "../scripts/digest-artifact.mjs";
import {
  assertInventoryMatches,
  collectContractInventory,
  collectOperations,
  injectNodeSamples,
  parseOpenApi,
  parseWebhookContract,
  validateCapturedManifest,
  validateCapturedManifestSchema,
  validateCodeSamples,
  validateInternalReferences,
  validateSecretScanAllowlist,
  validateSignedFixture,
  validateWebhookEvidence,
  validateWebhookContract,
} from "../scripts/generate-contracts.mjs";
import { NODE_CODE_SAMPLES } from "../scripts/node-code-samples.mjs";

interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

type JsonRecord = Record<string, unknown>;

const OPENAPI_PATH = resolve(process.cwd(), "openapi.yaml");
const WEBHOOK_PATH = resolve(process.cwd(), "webhooks.yaml");
const LOCK_PATH = resolve(process.cwd(), "contracts.lock.json");
const CAPTURED_PATH = resolve(process.cwd(), "contracts/webhooks/captured");
const SYNTHETIC_PATH = resolve(process.cwd(), "contracts/webhooks/synthetic");
const SECRET_POLICY_PATH = resolve(process.cwd(), "security/secret-scan-allowlist.json");
const source = readFileSync(OPENAPI_PATH, "utf8");
const document = parseOpenApi(source);
const webhookSource = readFileSync(WEBHOOK_PATH, "utf8");
const webhookDocument = parseWebhookContract(webhookSource);
const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as {
  artifactHashes: Record<string, string>;
  inventories: JsonRecord;
};
const capturedManifest = JSON.parse(
  readFileSync(resolve(CAPTURED_PATH, "manifest.json"), "utf8"),
) as JsonRecord;
const capturedSchema = JSON.parse(
  readFileSync(resolve(CAPTURED_PATH, "manifest.schema.json"), "utf8"),
) as JsonRecord;
const syntheticManifest = JSON.parse(
  readFileSync(resolve(SYNTHETIC_PATH, "manifest.json"), "utf8"),
) as JsonRecord;
const secretPolicy = JSON.parse(readFileSync(SECRET_POLICY_PATH, "utf8")) as JsonRecord;

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

function webhookSchema(name: string): JsonRecord {
  const components = record(webhookDocument.components);
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

describe("webhook delivery contract", () => {
  it("is versioned, internally valid, and matches its detached YAML hash", () => {
    expect(record(webhookDocument.info).version).toBe("2.0.0");
    expect(() => validateInternalReferences(webhookDocument)).not.toThrow();
    expect(() => validateWebhookContract(webhookDocument)).not.toThrow();
    expect(digestYamlArtifact(Buffer.from(webhookSource, "utf8"))).toBe(
      lock.artifactHashes["webhooks.yaml"],
    );
  });

  it("uses message.routing canonically while accepting route.message as deprecated input", () => {
    const webhookDefinitions = record(webhookDocument.webhooks);
    expect(webhookDefinitions).toHaveProperty("message.routing");
    expect(webhookDefinitions).not.toHaveProperty("route.message");

    const routeProperties = record(webhookSchema("RouteWebhookPayload").properties);
    const routeType = record(routeProperties.type);
    expect(routeType.enum).toEqual(["message.routing", "route.message"]);
    expect(routeType["x-deprecated-values"]).toEqual(["route.message"]);
    expect(routeType.description).toMatch(
      /message\.routing.*canonical.*route\.message.*deprecated/,
    );
  });

  it("defines is_bot as an optional boolean for open and click event data", () => {
    for (const schemaName of ["MessageWebhookData", "MessageClickedWebhookData"]) {
      const eventData = webhookSchema(schemaName);
      const properties = record(eventData.properties);
      expect(record(properties.is_bot).type, schemaName).toBe("boolean");
      expect(eventData.required, schemaName).not.toContain("is_bot");
    }
  });

  it("documents the literal UTF-8 resource secret compatibility boundary", () => {
    const description = record(webhookDocument.info).description;
    expect(description).toMatch(/literal UTF-8 bytes/);
    expect(description).toMatch(/Do not Base64-decode.*do not strip a prefix/);
    expect(description).toMatch(/compatibility with stock libraries is not unconditional/);
    expect(description).toMatch(/raw-secret\/raw-key mode/);
    expect(description).not.toMatch(/fully compatible with/i);
  });
});

describe("webhook delivery contract rejection checks", () => {
  it("rejects route aliases that are not explicitly accepted and deprecated", () => {
    const changed = structuredClone(webhookDocument);
    const schemas = record(record(changed.components).schemas);
    const routeProperties = record(record(schemas.RouteWebhookPayload).properties);
    const routeType = record(routeProperties.type);
    routeType.enum = ["message.routing"];

    expect(() => validateWebhookContract(changed)).toThrow(/deprecated route\.message/);
  });

  it("rejects required is_bot fields", () => {
    const changed = structuredClone(webhookDocument);
    const schemas = record(record(changed.components).schemas);
    const clicked = record(schemas.MessageClickedWebhookData);
    (clicked.required as unknown[]).push("is_bot");

    expect(() => validateWebhookContract(changed)).toThrow(/is_bot must be optional/);
  });
});

describe("captured webhook evidence", () => {
  it("validates the manifest schema, detached digest, locked artifacts, and all evidence", async () => {
    expect(() => validateCapturedManifestSchema(capturedSchema)).not.toThrow();
    expect(() => validateCapturedManifest(capturedManifest, capturedSchema)).not.toThrow();

    const detachedDigest = readFileSync(resolve(CAPTURED_PATH, "manifest.sha256"), "utf8");
    const manifestDigest = digestJsonArtifact(capturedManifest);
    expect(detachedDigest).toBe(`${manifestDigest}\n`);
    expect(lock.artifactHashes["contracts/webhooks/captured/manifest.json"]).toBe(manifestDigest);
    expect(lock.artifactHashes["contracts/webhooks/captured/manifest.schema.json"]).toBe(
      digestJsonArtifact(capturedSchema),
    );
    expect(lock.artifactHashes["contracts/webhooks/synthetic/manifest.json"]).toBe(
      digestJsonArtifact(syntheticManifest),
    );
    expect(lock.artifactHashes["security/secret-scan-allowlist.json"]).toBe(
      digestJsonArtifact(secretPolicy),
    );

    await expect(validateWebhookEvidence(process.cwd())).resolves.toMatchObject({
      captureCount: 2,
      syntheticCount: 1,
    });
  });

  it("enforces manifest.schema.json against the captured manifest", () => {
    const changedVersionSchema = structuredClone(capturedSchema);
    record(record(changedVersionSchema.properties).version).const = 2;
    expect(() => validateCapturedManifest(capturedManifest, changedVersionSchema)).toThrow(
      /does not match its JSON Schema/,
    );

    const missingPropertiesSchema = structuredClone(capturedSchema);
    delete missingPropertiesSchema.properties;
    expect(() => validateCapturedManifest(capturedManifest, missingPropertiesSchema)).toThrow(
      /does not match its JSON Schema/,
    );
  });

  it("reproduces fixed signatures and exact three-header records from persisted values", () => {
    const captures = capturedManifest.captures as JsonRecord[];
    expect(captures).toHaveLength(2);

    for (const capture of captures) {
      const resource = record(capture.signingResource);
      const bodyPath = capture.bodyPath as string;
      const keyPath = resource.keyPath as string;
      const rawBody = readFileSync(resolve(process.cwd(), bodyPath));
      const keyFile = readFileSync(resolve(process.cwd(), keyPath));
      const key = keyFile.subarray(0, keyFile.length - 1);

      expect(createHash("sha256").update(rawBody).digest("hex"), capture.fixtureId as string).toBe(
        capture.rawBodySha256,
      );
      expect(createHash("sha256").update(key).digest("hex"), capture.fixtureId as string).toBe(
        resource.keySha256,
      );

      const signature = `v1,${createHmac("sha256", key)
        .update(capture.webhookId as string)
        .update(".")
        .update(capture.webhookTimestamp as string)
        .update(".")
        .update(rawBody)
        .digest("base64")}`;
      expect(signature, capture.fixtureId as string).toBe(capture.signature);

      const headerRecord = [
        `webhook-id:${capture.webhookId as string}`,
        `webhook-timestamp:${capture.webhookTimestamp as string}`,
        `webhook-signature:${capture.signature as string}`,
        "",
      ].join("\n");
      expect(
        createHash("sha256").update(headerRecord, "utf8").digest("hex"),
        capture.fixtureId as string,
      ).toBe(capture.headersSha256);
      expect(capture.webhookId).toBeTypeOf("string");
      expect(capture.webhookTimestamp).toMatch(/^\d+$/);
      expect(record(capture.provenance).kind).toBe("captured");
      expect(capture.expectedResult).toBe("valid");

      const payload = JSON.parse(rawBody.toString("utf8")) as JsonRecord;
      if (resource.type === "configured-webhook") {
        expect(payload.webhook_id).toBe(resource.id);
      }
    }
  });

  it("rejects changed signed headers, reserialized bodies, swapped keys, and changed keys", () => {
    const captures = capturedManifest.captures as JsonRecord[];
    const configuredCapture = structuredClone(captures[0]!);
    const routeCapture = structuredClone(captures[1]!);
    const configuredResource = record(configuredCapture.signingResource);
    const routeResource = record(routeCapture.signingResource);
    const configuredBody = readFileSync(
      resolve(process.cwd(), configuredCapture.bodyPath as string),
    );
    const configuredKey = readFileSync(
      resolve(process.cwd(), configuredResource.keyPath as string),
    );
    const routeKey = readFileSync(resolve(process.cwd(), routeResource.keyPath as string));

    const changedId = structuredClone(configuredCapture);
    changedId.webhookId = `${changedId.webhookId as string}-changed`;
    expect(() =>
      validateSignedFixture(changedId, configuredBody, configuredKey, { captured: true }),
    ).toThrow(/signature mismatch/);

    const changedTimestamp = structuredClone(configuredCapture);
    changedTimestamp.webhookTimestamp = "1784041402";
    expect(() =>
      validateSignedFixture(changedTimestamp, configuredBody, configuredKey, { captured: true }),
    ).toThrow(/signature mismatch/);

    const reserializedBody = Buffer.from(
      JSON.stringify(JSON.parse(configuredBody.toString("utf8"))),
      "utf8",
    );
    expect(() =>
      validateSignedFixture(configuredCapture, reserializedBody, configuredKey, {
        captured: true,
      }),
    ).toThrow(/raw body digest mismatch/);
    expect(() =>
      validateSignedFixture(configuredCapture, configuredBody, routeKey, { captured: true }),
    ).toThrow(/signing key digest mismatch/);

    const changedKey = Buffer.from(`${configuredKey.toString("utf8").trimEnd()}-changed\n`, "utf8");
    expect(() =>
      validateSignedFixture(configuredCapture, configuredBody, changedKey, { captured: true }),
    ).toThrow(/signing key digest mismatch/);
  });

  it("rejects header-record and resource/key binding drift independently", () => {
    const capture = structuredClone((capturedManifest.captures as JsonRecord[])[0]!);
    const resource = record(capture.signingResource);
    const body = readFileSync(resolve(process.cwd(), capture.bodyPath as string));
    const key = readFileSync(resolve(process.cwd(), resource.keyPath as string));

    capture.headersSha256 = "0".repeat(64);
    expect(() => validateSignedFixture(capture, body, key, { captured: true })).toThrow(
      /signed header record digest mismatch/,
    );

    const changedBinding = structuredClone((capturedManifest.captures as JsonRecord[])[0]!);
    record(changedBinding.signingResource).bindingSha256 = "0".repeat(64);
    expect(() => validateSignedFixture(changedBinding, body, key, { captured: true })).toThrow(
      /resource\/key binding mismatch/,
    );
  });

  it("rejects a captured fixture key copied outside its single allowlisted path", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ahasend-secret-scan-"));
    try {
      for (const value of secretPolicy.rules as JsonRecord[]) {
        const allowedPath = value.allowedPath as string;
        const destination = resolve(temporaryRoot, allowedPath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(resolve(process.cwd(), allowedPath)));
      }
      const copiedKeyPath = resolve(temporaryRoot, "copied-configured-webhook.key");
      writeFileSync(
        copiedKeyPath,
        readFileSync(
          resolve(process.cwd(), "contracts/webhooks/captured/keys/configured-webhook.key"),
        ),
      );

      await expect(validateSecretScanAllowlist(secretPolicy, temporaryRoot)).rejects.toThrow(
        /secret scan classification violation/,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects scanner policies that classify one allowed path more than once", async () => {
    const duplicatePolicy = structuredClone(secretPolicy);
    const configuredRule = (duplicatePolicy.rules as JsonRecord[])[0]!;
    duplicatePolicy.rules = [
      configuredRule,
      { ...configuredRule, id: "duplicate-configured-key-1" },
      { ...configuredRule, id: "duplicate-configured-key-2" },
    ];

    await expect(validateSecretScanAllowlist(duplicatePolicy, process.cwd())).rejects.toThrow(
      /Duplicate secret scan allowed path/,
    );
  });
});

describe("synthetic webhook fixtures", () => {
  it("validates independently and stays outside captured evidence", () => {
    const captures = capturedManifest.captures as JsonRecord[];
    const fixtures = syntheticManifest.fixtures as JsonRecord[];
    expect(fixtures).toHaveLength(1);
    expect(captures.every((capture) => !(capture.bodyPath as string).includes("/synthetic/"))).toBe(
      true,
    );

    for (const fixture of fixtures) {
      const body = readFileSync(resolve(process.cwd(), fixture.bodyPath as string));
      const key = readFileSync(resolve(process.cwd(), fixture.keyPath as string));
      expect(() => validateSignedFixture(fixture, body, key, { captured: false })).not.toThrow();
      expect(fixture.expectedResult).toBe("valid");
      expect((JSON.parse(body.toString("utf8")) as JsonRecord).webhook_id).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
  });

  it("rejects a message fixture without the contract-required webhook_id", () => {
    const fixture = structuredClone((syntheticManifest.fixtures as JsonRecord[])[0]!);
    const body = readFileSync(resolve(process.cwd(), fixture.bodyPath as string));
    const keyFile = readFileSync(resolve(process.cwd(), fixture.keyPath as string));
    const key = keyFile.subarray(0, keyFile.length - 1);
    const payload = JSON.parse(body.toString("utf8")) as JsonRecord;
    delete payload.webhook_id;
    const changedBody = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    fixture.rawBodySha256 = createHash("sha256").update(changedBody).digest("hex");
    fixture.signature = `v1,${createHmac("sha256", key)
      .update(fixture.webhookId as string)
      .update(".")
      .update(fixture.webhookTimestamp as string)
      .update(".")
      .update(changedBody)
      .digest("base64")}`;

    expect(() => validateSignedFixture(fixture, changedBody, keyFile, { captured: false })).toThrow(
      /body\.webhook_id/,
    );
  });
});
