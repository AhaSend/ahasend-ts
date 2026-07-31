import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import {
  collectOperations,
  parseOpenApi,
  type ContractOperation,
  type OpenApiRecord,
} from "../scripts/generate-contracts.mjs";

type JsonRecord = Record<string, unknown>;

interface ComponentCase {
  id: string;
  schema: string;
  valid: boolean;
  value: JsonRecord;
}

interface ResponseCase {
  operationId: string;
  status: string;
  payload: string;
  valid: boolean;
}

interface RestContractFixture {
  payloads: Record<string, JsonRecord>;
  componentCases: ComponentCase[];
  apiKeySecrets: {
    creationOperations: string[];
    nonCreationOperations: string[];
    responseCases: ResponseCase[];
  };
  authorizationAlternatives: Record<string, string[]>;
}

const root = process.cwd();
const document = parseOpenApi(readFileSync(resolve(root, "openapi.yaml"), "utf8"));
const fixture = JSON.parse(
  readFileSync(resolve(root, "tests/fixtures/rest-contract.json"), "utf8"),
) as RestContractFixture;
const operations = collectOperations(document);
const documentSchemaId = "https://contracts.ahasend.test/openapi.yaml";

function record(value: unknown, location: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`);
  }
  return value as JsonRecord;
}

function operation(operationId: string): ContractOperation {
  const match = operations.find((candidate) => candidate.operationId === operationId);
  if (match === undefined) throw new TypeError(`Unknown fixture operation ${operationId}`);
  return match;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function schemaValidator(): Ajv.Ajv {
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    schemaId: "auto",
    unknownFormats: "ignore",
  });
  const components = record(document.components, "OpenAPI components");
  ajv.addSchema({
    $id: documentSchemaId,
    components,
    paths: document.paths,
  });
  return ajv;
}

function componentValidator(ajv: Ajv.Ajv, name: string): ValidateFunction {
  return ajv.compile({
    $ref: `${documentSchemaId}#/components/schemas/${pointerSegment(name)}`,
  });
}

function responseValidator(ajv: Ajv.Ajv, operationId: string, status: string): ValidateFunction {
  const entry = operation(operationId);
  const pointer = [
    "paths",
    entry.path,
    entry.method,
    "responses",
    status,
    "content",
    "application/json",
    "schema",
  ]
    .map(pointerSegment)
    .join("/");
  return ajv.compile({ $ref: `${documentSchemaId}#/${pointer}` });
}

function responseSchema(operationId: string, status: string): OpenApiRecord {
  const responses = record(operation(operationId).operation.responses, `${operationId} responses`);
  const response = record(responses[status], `${operationId} ${status} response`);
  const content = record(response.content, `${operationId} ${status} content`);
  const mediaType = record(content["application/json"], `${operationId} ${status} JSON content`);
  return record(mediaType.schema, `${operationId} ${status} schema`);
}

function dereference(schema: OpenApiRecord): OpenApiRecord {
  const reference = schema.$ref;
  if (typeof reference !== "string") return schema;
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) {
    throw new TypeError(`Unsupported fixture reference ${reference}`);
  }
  const schemas = record(record(document.components, "OpenAPI components").schemas, "schemas");
  return record(schemas[reference.slice(prefix.length)], reference);
}

function declaresProperty(
  schema: OpenApiRecord,
  property: string,
  visitedReferences = new Set<string>(),
): boolean {
  const reference = schema.$ref;
  if (typeof reference === "string") {
    if (visitedReferences.has(reference)) return false;
    visitedReferences.add(reference);
  }
  const resolved = dereference(schema);
  const properties =
    resolved.properties === undefined
      ? undefined
      : record(resolved.properties, "schema properties");
  if (properties !== undefined && Object.hasOwn(properties, property)) return true;
  if (
    properties !== undefined &&
    Object.values(properties).some((child) =>
      declaresProperty(record(child, "schema property"), property, visitedReferences),
    )
  ) {
    return true;
  }
  if (
    resolved.items !== undefined &&
    declaresProperty(record(resolved.items, "schema items"), property, visitedReferences)
  ) {
    return true;
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = resolved[keyword];
    if (
      Array.isArray(branches) &&
      branches.some((branch) =>
        declaresProperty(record(branch, keyword), property, visitedReferences),
      )
    ) {
      return true;
    }
  }
  return false;
}

function requiresProperty(schema: OpenApiRecord, property: string): boolean {
  const resolved = dereference(schema);
  if (Array.isArray(resolved.required) && resolved.required.includes(property)) return true;
  const allOf = resolved.allOf;
  return (
    Array.isArray(allOf) &&
    allOf.some((branch) => requiresProperty(record(branch, "allOf"), property))
  );
}

describe("REST schema golden contracts", () => {
  it("validates required-nullable, optional-non-null, IP-list, and domain cases", () => {
    const ajv = schemaValidator();

    for (const testCase of fixture.componentCases) {
      const validate = componentValidator(ajv, testCase.schema);
      expect(validate(testCase.value), `${testCase.id}: ${ajv.errorsText(validate.errors)}`).toBe(
        testCase.valid,
      );
    }
  });

  it("keeps omitted properties distinct from explicit null values", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const requiredNullable = byId["required-nullable-present-null-canary"]!;
    const requiredNullableOmitted = byId["required-nullable-omitted"]!;
    const optionalNonNullOmitted = byId["optional-non-null-omitted"]!;
    const optionalNonNullNull = byId["optional-non-null-null"]!;

    expect(requiredNullable.value).toHaveProperty("last_used_at", null);
    expect(Object.hasOwn(requiredNullableOmitted.value, "last_used_at")).toBe(false);
    expect(Object.hasOwn(optionalNonNullOmitted.value, "tracking_subdomain")).toBe(false);
    expect(optionalNonNullNull.value).toHaveProperty("tracking_subdomain", null);
    expect([
      requiredNullable.valid,
      requiredNullableOmitted.valid,
      optionalNonNullOmitted.valid,
      optionalNonNullNull.valid,
    ]).toEqual([true, false, true, false]);
  });

  it("enforces Account response requiredness and nullability", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const complete = byId["account-complete-parent-null"]!;
    const missingWebsite = byId["account-required-website-omitted"]!;
    const nullAbout = byId["account-non-null-about-null"]!;
    const ajv = schemaValidator();

    expect(componentValidator(ajv, complete.schema)(complete.value)).toBe(true);
    expect(componentValidator(ajv, missingWebsite.schema)(missingWebsite.value)).toBe(false);
    expect(componentValidator(ajv, nullAbout.schema)(nullAbout.value)).toBe(false);
  });

  it("enforces Domain and DNSRecord response requiredness and nullability", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const completeDomain = byId["domain-complete-nullable-fields-null"]!;
    const missingLastDnsCheck = byId["domain-required-last-dns-check-omitted"]!;
    const nullRotationReady = byId["domain-non-null-rotation-ready-null"]!;
    const recordWithoutLabel = byId["dns-record-optional-label-omitted"]!;
    const recordWithNullLabel = byId["dns-record-non-null-label-null"]!;
    const ajv = schemaValidator();

    expect(componentValidator(ajv, completeDomain.schema)(completeDomain.value)).toBe(true);
    expect(componentValidator(ajv, missingLastDnsCheck.schema)(missingLastDnsCheck.value)).toBe(
      false,
    );
    expect(componentValidator(ajv, nullRotationReady.schema)(nullRotationReady.value)).toBe(false);
    expect(componentValidator(ajv, recordWithoutLabel.schema)(recordWithoutLabel.value)).toBe(true);
    expect(componentValidator(ajv, recordWithNullLabel.schema)(recordWithNullLabel.value)).toBe(
      false,
    );
  });

  it("enforces Route response requiredness and update nullability", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const complete = byId["route-complete-last-request-null"]!;
    const missingSuccessCount = byId["route-required-success-count-omitted"]!;
    const nullRecipient = byId["route-non-null-recipient-null"]!;
    const nullableUpdate = byId["route-update-all-nullable-fields"]!;
    const ajv = schemaValidator();

    expect(componentValidator(ajv, complete.schema)(complete.value)).toBe(true);
    expect(componentValidator(ajv, missingSuccessCount.schema)(missingSuccessCount.value)).toBe(
      false,
    );
    expect(componentValidator(ajv, nullRecipient.schema)(nullRecipient.value)).toBe(false);
    expect(componentValidator(ajv, nullableUpdate.schema)(nullableUpdate.value)).toBe(true);
  });

  it("enforces non-empty arrays where the authoritative schema declares minItems one", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const nonEmpty = byId["api-key-scopes-non-empty"]!;
    const empty = byId["api-key-scopes-empty"]!;
    const ajv = schemaValidator();

    expect(componentValidator(ajv, nonEmpty.schema)(nonEmpty.value)).toBe(true);
    expect(componentValidator(ajv, empty.schema)(empty.value)).toBe(false);
  });

  it("enforces inherited properties in required-only allOf overlays", () => {
    const byId = Object.fromEntries(
      fixture.componentCases.map((testCase) => [testCase.id, testCase]),
    );
    const valid = byId["message-recipient-inherited-name"]!;
    const missing = byId["message-recipient-inherited-name-omitted"]!;
    const wrongType = byId["message-recipient-inherited-name-wrong-type"]!;
    const ajv = schemaValidator();

    expect(componentValidator(ajv, valid.schema)(valid.value)).toBe(true);
    expect(componentValidator(ajv, missing.schema)(missing.value)).toBe(false);
    expect(componentValidator(ajv, wrongType.schema)(wrongType.value)).toBe(false);
  });

  it("requires one-time API-key secrets only on both creation responses", () => {
    const ajv = schemaValidator();

    expect(fixture.apiKeySecrets.creationOperations).toHaveLength(2);
    for (const operationId of fixture.apiKeySecrets.creationOperations) {
      const schema = responseSchema(operationId, "201");
      expect(declaresProperty(schema, "secret_key"), operationId).toBe(true);
      expect(requiresProperty(schema, "secret_key"), operationId).toBe(true);
    }
    expect(fixture.apiKeySecrets.nonCreationOperations).toHaveLength(6);
    for (const operationId of fixture.apiKeySecrets.nonCreationOperations) {
      expect(declaresProperty(responseSchema(operationId, "200"), "secret_key"), operationId).toBe(
        false,
      );
    }
    for (const testCase of fixture.apiKeySecrets.responseCases) {
      const payload = fixture.payloads[testCase.payload];
      if (payload === undefined) throw new TypeError(`Unknown fixture payload ${testCase.payload}`);
      const validate = responseValidator(ajv, testCase.operationId, testCase.status);
      expect(
        validate(payload),
        `${testCase.operationId} ${testCase.status}: ${ajv.errorsText(validate.errors)}`,
      ).toBe(testCase.valid);
    }
  });

  it("pins all 23 standard authorization alternatives as independent OR branches", () => {
    expect(Object.keys(fixture.authorizationAlternatives)).toHaveLength(23);

    const actual = Object.fromEntries(
      operations
        .filter(({ operation: specOperation }) => {
          const security = specOperation.security;
          return Array.isArray(security) && security.length > 1;
        })
        .map(({ operationId, operation: specOperation }) => {
          const security = specOperation.security as JsonRecord[];
          const roles = security.map((requirement) => {
            expect(Object.keys(requirement), operationId).toEqual(["BearerAuth"]);
            const roleList = requirement.BearerAuth;
            expect(roleList, operationId).toHaveLength(1);
            return (roleList as string[])[0]!;
          });
          return [operationId, roles];
        }),
    );

    expect(actual).toEqual(fixture.authorizationAlternatives);
  });

  it("actively rejects the invalid OpenAPI 3.1 nullable-union and conditional canaries", () => {
    expect(document.openapi).toBe("3.1.0");
    const canaries = fixture.componentCases.filter(({ id }) => id.endsWith("-canary"));
    expect(canaries.some(({ valid }) => valid)).toBe(true);
    expect(canaries.some(({ valid }) => !valid)).toBe(true);

    const ajv = schemaValidator();
    for (const canary of canaries) {
      const validate = componentValidator(ajv, canary.schema);
      expect(validate(canary.value), `${canary.id}: ${ajv.errorsText(validate.errors)}`).toBe(
        canary.valid,
      );
    }
  });
});
