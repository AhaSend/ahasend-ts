import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  validateNodeSampleRegistry,
  validateSecretScanAllowlist,
  validateSignedFixture,
  validateWebhookEvidence,
  validateWebhookContract,
} from "../scripts/generate-contracts.mjs";
import {
  NODE_CODE_SAMPLES,
  NODE_OPERATION_KEYS,
  NODE_SAMPLE_REGISTRY,
} from "../scripts/node-code-samples.mjs";
import type { NodeSampleRegistryEntry } from "../scripts/node-code-samples.mjs";
import { OPENAPI_SHA256 } from "../src/generated/contract-digests.js";

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
const capturedFixtureOptions = {
  captured: true,
  headerRecordFormat: capturedManifest.headerRecordFormat as string,
} as const;

function record(value: unknown): JsonRecord {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function samplesFor(operation: JsonRecord): CodeSample[] {
  return operation["x-code-samples"] as CodeSample[];
}

function changedRegistryEntry(
  operationId: string,
  change: (entry: NodeSampleRegistryEntry) => NodeSampleRegistryEntry,
): NodeSampleRegistryEntry[] {
  return NODE_SAMPLE_REGISTRY.map((entry) =>
    entry.operationId === operationId ? change(entry) : entry,
  );
}

function normalizeSampleLanguage(value: string): string {
  const unquoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
      ? value.slice(1, -1)
      : value;
  return unquoted.toLowerCase().replaceAll(/[^a-z.]/g, "");
}

function rawNonNodeSampleBlocks(yamlSource: string): Array<{
  operationId: string;
  language: string;
  bytes: Buffer;
}> {
  const samples: Array<{ operationId: string; language: string; bytes: Buffer }> = [];
  const lines = yamlSource.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  let operationId = "";
  let insideSamples = false;
  let current: { language: string; lines: string[] } | undefined;

  const finishSample = (): void => {
    if (
      current !== undefined &&
      !["javascript", "js", "typescript", "ts"].includes(current.language)
    ) {
      samples.push({
        operationId,
        language: current.language,
        bytes: Buffer.from(current.lines.join(""), "utf8"),
      });
    }
    current = undefined;
  };

  for (const line of lines) {
    const lineWithoutEnding = line.replace(/\r?\n$/u, "");
    if (insideSamples) {
      const indentation = lineWithoutEnding.match(/^ */u)?.[0].length ?? 0;
      if (lineWithoutEnding.trim() !== "" && indentation <= 6) {
        finishSample();
        insideSamples = false;
      } else {
        const sampleMatch = lineWithoutEnding.match(/^ {8}- lang:\s*(.+?)\s*$/u);
        if (sampleMatch?.[1] !== undefined) {
          finishSample();
          current = {
            language: normalizeSampleLanguage(sampleMatch[1]),
            lines: [line],
          };
        } else if (current !== undefined) {
          current.lines.push(line);
        }
        continue;
      }
    }

    const operationMatch = lineWithoutEnding.match(/^ {6}operationId:\s*(.+?)\s*$/u);
    if (operationMatch?.[1] !== undefined) operationId = operationMatch[1];
    if (/^ {6}x-code-samples:\s*$/u.test(lineWithoutEnding)) {
      insideSamples = true;
    }
  }
  finishSample();

  return samples;
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
    expect(OPENAPI_SHA256).toBe(lock.artifactHashes["openapi.yaml"]);
  });

  it("is idempotently normalized", () => {
    expect(injectNodeSamples(source, document)).toBe(source);
    expect(() => validateCodeSamples(document)).not.toThrow();
  });

  it("retains one Go sample and adds one deterministic SDK sample to every operation", () => {
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
    expect(NODE_SAMPLE_REGISTRY).toHaveLength(56);
    expect(NODE_SAMPLE_REGISTRY.map(({ operationId }) => operationId)).toEqual(
      lock.inventories.operationIds,
    );
  });

  it("emits modern ESM JavaScript accepted by the supported Node.js runtime", () => {
    for (const [operationId, sample] of Object.entries(NODE_CODE_SAMPLES)) {
      const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: sample.source,
        encoding: "utf8",
      });
      expect(result.stderr, operationId).toBe("");
      expect(result.status, operationId).toBe(0);
    }
  });

  it("uses only the public client, matching facades, safe mutation controls, and safe output", () => {
    expect(() => validateNodeSampleRegistry(document)).not.toThrow();

    for (const { operationId, facade, sample } of NODE_SAMPLE_REGISTRY) {
      expect(sample.source, operationId).toContain('import { AhaSendClient } from "@ahasend/sdk";');
      expect(sample.source, operationId).toContain("AhaSendClient.fromEnv()");
      expect(sample.source, operationId).toContain(`${facade}(`);
      expect(sample.source, operationId).not.toMatch(/\bfetch\s*\(|\bnew\s+URL\s*\(/u);
      expect(sample.source, operationId).not.toMatch(/api\.ahasend\.com|Authorization|Bearer/u);
      expect(sample.source, operationId).not.toMatch(
        /console\.log\([^\n]*(?:secret_key|password|idempotencyKey)/u,
      );
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
    expect(() => validateCodeSamples(changed)).toThrow(
      /Missing Node sample registry mappings: headPing/,
    );
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

  it("rejects missing, duplicate, and orphaned registry mappings", () => {
    const missing = NODE_SAMPLE_REGISTRY.filter(({ operationId }) => operationId !== "ping");
    const duplicate = [...NODE_SAMPLE_REGISTRY, NODE_SAMPLE_REGISTRY[0]!];
    const orphaned = [
      ...NODE_SAMPLE_REGISTRY,
      { ...NODE_SAMPLE_REGISTRY[0]!, operationId: "inventedOperation" },
    ];

    expect(() => validateNodeSampleRegistry(document, missing)).toThrow(
      /Missing Node sample registry mappings: ping/,
    );
    expect(() => validateNodeSampleRegistry(document, duplicate)).toThrow(
      /Duplicate Node sample registry mappings: ping/,
    );
    expect(() => validateNodeSampleRegistry(document, orphaned)).toThrow(
      /Orphan Node sample registry mappings: inventedOperation/,
    );
  });

  it("rejects raw requests, non-public imports, and wrong SDK facades", () => {
    const rawFetch = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nawait fetch("https://api.ahasend.com/v2/ping");\n`,
      },
    }));
    const internalImport = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace('"@ahasend/sdk"', '"@ahasend/sdk/dist/client.js"'),
      },
    }));
    const aliasedMissingExport = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          "{ AhaSendClient }",
          "{ MissingExport as AhaSendClient }",
        ),
      },
    }));
    const dynamicInternalImport = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nawait import("@ahasend/sdk/dist/client.js");\n`,
      },
    }));
    const bracketedGlobalFetch = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nawait globalThis["fetch"]("https://example.com");\n`,
      },
    }));
    const aliasedGlobalFetch = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nconst fetchName = "fetch";\nconst request = globalThis[fetchName];\nawait request("https://api." + "ahasend.com/v2/ping");\n`,
      },
    }));
    const apiUrl = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nconst endpoint = new URL("https://api.ahasend.com/v2/ping");\n`,
      },
    }));
    const bearerHeader = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nconst authorization = "bearer example-token";\n`,
      },
    }));
    const wrongFacade = changedRegistryEntry("getDomains", (entry) => ({
      ...entry,
      facade: "client.routes.list",
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace("client.domains.list", "client.routes.list"),
      },
    }));
    const detachedClient = changedRegistryEntry("ping", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          "const client = AhaSendClient.fromEnv();",
          "const client = console;\nAhaSendClient.fromEnv();",
        ),
      },
    }));
    const aliasedWrongFacade = changedRegistryEntry("getDomains", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nconst routes = client.routes;\nawait routes.list({ limit: 20 });\n`,
      },
    }));

    expect(() => validateNodeSampleRegistry(document, rawFetch)).toThrow(/raw API requests/);
    expect(() => validateNodeSampleRegistry(document, bracketedGlobalFetch)).toThrow(
      /raw API requests/,
    );
    expect(() => validateNodeSampleRegistry(document, aliasedGlobalFetch)).toThrow(
      /raw API requests/,
    );
    expect(() => validateNodeSampleRegistry(document, apiUrl)).toThrow(/raw API requests/);
    expect(() => validateNodeSampleRegistry(document, bearerHeader)).toThrow(/raw API requests/);
    expect(() => validateNodeSampleRegistry(document, internalImport)).toThrow(
      /non-public SDK module/,
    );
    expect(() => validateNodeSampleRegistry(document, aliasedMissingExport)).toThrow(
      /must import only AhaSendClient/,
    );
    expect(() => validateNodeSampleRegistry(document, dynamicInternalImport)).toThrow(
      /must not use dynamic imports/,
    );
    expect(() => validateNodeSampleRegistry(document, wrongFacade)).toThrow(
      /Wrong facade mapping for getDomains/,
    );
    expect(() => validateNodeSampleRegistry(document, detachedClient)).toThrow(
      /assign client from AhaSendClient\.fromEnv/,
    );
    expect(() => validateNodeSampleRegistry(document, aliasedWrongFacade)).toThrow(
      /calls the wrong facade/,
    );
  });

  it("rejects request bodies with unknown fields, missing required fields, or invalid values", () => {
    const unknownOneLineField = changedRegistryEntry("createDomain", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          '{ domain: "example.com" }',
          '{ invented: "example.com" }',
        ),
      },
    }));
    const missingRequiredField = changedRegistryEntry("createDomain", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace('{ domain: "example.com" }', "{}"),
      },
    }));
    const invalidEnumValue = changedRegistryEntry("createWebhook", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace('scope: "global"', 'scope: "invented"'),
      },
    }));

    expect(() => validateNodeSampleRegistry(document, unknownOneLineField)).toThrow(
      /request body does not match its schema/,
    );
    expect(() => validateNodeSampleRegistry(document, missingRequiredField)).toThrow(
      /request body does not match its schema/,
    );
    expect(() => validateNodeSampleRegistry(document, invalidEnumValue)).toThrow(
      /request body does not match its schema/,
    );
  });

  it("rejects missing mutation guards, unsandboxed sends, unstable keys, and secret output", () => {
    const unguarded = changedRegistryEntry("deleteRoute", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          /if \(process\.env\.AHASEND_ALLOW_MUTATIONS[\s\S]*?\n\}\n\n/u,
          "",
        ),
      },
    }));
    const unsandboxed = changedRegistryEntry("createMessage", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace("sandbox: true", "sandbox: false"),
      },
    }));
    const unstableKey = changedRegistryEntry("createDomain", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace('{ idempotencyKey: "sdk-sample-create-domain" }', "{}"),
      },
    }));
    const secretOutput = changedRegistryEntry("createAPIKey", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          "{ id: apiKey.id, label: apiKey.label }",
          "{ secret_key: apiKey.secret_key }",
        ),
      },
    }));
    const aliasedSecretOutput = changedRegistryEntry("createAPIKey", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `${entry.sample.source}\nconst emit = console.log;\nemit(apiKey.secret_key);\n`,
      },
    }));
    const callInsideGuard = changedRegistryEntry("deleteRoute", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: `import { AhaSendClient } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();
const routeId = "00000000-0000-4000-8000-000000000006";
let result;
if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  result = await client.routes.delete(routeId);
  throw new Error("Set AHASEND_ALLOW_MUTATIONS=1 after reviewing this mutation.");
}
console.log("Route deleted.", { message: result.message });
`,
      },
    }));
    const responseBodyOutput = changedRegistryEntry("createAPIKey", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          'console.log("API key created.", { id: apiKey.id, label: apiKey.label });',
          "console.log(apiKey);",
        ),
      },
    }));
    const nestedResponseBodyOutput = changedRegistryEntry("createAPIKey", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace(
          "{ id: apiKey.id, label: apiKey.label }",
          "{ response: { apiKey } }",
        ),
      },
    }));
    const nestedSandbox = changedRegistryEntry("createMessage", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source
          .replace(
            'recipients: [{ email: "recipient@example.net" }]',
            'recipients: [{ email: "recipient@example.net", sandbox: true }]',
          )
          .replace("    sandbox: true,\n", ""),
      },
    }));
    const bodyIdempotencyKey = changedRegistryEntry("createDomain", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source
          .replace(
            '{ domain: "example.com" }',
            '{ domain: "example.com", idempotencyKey: "sdk-sample-create-domain" }',
          )
          .replace(',\n  { idempotencyKey: "sdk-sample-create-domain" }', ""),
      },
    }));

    expect(() => validateNodeSampleRegistry(document, unguarded)).toThrow(/guard the mutation/);
    expect(() => validateNodeSampleRegistry(document, callInsideGuard)).toThrow(
      /guard the mutation/,
    );
    expect(() => validateNodeSampleRegistry(document, unsandboxed)).toThrow(/sandbox: true/);
    expect(() => validateNodeSampleRegistry(document, nestedSandbox)).toThrow(/sandbox: true/);
    expect(() => validateNodeSampleRegistry(document, unstableKey)).toThrow(
      /stable caller idempotency key/,
    );
    expect(() => validateNodeSampleRegistry(document, bodyIdempotencyKey)).toThrow(
      /stable caller idempotency key/,
    );
    expect(() => validateNodeSampleRegistry(document, secretOutput)).toThrow(/one-time secret/);
    expect(() => validateNodeSampleRegistry(document, aliasedSecretOutput)).toThrow(
      /one-time secret/,
    );
    expect(() => validateNodeSampleRegistry(document, responseBodyOutput)).toThrow(
      /metadata instead of response bodies/,
    );
    expect(() => validateNodeSampleRegistry(document, nestedResponseBodyOutput)).toThrow(
      /metadata instead of response bodies/,
    );
  });

  it("rejects samples that rely on values declared in another documentation tab", () => {
    const externalValue = changedRegistryEntry("getDomain", (entry) => ({
      ...entry,
      sample: {
        ...entry.sample,
        source: entry.sample.source.replace('const domainName = "example.com";\n', ""),
      },
    }));

    expect(() => validateNodeSampleRegistry(document, externalValue)).toThrow(
      /not self-contained; undeclared values: domainName/,
    );
  });

  it("preserves every existing Go and shell sample byte-for-byte during injection", () => {
    const changedNodeSamples = {
      ...NODE_CODE_SAMPLES,
      ping: { ...NODE_CODE_SAMPLES.ping!, source: `${NODE_CODE_SAMPLES.ping!.source}// changed\n` },
    };
    const generatedSource = injectNodeSamples(source, document, changedNodeSamples);

    expect(rawNonNodeSampleBlocks(generatedSource)).toEqual(rawNonNodeSampleBlocks(source));
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
  it("pins the configured-webhook capture to its received body and headers", () => {
    const capture = (capturedManifest.captures as JsonRecord[]).find(
      ({ fixtureId }) => fixtureId === "configured-webhook-message-delivered",
    );

    expect(capture).toMatchObject({
      rawBodySha256: "9b244efbd6d8b46ed32eeead74c9e2980e2623a60162d1b9350711f6ea5fa137",
      signature: "v1,AN/zm8EakS5sDN7boC5iGVLtQiVlayI5MOi3Qpyxtb0=",
      headersSha256: "fc3fb212caba5a50220c5055825da659eb929b0f95184468e39ea4acb6c400b8",
    });
  });

  it("pins the server revision that produced the captured deliveries", () => {
    expect(capturedManifest.serverCommit).toBe("7565fcb337a9f6fda0e8c3a22917dfcda3d76544");
  });

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
      syntheticCount: 4,
    });
  });

  it("rebuilds public-verifier results in an isolated clean source tree", () => {
    const repositoryRoot = process.cwd();
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ahasend-contract-check-"));
    const sourceEntries = [
      "contracts",
      "scripts",
      "security",
      "src",
      "contracts.lock.json",
      "openapi.yaml",
      "package.json",
      "tsconfig.json",
      "tsup.config.ts",
      "webhooks.yaml",
    ];

    try {
      for (const entry of sourceEntries) {
        cpSync(resolve(repositoryRoot, entry), resolve(temporaryRoot, entry), {
          recursive: true,
        });
      }
      symlinkSync(resolve(repositoryRoot, "node_modules"), resolve(temporaryRoot, "node_modules"));

      const isolatedDist = resolve(temporaryRoot, "dist");
      expect(existsSync(isolatedDist)).toBe(false);
      expect(existsSync(resolve(temporaryRoot, ".git"))).toBe(false);

      const rejectedMisdirectedBuild = spawnSync(process.execPath, ["scripts/build.mjs"], {
        cwd: temporaryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AHASEND_EXPECT_BUILD_ROOT: repositoryRoot,
        },
      });
      expect(rejectedMisdirectedBuild.status).not.toBe(0);
      expect(rejectedMisdirectedBuild.stderr).toContain("Refusing to build");
      expect(existsSync(isolatedDist)).toBe(false);

      const check = spawnSync(process.execPath, ["scripts/generate-contracts.mjs", "--check"], {
        cwd: temporaryRoot,
        encoding: "utf8",
      });
      expect(check.stderr).toBe("");
      expect(check.status).toBe(0);
      expect(existsSync(resolve(isolatedDist, "webhooks/index.js"))).toBe(true);
      expect(
        readFileSync(resolve(temporaryRoot, "contracts/webhooks/captured/typescript-results.json")),
      ).toEqual(readFileSync(resolve(CAPTURED_PATH, "typescript-results.json")));
      expect(
        readFileSync(
          resolve(temporaryRoot, "contracts/webhooks/captured/typescript-results.sha256"),
        ),
      ).toEqual(readFileSync(resolve(CAPTURED_PATH, "typescript-results.sha256")));

      const manifestPath = resolve(temporaryRoot, "contracts/webhooks/captured/manifest.json");
      const isolatedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as JsonRecord;
      const routeCapture = (isolatedManifest.captures as JsonRecord[]).find(
        ({ fixtureId }) => fixtureId === "route-message-routing",
      );
      if (routeCapture === undefined) throw new TypeError("Missing route capture");
      const routeResource = record(routeCapture.signingResource);
      const routeBodyPath = resolve(temporaryRoot, routeCapture.bodyPath as string);
      const originalRouteBody = JSON.parse(readFileSync(routeBodyPath, "utf8")) as JsonRecord;
      const routeKeyFile = readFileSync(resolve(temporaryRoot, routeResource.keyPath as string));
      const routeKey = routeKeyFile.subarray(0, routeKeyFile.length - 1);

      const observeChangedRoute = (body: JsonRecord) => {
        const bodyBytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
        routeCapture.rawBodySha256 = createHash("sha256").update(bodyBytes).digest("hex");
        routeCapture.signature = `v1,${createHmac("sha256", routeKey)
          .update(routeCapture.webhookId as string)
          .update(".")
          .update(routeCapture.webhookTimestamp as string)
          .update(".")
          .update(bodyBytes)
          .digest("base64")}`;
        writeFileSync(routeBodyPath, bodyBytes);
        writeFileSync(manifestPath, `${JSON.stringify(isolatedManifest, null, 2)}\n`);
        const result = spawnSync(process.execPath, ["scripts/run-webhook-fixture-results.mjs"], {
          cwd: temporaryRoot,
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        const observed = JSON.parse(result.stdout) as { results: JsonRecord[] };
        return observed.results.find(({ fixture }) => fixture === routeCapture.fixtureId);
      };

      const withoutRouteId = structuredClone(originalRouteBody);
      delete withoutRouteId.route_id;
      expect(observeChangedRoute(withoutRouteId)).toMatchObject({ result: "invalid" });

      const mismatchedRoute = structuredClone(originalRouteBody);
      mismatchedRoute.route_id = "42f4ac91-55d8-4c73-93ad-0a675d0c324e";
      expect(observeChangedRoute(mismatchedRoute)).toMatchObject({ result: "invalid" });
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

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
    const headerRecordFormat = capturedManifest.headerRecordFormat as string;
    expect(captures).toHaveLength(2);
    expect(headerRecordFormat).toContain("\n");
    expect(headerRecordFormat).not.toContain("\\n");

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

      const headerRecord = headerRecordFormat
        .replaceAll("{webhookId}", capture.webhookId as string)
        .replaceAll("{webhookTimestamp}", capture.webhookTimestamp as string)
        .replaceAll("{signature}", capture.signature as string);
      expect(
        createHash("sha256").update(headerRecord, "utf8").digest("hex"),
        capture.fixtureId as string,
      ).toBe(capture.headersSha256);
      expect(capture.webhookId).toBeTypeOf("string");
      expect(capture.webhookTimestamp).toMatch(/^\d+$/);
      expect(record(capture.provenance).kind).toBe("captured");
      expect(capture.expectedResult).toBe("valid");
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
      validateSignedFixture(changedId, configuredBody, configuredKey, capturedFixtureOptions),
    ).toThrow(/signature mismatch/);

    const changedTimestamp = structuredClone(configuredCapture);
    changedTimestamp.webhookTimestamp = "1784041402";
    expect(() =>
      validateSignedFixture(
        changedTimestamp,
        configuredBody,
        configuredKey,
        capturedFixtureOptions,
      ),
    ).toThrow(/signature mismatch/);

    const reserializedBody = Buffer.from(
      JSON.stringify(JSON.parse(configuredBody.toString("utf8"))),
      "utf8",
    );
    expect(() =>
      validateSignedFixture(
        configuredCapture,
        reserializedBody,
        configuredKey,
        capturedFixtureOptions,
      ),
    ).toThrow(/raw body digest mismatch/);
    expect(() =>
      validateSignedFixture(configuredCapture, configuredBody, routeKey, capturedFixtureOptions),
    ).toThrow(/signing key digest mismatch/);

    const changedKey = Buffer.from(`${configuredKey.toString("utf8").trimEnd()}-changed\n`, "utf8");
    expect(() =>
      validateSignedFixture(configuredCapture, configuredBody, changedKey, capturedFixtureOptions),
    ).toThrow(/signing key digest mismatch/);
  });

  it("rejects header-record and resource/key binding drift independently", () => {
    const capture = structuredClone((capturedManifest.captures as JsonRecord[])[0]!);
    const resource = record(capture.signingResource);
    const body = readFileSync(resolve(process.cwd(), capture.bodyPath as string));
    const key = readFileSync(resolve(process.cwd(), resource.keyPath as string));

    capture.headersSha256 = "0".repeat(64);
    expect(() => validateSignedFixture(capture, body, key, capturedFixtureOptions)).toThrow(
      /signed header record digest mismatch/,
    );

    const changedBinding = structuredClone((capturedManifest.captures as JsonRecord[])[0]!);
    record(changedBinding.signingResource).bindingSha256 = "0".repeat(64);
    expect(() => validateSignedFixture(changedBinding, body, key, capturedFixtureOptions)).toThrow(
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

  it("rejects a captured fixture key copied into a non-UTF-8 file", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ahasend-secret-scan-binary-"));
    try {
      for (const value of secretPolicy.rules as JsonRecord[]) {
        const allowedPath = value.allowedPath as string;
        const destination = resolve(temporaryRoot, allowedPath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(resolve(process.cwd(), allowedPath)));
      }
      const copiedKey = readFileSync(
        resolve(process.cwd(), "contracts/webhooks/captured/keys/configured-webhook.key"),
      );
      writeFileSync(
        resolve(temporaryRoot, "copied-configured-webhook.bin"),
        Buffer.concat([copiedKey, Buffer.from([0xff])]),
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
    expect(fixtures).toHaveLength(4);
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

  it("rejects normalized synthetic paths that escape into captured evidence", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "ahasend-synthetic-containment-"));
    try {
      cpSync(resolve(process.cwd(), "contracts"), resolve(temporaryRoot, "contracts"), {
        recursive: true,
      });
      cpSync(resolve(process.cwd(), "security"), resolve(temporaryRoot, "security"), {
        recursive: true,
      });

      const changedManifest = structuredClone(syntheticManifest);
      const fixture = (changedManifest.fixtures as JsonRecord[])[0]!;
      fixture.keyPath = "contracts/webhooks/synthetic/../captured/keys/configured-webhook.key";
      const keyFile = readFileSync(resolve(temporaryRoot, fixture.keyPath as string));
      const key = keyFile.subarray(0, keyFile.length - 1);
      const body = readFileSync(resolve(temporaryRoot, fixture.bodyPath as string));
      fixture.keySha256 = createHash("sha256").update(key).digest("hex");
      fixture.signature = `v1,${createHmac("sha256", key)
        .update(fixture.webhookId as string)
        .update(".")
        .update(fixture.webhookTimestamp as string)
        .update(".")
        .update(body)
        .digest("base64")}`;
      writeFileSync(
        resolve(temporaryRoot, "contracts/webhooks/synthetic/manifest.json"),
        `${JSON.stringify(changedManifest, null, 2)}\n`,
      );

      await expect(validateWebhookEvidence(temporaryRoot)).rejects.toThrow(
        /must remain in the synthetic fixture tree/,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
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
