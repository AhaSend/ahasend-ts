import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digestJsonArtifact } from "../scripts/digest-artifact.mjs";
import { parseOpenApi } from "../scripts/generate-contracts.mjs";
import {
  AUTHORIZATION_REGISTRY,
  generateSdkArtifacts,
  validateAuthorizationRegistry,
  validateOperationProfile,
} from "../scripts/generate-sdk.mjs";
import {
  CONTRACT_DIGESTS,
  OPENAPI_SHA256,
  OPERATION_PROFILE_SHA256,
} from "../src/generated/contract-digests.js";
import { OPERATION_DESCRIPTORS, RESOURCE_AUTHORIZATION } from "../src/generated/operations.js";
import { OPERATION_PROFILE } from "../src/generated/operation-profile.js";

type JsonRecord = Record<string, unknown>;

const root = process.cwd();
const openApiSource = readFileSync(resolve(root, "openapi.yaml"), "utf8");
const document = parseOpenApi(openApiSource);
const profilePath = resolve(root, "src/generated/operation-profile.json");
const digestPath = resolve(root, "src/generated/operation-profile.sha256");
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as JsonRecord;

describe("SDK artifact generation", () => {
  it("reproduces every committed artifact byte-for-byte", async () => {
    const artifacts = await generateSdkArtifacts(openApiSource);
    expect(artifacts.size).toBe(6);
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

    expect(OPERATION_DESCRIPTORS.createMessage.resourceAuthorization).toEqual({
      kind: "body_domain",
      bodyPath: "from.email",
    });
    expect(OPERATION_DESCRIPTORS.updateWebhook.resourceAuthorization).toMatchObject({
      kind: "existing_and_new_domains",
      scopeBodyPath: "scope",
      globalValue: "global",
    });
    expect(OPERATION_DESCRIPTORS.getBounceStatistics.resourceAuthorization).toEqual({
      kind: "comma_separated_query_domains",
      queryParameter: "sender_domain",
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
  });
});
