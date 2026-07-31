import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

type JsonRecord = Record<string, unknown>;

const document = record(
  yaml.load(readFileSync(resolve(process.cwd(), "openapi.yaml"), "utf8")),
  "OpenAPI document",
);

function record(value: unknown, location: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${location} must be an object`);
  }
  return value as JsonRecord;
}

function schema(name: string): JsonRecord {
  const components = record(document.components, "OpenAPI components");
  const schemas = record(components.schemas, "OpenAPI schemas");
  return record(schemas[name], `OpenAPI schema ${name}`);
}

function properties(name: string): JsonRecord {
  return record(schema(name).properties, `${name} properties`);
}

function property(schemaName: string, propertyName: string): JsonRecord {
  return record(properties(schemaName)[propertyName], `${schemaName}.${propertyName}`);
}

function nullableProperties(schemaName: string): string[] {
  return Object.entries(properties(schemaName))
    .filter(([, value]) => {
      const type = record(value, `${schemaName} property`).type;
      return Array.isArray(type) && type.includes("null");
    })
    .map(([name]) => name);
}

describe("authoritative OpenAPI model contracts", () => {
  it("pins curated response requiredness and nullability", () => {
    expect(schema("Account").required).toEqual([
      "object",
      "id",
      "parent_account_id",
      "created_at",
      "updated_at",
      "name",
      "website",
      "about",
      "track_opens",
      "track_clicks",
      "reject_bad_recipients",
      "reject_mistyped_recipients",
      "message_metadata_retention",
      "message_data_retention",
      "owner_id",
    ]);
    expect(nullableProperties("Account")).toEqual(["parent_account_id"]);

    expect(schema("DNSRecord").required).toEqual([
      "type",
      "host",
      "content",
      "required",
      "propagated",
    ]);
    expect(nullableProperties("DNSRecord")).toEqual([]);

    expect(schema("Domain").required).toEqual([
      "object",
      "id",
      "created_at",
      "updated_at",
      "domain",
      "account_id",
      "dns_records",
      "last_dns_check_at",
      "dns_valid",
      "tracking_subdomain",
      "return_path_subdomain",
      "subscription_subdomain",
      "media_subdomain",
      "dkim_rotation_interval_days",
      "dkim_selector",
      "rotation_ready",
      "dsn_recipient",
    ]);
    expect(nullableProperties("Domain")).toEqual([
      "last_dns_check_at",
      "tracking_subdomain",
      "return_path_subdomain",
      "subscription_subdomain",
      "media_subdomain",
      "dkim_rotation_interval_days",
      "dkim_selector",
      "dsn_recipient",
    ]);

    expect(schema("Route").required).toEqual([
      "object",
      "id",
      "created_at",
      "updated_at",
      "name",
      "url",
      "recipient",
      "attachments",
      "headers",
      "group_by_message_id",
      "strip_replies",
      "enabled",
      "success_count",
      "error_count",
      "errors_since_last_success",
      "last_request_at",
    ]);
    expect(nullableProperties("Route")).toEqual(["last_request_at"]);
  });

  it("pins nullable Route update fields without weakening the response", () => {
    expect(schema("UpdateRouteRequest").required).toBeUndefined();
    expect(nullableProperties("UpdateRouteRequest")).toEqual([
      "name",
      "url",
      "recipient",
      "attachments",
      "headers",
      "group_by_message_id",
      "strip_replies",
      "enabled",
    ]);
  });

  it("distinguishes create and update DKIM selector semantics", () => {
    const createSelector = property("CreateDomainRequest", "dkim_selector");
    const updateSelector = property("UpdateDomainRequest", "dkim_selector");

    expect(schema("CreateDomainRequest").required).toEqual(["domain"]);
    expect(createSelector.type).toEqual(["string", "null"]);
    expect(createSelector.description).toContain(
      "Omit, send null, or send an empty or whitespace-only string to use the default selector (no per-domain override)",
    );
    expect(schema("UpdateDomainRequest").required).toBeUndefined();
    expect(updateSelector.type).toEqual(["string", "null"]);
    expect(updateSelector.description).toContain(
      "Omit or send null to leave the current value unchanged",
    );
    expect(updateSelector.description).toContain(
      "send an empty or whitespace-only string to clear the override",
    );
  });

  it("pins API-key non-empty scope arrays and non-null update alternatives", () => {
    expect(schema("CreateAPIKeyRequest").required).toEqual(["label", "scopes"]);
    expect(property("CreateAPIKeyRequest", "scopes")).toMatchObject({
      type: "array",
      minItems: 1,
    });
    expect(property("UpdateAPIKeyRequest", "scopes")).toMatchObject({
      type: ["array", "null"],
      minItems: 1,
    });
    expect(schema("UpdateAPIKeyRequest").anyOf).toEqual([
      { required: ["label"], properties: { label: { type: "string" } } },
      { required: ["scopes"], properties: { scopes: { type: "array" } } },
      { required: ["ip_allow_list"], properties: { ip_allow_list: { type: "array" } } },
    ]);
  });

  it("keeps pagination cursors optional and non-null when present", () => {
    expect(schema("PaginationInfo").required).toEqual(["has_more"]);
    expect(Object.keys(properties("PaginationInfo"))).toEqual([
      "has_more",
      "next_cursor",
      "previous_cursor",
    ]);
    expect(property("PaginationInfo", "next_cursor").type).toBe("string");
    expect(property("PaginationInfo", "previous_cursor").type).toBe("string");
  });

  it("keeps ErrorResponse closed to its required message", () => {
    expect(schema("ErrorResponse").additionalProperties).toBe(false);
    expect(schema("ErrorResponse").required).toEqual(["message"]);
    expect(Object.keys(properties("ErrorResponse"))).toEqual(["message"]);
    expect(property("ErrorResponse", "message").type).toBe("string");
  });
});
