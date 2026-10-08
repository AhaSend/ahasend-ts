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
      "sending_type",
      "paused",
      "paused_at",
      "pause_reason",
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
      "paused_at",
      "pause_reason",
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

  it("pins the transactional template read models", () => {
    expect(schema("TemplateVariable").required).toEqual(["name", "required"]);
    expect(Object.keys(properties("TemplateVariable"))).toEqual(["name", "required"]);
    expect(property("TemplateVariable", "required").type).toBe("boolean");

    expect(schema("Template").required).toEqual([
      "object",
      "id",
      "created_at",
      "updated_at",
      "name",
      "subject",
      "preheader",
      "variables",
      "from",
      "reply_to",
      "editor",
      "has_draft",
    ]);
    // List items leave `content` out, so it is the one optional field.
    expect(Object.keys(properties("Template"))).toEqual([
      ...(schema("Template").required as string[]),
      "content",
    ]);
    expect(nullableProperties("Template")).toEqual([]);
    expect(property("Template", "editor").$ref).toBe("#/components/schemas/TemplateEditor");
    expect(schema("TemplateEditor").enum).toEqual(["advanced", "simple", "html"]);
    expect(property("Template", "content").oneOf).toEqual([
      { $ref: "#/components/schemas/TemplateContent" },
      { type: "null" },
    ]);
    expect(schema("TemplateContent").required).toEqual(["text_is_custom"]);
    expect(Object.keys(properties("TemplateContent"))).toEqual([
      "mjml",
      "html",
      "text",
      "text_is_custom",
    ]);
    expect(property("Template", "object").enum).toEqual(["template"]);
    expect(property("Template", "variables")).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/TemplateVariable" },
    });
    // A template without a default sender reads as a null `from` and a null `reply_to`,
    // and both take the shape of a send's address fields.
    expect(property("Template", "from").oneOf).toEqual([
      { $ref: "#/components/schemas/Address" },
      { type: "null" },
    ]);
    expect(property("Template", "reply_to").oneOf).toEqual([
      { $ref: "#/components/schemas/Address" },
      { type: "null" },
    ]);

    expect(schema("MessageSummary").required).toContain("template_id");
    expect(property("MessageSummary", "template_id")).toMatchObject({
      type: ["string", "null"],
      format: "uuid",
    });

    expect(schema("PaginatedTemplatesResponse").required).toEqual(["object", "data", "pagination"]);
    expect(property("PaginatedTemplatesResponse", "data")).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/Template" },
    });
  });

  it("pins the template draft, version and write models", () => {
    expect(schema("TemplateDraft").required).toEqual([
      "object",
      "template_id",
      "updated_at",
      "subject",
      "preheader",
      "variables",
      "from",
      "reply_to",
      "content",
    ]);
    expect(schema("TemplateVersion").required).toEqual([
      "object",
      "id",
      "version",
      "published_at",
      "published_by",
    ]);
    expect(property("TemplateVersion", "published_by").oneOf).toEqual([
      { $ref: "#/components/schemas/TemplatePublisher" },
      { type: "null" },
    ]);
    expect(property("TemplatePublisher", "type").enum).toEqual(["user", "api_key"]);
    expect(schema("TemplateVersionsResponse").required).toEqual(["object", "data"]);
    expect(properties("TemplateVersionsResponse")).not.toHaveProperty("pagination");

    // An update tells a missing field from null: null clears these fields.
    expect(nullableProperties("UpdateTemplateRequest")).toEqual(["subject", "preheader"]);
    for (const field of ["from", "reply_to"]) {
      expect(property("UpdateTemplateRequest", field).oneOf).toEqual([
        { $ref: "#/components/schemas/TemplateAddressInput" },
        { type: "null" },
      ]);
    }
    expect(property("UpdateTemplateRequest", "content").$ref).toBe(
      "#/components/schemas/TemplateContentInput",
    );
    expect(properties("UpdateTemplateRequest")).not.toHaveProperty("editor");
    expect(schema("CreateTemplateRequest").required).toEqual(["name"]);
    expect(nullableProperties("TemplateContentInput")).toEqual(["text"]);
    expect(schema("RestoreTemplateVersionRequest").required).toBeUndefined();
    expect(Object.keys(properties("RestoreTemplateVersionRequest"))).toEqual(["publish"]);
  });

  it("gives template sends a request schema of their own", () => {
    // The inline send requires its sender and subject and names no template;
    // the template send requires only the template and the recipients.
    expect(schema("CreateMessageRequest").required).toEqual(["from", "recipients", "subject"]);
    expect(property("CreateMessageRequest", "from").$ref).toBe("#/components/schemas/Address");
    expect(properties("CreateMessageRequest")).not.toHaveProperty("template_id");

    expect(schema("CreateTemplateMessageRequest").required).toEqual(["template_id", "recipients"]);
    expect(property("CreateTemplateMessageRequest", "template_id")).toMatchObject({
      type: "string",
      format: "uuid",
    });
    expect(property("CreateTemplateMessageRequest", "from").$ref).toBe(
      "#/components/schemas/Address",
    );
    expect(Object.keys(properties("CreateTemplateMessageRequest"))).toEqual([
      "template_id",
      "from",
      "recipients",
      "reply_to",
      "subject",
      "attachments",
      "headers",
      "tags",
      "sandbox",
      "sandbox_result",
      "tracking",
      "retention",
      "schedule",
    ]);

    expect(schema("CreateConversationMessageRequest").required).toEqual(["from", "to", "subject"]);
    expect(properties("CreateConversationMessageRequest")).not.toHaveProperty("template_id");
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
