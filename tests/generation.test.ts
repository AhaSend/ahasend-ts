import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { digestJsonArtifact } from "../scripts/digest-artifact.mjs";
import { collectOperations, parseOpenApi } from "../scripts/generate-contracts.mjs";
import {
  AUTHORIZATION_REGISTRY,
  dereferenceResponse,
  generateSdkArtifacts,
  validateAuthorizationRegistry,
  validateOperationProfile,
} from "../scripts/generate-sdk.mjs";
import {
  CONTRACT_DIGESTS,
  OPENAPI_SHA256,
  OPERATION_PROFILE_SHA256,
  WEBHOOK_SHA256,
} from "../src/generated/contract-digests.js";
import { OPERATION_DESCRIPTORS, RESOURCE_AUTHORIZATION } from "../src/generated/operations.js";
import { OPERATION_PROFILE } from "../src/generated/operation-profile.js";
import type { components, operations } from "../src/generated/rest-types.js";

type JsonRecord = Record<string, unknown>;
type WireSchemas = components["schemas"];
type WireOperations = operations;

const root = process.cwd();
const openApiSource = readFileSync(resolve(root, "openapi.yaml"), "utf8");
const webhookSource = readFileSync(resolve(root, "webhooks.yaml"), "utf8");
const document = parseOpenApi(openApiSource);
const profilePath = resolve(root, "src/generated/operation-profile.json");
const digestPath = resolve(root, "src/generated/operation-profile.sha256");
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as JsonRecord;

describe("SDK artifact generation", () => {
  it("reproduces every committed artifact byte-for-byte", async () => {
    const artifacts = await generateSdkArtifacts(openApiSource, webhookSource);
    expect(artifacts.size).toBe(8);
    for (const [path, expected] of artifacts) {
      expect(readFileSync(resolve(root, path), "utf8"), path).toBe(expected);
    }

    const check = spawnSync(process.execPath, ["scripts/generate-sdk.mjs", "--check"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });

  it("binds the detached digest to canonical profile JSON without a self-digest", () => {
    const detached = readFileSync(digestPath, "utf8");
    const digest = digestJsonArtifact(profile);

    expect(profile).not.toHaveProperty("digest");
    expect(profile).not.toHaveProperty("sha256");
    expect(detached).toBe(`${digest}\n`);
    expect(OPERATION_PROFILE_SHA256).toBe(digest);
    expect(CONTRACT_DIGESTS).toEqual({
      openapi: OPENAPI_SHA256,
      webhooks: WEBHOOK_SHA256,
      operationProfile: digest,
    });
    expect(OPERATION_PROFILE).toEqual(profile);
  });

  it("pins 68 wire schemas and validates complete profile parity", () => {
    const components = document["components"] as JsonRecord;
    const schemas = components["schemas"] as JsonRecord;

    expect(Object.keys(schemas)).toHaveLength(68);
    expect(() => validateOperationProfile(document, profile)).not.toThrow();
    expect(OPERATION_PROFILE.operations).toHaveLength(56);
    expect(OPERATION_PROFILE.iterators).toHaveLength(9);
  });

  it("preserves inherited required fields in composed wire schemas", () => {
    expectTypeOf<{
      object: "message";
      id: null;
      recipient: { email: string; name: string };
      status: "queued";
      error: null;
    }>().toExtend<WireSchemas["CreateSingleMessageResponse"]>();

    expectTypeOf<{
      billing_period: { start: string; end: string };
      currency: string;
      allocation_method: "proportional";
      allocation_note: string;
      parent: {
        account_id: string;
        reception_count: number;
        allocated_cost: number;
      };
      sub_accounts: Array<{
        account_id: string;
        name: string;
        reception_count: number;
        allocated_cost: number;
      }>;
      removed_sub_accounts: { reception_count: number; allocated_cost: number };
      total: { reception_count: number; allocated_cost: number };
    }>().toExtend<WireSchemas["SubAccountUsageResponse"]>();
  });

  it("requires domains for scoped webhook and SMTP credential requests", () => {
    expectTypeOf<{
      name: string;
      url: string;
      scope: "scoped";
    }>().not.toExtend<WireSchemas["CreateWebhookRequest"]>();
    expectTypeOf<{
      name: string;
      url: string;
      scope: "scoped";
      domains: string[];
    }>().toExtend<WireSchemas["CreateWebhookRequest"]>();
    expectTypeOf<{
      name: string;
      url: string;
      scope: "global";
    }>().toExtend<WireSchemas["CreateWebhookRequest"]>();

    expectTypeOf<{
      name: string;
      scope: "scoped";
    }>().not.toExtend<WireSchemas["CreateSMTPCredentialRequest"]>();
    expectTypeOf<{
      name: string;
      scope: "scoped";
      domains: string[];
    }>().toExtend<WireSchemas["CreateSMTPCredentialRequest"]>();
    expectTypeOf<{
      name: string;
      scope: "global";
    }>().toExtend<WireSchemas["CreateSMTPCredentialRequest"]>();
  });

  it("generates JSON bodies for referenced 409 and 422 operation responses", () => {
    expectTypeOf<WireOperations["createAPIKey"]["responses"]["409"]["content"]>().toEqualTypeOf<{
      "application/json": WireSchemas["ErrorResponse"];
    }>();
    expectTypeOf<WireOperations["createAPIKey"]["responses"]["422"]["content"]>().toEqualTypeOf<{
      "application/json": WireSchemas["ErrorResponse"];
    }>();
  });

  it("rejects cycles while traversing component response references", () => {
    const cyclicDocument = {
      components: {
        responses: {
          First: { $ref: "#/components/responses/Second" },
          Second: { $ref: "#/components/responses/First" },
        },
      },
    };

    expect(() =>
      dereferenceResponse(cyclicDocument, {
        $ref: "#/components/responses/First",
      }),
    ).toThrow(/Circular response reference "#\/components\/responses\/First"/);
  });

  it("emits the eight closed resource-authorization rule shapes", () => {
    expect(() => validateAuthorizationRegistry(document)).not.toThrow();
    expect(RESOURCE_AUTHORIZATION).toEqual(AUTHORIZATION_REGISTRY);
    expect(new Set(Object.values(RESOURCE_AUTHORIZATION).map(({ kind }) => kind))).toEqual(
      new Set([
        "body_domain",
        "query_domain_required_for_scoped",
        "existing_and_replacement_domain",
        "all_body_domains",
        "existing_and_new_domains",
        "comma_separated_query_domains",
        "authorized_domain_filter",
        "existing_resource_domains",
      ]),
    );

    expect(OPERATION_DESCRIPTORS.createMessage.resourceAuthorization).toMatchObject({
      kind: "body_domain",
      bodyPath: "from.email",
      quantifier: "one",
      roles: {
        global: "messages:send:all",
        domain: "messages:send:{domain}",
      },
    });
    expect(OPERATION_DESCRIPTORS.updateWebhook.resourceAuthorization).toMatchObject({
      kind: "existing_and_new_domains",
      scopeBodyPath: "scope",
      globalValue: "global",
      quantifier: "every",
      transition: "global_scope_requires_global_role",
    });
    expect(OPERATION_DESCRIPTORS.getBounceStatistics.resourceAuthorization).toMatchObject({
      kind: "comma_separated_query_domains",
      queryParameter: "sender_domain",
      quantifier: "every",
    });
  });

  it("rejects invalid profile and authorization registry entries", () => {
    const brokenProfile = structuredClone(profile) as {
      operations: JsonRecord[];
      iterators: JsonRecord[];
    };
    brokenProfile.operations[0] = brokenProfile.operations[1]!;
    expect(() => validateOperationProfile(document, brokenProfile)).toThrow(/parity failure/);

    const brokenRegistry = structuredClone(AUTHORIZATION_REGISTRY) as Record<string, JsonRecord>;
    brokenRegistry["createMessage"]!["bodyPath"] = "missing.field";
    expect(() => validateAuthorizationRegistry(document, brokenRegistry)).toThrow(
      /body field|properties containing/,
    );

    const brokenSecurityDocument = structuredClone(document);
    const createMessage = collectOperations(brokenSecurityDocument).find(
      ({ operationId }) => operationId === "createMessage",
    );
    expect(createMessage).toBeDefined();
    createMessage!.operation.security = [
      { BearerAuth: ["messages:send:all", "messages:send:{domain}"] },
      { BearerAuth: [] },
    ];
    expect(() => validateAuthorizationRegistry(brokenSecurityDocument)).toThrow(
      /singleton BearerAuth requirements/,
    );
  });
});
