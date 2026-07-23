import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseOpenApi } from "../scripts/generate-contracts.mjs";
import { validateAuthorizationRegistry } from "../scripts/generate-sdk.mjs";
import type { ResourceAuthorizationRule } from "../src/generated/operations.js";
import { OPERATION_DESCRIPTORS, RESOURCE_AUTHORIZATION } from "../src/generated/operations.js";

type AuthorizationRegistry = Readonly<Record<string, ResourceAuthorizationRule>>;
type MutableRegistry = Record<string, Record<string, unknown>>;

const STANDARD_SECURITY_PAIRS = {
  deleteDomain: ["domains:delete:all", "domains:delete:{domain}"],
  getMessages: ["messages:read:all", "messages:read:{domain}"],
  createMessage: ["messages:send:all", "messages:send:{domain}"],
  createConversationMessage: ["messages:send:all", "messages:send:{domain}"],
  getMessage: ["messages:read:all", "messages:read:{domain}"],
  cancelMessage: ["messages:cancel:all", "messages:cancel:{domain}"],
  getRoutes: ["routes:read:all", "routes:read:{domain}"],
  createRoute: ["routes:write:all", "routes:write:{domain}"],
  getRoute: ["routes:read:all", "routes:read:{domain}"],
  updateRoute: ["routes:write:all", "routes:write:{domain}"],
  deleteRoute: ["routes:delete:all", "routes:delete:{domain}"],
  getWebhooks: ["webhooks:read:all", "webhooks:read:{domain}"],
  createWebhook: ["webhooks:write:all", "webhooks:write:{domain}"],
  getWebhook: ["webhooks:read:all", "webhooks:read:{domain}"],
  updateWebhook: ["webhooks:write:all", "webhooks:write:{domain}"],
  deleteWebhook: ["webhooks:delete:all", "webhooks:delete:{domain}"],
  getSMTPCredentials: ["smtp-credentials:read:all", "smtp-credentials:read:{domain}"],
  createSMTPCredential: ["smtp-credentials:write:all", "smtp-credentials:write:{domain}"],
  getSMTPCredential: ["smtp-credentials:read:all", "smtp-credentials:read:{domain}"],
  deleteSMTPCredential: ["smtp-credentials:delete:all", "smtp-credentials:delete:{domain}"],
  getDeliverabilityStatistics: [
    "statistics-transactional:read:all",
    "statistics-transactional:read:{domain}",
  ],
  getBounceStatistics: [
    "statistics-transactional:read:all",
    "statistics-transactional:read:{domain}",
  ],
  getDeliveryTimeStatistics: [
    "statistics-transactional:read:all",
    "statistics-transactional:read:{domain}",
  ],
} as const;

const EXPECTED_AUTHORIZATION = {
  createMessage: {
    kind: "body_domain",
    bodyPath: "from.email",
    quantifier: "one",
    roles: { global: "messages:send:all", domain: "messages:send:{domain}" },
    summary:
      "Authorization requires `messages:send:all` or `messages:send:{domain}` matching the domain in `from.email`.",
  },
  createConversationMessage: {
    kind: "body_domain",
    bodyPath: "from.email",
    quantifier: "one",
    roles: { global: "messages:send:all", domain: "messages:send:{domain}" },
    summary:
      "Authorization requires `messages:send:all` or `messages:send:{domain}` matching the domain in `from.email`.",
  },
  createRoute: {
    kind: "body_domain",
    bodyPath: "recipient",
    quantifier: "one",
    roles: { global: "routes:write:all", domain: "routes:write:{domain}" },
    summary:
      "Authorization requires `routes:write:all` or `routes:write:{domain}` matching the domain in `recipient`.",
  },
  getRoutes: {
    kind: "query_domain_required_for_scoped",
    queryParameter: "domain",
    condition: "scoped_role_requires_filter",
    roles: { global: "routes:read:all", domain: "routes:read:{domain}" },
    summary:
      "Authorization requires `routes:read:all`, or `routes:read:{domain}` with its matching `domain` query filter.",
  },
  updateRoute: {
    kind: "existing_and_replacement_domain",
    resource: "route",
    resourceIdParameter: "route_id",
    existingPath: "recipient",
    replacementBodyPath: "recipient",
    quantifier: "every",
    roles: { global: "routes:write:all", domain: "routes:write:{domain}" },
    summary:
      "Authorization requires `routes:write:all`, or `routes:write:{domain}` for both the existing and replacement `recipient` domains.",
  },
  createWebhook: {
    kind: "all_body_domains",
    bodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    condition: "global_scope_requires_global_role",
    roles: { global: "webhooks:write:all", domain: "webhooks:write:{domain}" },
    summary:
      'A `scoped` webhook requires `webhooks:write:{domain}` for every `domains` entry; `scope: "global"` requires `webhooks:write:all`.',
  },
  createSMTPCredential: {
    kind: "all_body_domains",
    bodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    condition: "global_scope_requires_global_role",
    roles: {
      global: "smtp-credentials:write:all",
      domain: "smtp-credentials:write:{domain}",
    },
    summary:
      'A `scoped` SMTP credential requires `smtp-credentials:write:{domain}` for every `domains` entry; `scope: "global"` requires `smtp-credentials:write:all`.',
  },
  updateWebhook: {
    kind: "existing_and_new_domains",
    resource: "webhook",
    resourceIdParameter: "webhook_id",
    existingPath: "domains",
    newBodyPath: "domains",
    scopeBodyPath: "scope",
    globalValue: "global",
    quantifier: "every",
    transition: "global_scope_requires_global_role",
    roles: { global: "webhooks:write:all", domain: "webhooks:write:{domain}" },
    summary:
      "Authorization requires `webhooks:write:{domain}` for the existing webhook and every new `domains` entry; changing `scope` to `global` requires `webhooks:write:all`.",
  },
  getDeliverabilityStatistics: {
    kind: "comma_separated_query_domains",
    queryParameter: "sender_domain",
    quantifier: "every",
    roles: {
      global: "statistics-transactional:read:all",
      domain: "statistics-transactional:read:{domain}",
    },
    summary:
      "Authorization requires `statistics-transactional:read:all` or `statistics-transactional:read:{domain}` for every comma-separated `sender_domain` value.",
  },
  getBounceStatistics: {
    kind: "comma_separated_query_domains",
    queryParameter: "sender_domain",
    quantifier: "every",
    roles: {
      global: "statistics-transactional:read:all",
      domain: "statistics-transactional:read:{domain}",
    },
    summary:
      "Authorization requires `statistics-transactional:read:all` or `statistics-transactional:read:{domain}` for every comma-separated `sender_domain` value.",
  },
  getDeliveryTimeStatistics: {
    kind: "comma_separated_query_domains",
    queryParameter: "sender_domain",
    quantifier: "every",
    roles: {
      global: "statistics-transactional:read:all",
      domain: "statistics-transactional:read:{domain}",
    },
    summary:
      "Authorization requires `statistics-transactional:read:all` or `statistics-transactional:read:{domain}` for every comma-separated `sender_domain` value.",
  },
  getMessages: {
    kind: "authorized_domain_filter",
    resource: "message",
    resourceDomainPath: "sender",
    quantifier: "one",
    roles: { global: "messages:read:all", domain: "messages:read:{domain}" },
    summary:
      "`messages:read:all` returns every message; `messages:read:{domain}` returns only messages whose `sender` domain is authorized.",
  },
  getWebhooks: {
    kind: "authorized_domain_filter",
    resource: "webhook",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: { global: "webhooks:read:all", domain: "webhooks:read:{domain}" },
    summary:
      "`webhooks:read:all` returns every webhook; `webhooks:read:{domain}` returns only webhooks with at least one authorized `domains` entry.",
  },
  getSMTPCredentials: {
    kind: "authorized_domain_filter",
    resource: "smtp_credential",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: {
      global: "smtp-credentials:read:all",
      domain: "smtp-credentials:read:{domain}",
    },
    summary:
      "`smtp-credentials:read:all` returns every SMTP credential; `smtp-credentials:read:{domain}` returns only credentials with at least one authorized `domains` entry.",
  },
  getMessage: {
    kind: "existing_resource_domains",
    resource: "message",
    resourceIdParameter: "message_id",
    resourceDomainPath: "sender",
    quantifier: "one",
    roles: { global: "messages:read:all", domain: "messages:read:{domain}" },
    summary:
      "Authorization requires `messages:read:all` or `messages:read:{domain}` matching the message's `sender` domain.",
  },
  cancelMessage: {
    kind: "existing_resource_domains",
    resource: "message",
    resourceIdParameter: "message_id",
    resourceDomainPath: "sender",
    quantifier: "one",
    roles: { global: "messages:cancel:all", domain: "messages:cancel:{domain}" },
    summary:
      "Authorization requires `messages:cancel:all` or `messages:cancel:{domain}` matching the message's `sender` domain.",
  },
  getRoute: {
    kind: "existing_resource_domains",
    resource: "route",
    resourceIdParameter: "route_id",
    resourceDomainPath: "recipient",
    quantifier: "one",
    roles: { global: "routes:read:all", domain: "routes:read:{domain}" },
    summary:
      "Authorization requires `routes:read:all` or `routes:read:{domain}` matching the route's `recipient` domain.",
  },
  deleteRoute: {
    kind: "existing_resource_domains",
    resource: "route",
    resourceIdParameter: "route_id",
    resourceDomainPath: "recipient",
    quantifier: "one",
    roles: { global: "routes:delete:all", domain: "routes:delete:{domain}" },
    summary:
      "Authorization requires `routes:delete:all` or `routes:delete:{domain}` matching the route's `recipient` domain.",
  },
  getWebhook: {
    kind: "existing_resource_domains",
    resource: "webhook",
    resourceIdParameter: "webhook_id",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: { global: "webhooks:read:all", domain: "webhooks:read:{domain}" },
    summary:
      "Authorization requires `webhooks:read:all` or `webhooks:read:{domain}` matching at least one webhook `domains` entry.",
  },
  deleteWebhook: {
    kind: "existing_resource_domains",
    resource: "webhook",
    resourceIdParameter: "webhook_id",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: { global: "webhooks:delete:all", domain: "webhooks:delete:{domain}" },
    summary:
      "Authorization requires `webhooks:delete:all` or `webhooks:delete:{domain}` matching at least one webhook `domains` entry.",
  },
  getSMTPCredential: {
    kind: "existing_resource_domains",
    resource: "smtp_credential",
    resourceIdParameter: "smtp_credential_id",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: {
      global: "smtp-credentials:read:all",
      domain: "smtp-credentials:read:{domain}",
    },
    summary:
      "Authorization requires `smtp-credentials:read:all` or `smtp-credentials:read:{domain}` matching at least one credential `domains` entry.",
  },
  deleteSMTPCredential: {
    kind: "existing_resource_domains",
    resource: "smtp_credential",
    resourceIdParameter: "smtp_credential_id",
    resourceDomainPath: "domains",
    quantifier: "at_least_one",
    roles: {
      global: "smtp-credentials:delete:all",
      domain: "smtp-credentials:delete:{domain}",
    },
    summary:
      "Authorization requires `smtp-credentials:delete:all` or `smtp-credentials:delete:{domain}` matching at least one credential `domains` entry.",
  },
} as const satisfies AuthorizationRegistry;

const SOURCE_BY_OPERATION = {
  createMessage: "src/resources/messages.ts",
  createConversationMessage: "src/resources/messages.ts",
  getMessages: "src/resources/messages.ts",
  getMessage: "src/resources/messages.ts",
  cancelMessage: "src/resources/messages.ts",
  getRoutes: "src/resources/routes.ts",
  createRoute: "src/resources/routes.ts",
  getRoute: "src/resources/routes.ts",
  updateRoute: "src/resources/routes.ts",
  deleteRoute: "src/resources/routes.ts",
  getWebhooks: "src/resources/webhooks.ts",
  createWebhook: "src/resources/webhooks.ts",
  getWebhook: "src/resources/webhooks.ts",
  updateWebhook: "src/resources/webhooks.ts",
  deleteWebhook: "src/resources/webhooks.ts",
  getSMTPCredentials: "src/resources/smtp-credentials.ts",
  createSMTPCredential: "src/resources/smtp-credentials.ts",
  getSMTPCredential: "src/resources/smtp-credentials.ts",
  deleteSMTPCredential: "src/resources/smtp-credentials.ts",
  getDeliverabilityStatistics: "src/resources/statistics.ts",
  getBounceStatistics: "src/resources/statistics.ts",
  getDeliveryTimeStatistics: "src/resources/statistics.ts",
} as const satisfies Readonly<Record<keyof typeof EXPECTED_AUTHORIZATION, string>>;

function normalizedJSDocForOperation(source: string, operationId: string): string {
  const operationIndex = source.indexOf(`"${operationId}"`);
  if (operationIndex < 0) throw new TypeError(`No facade call found for ${operationId}`);
  const start = source.lastIndexOf("/**", operationIndex);
  const end = source.indexOf("*/", start);
  if (start < 0 || end < 0 || end > operationIndex) {
    throw new TypeError(`No public JSDoc found for ${operationId}`);
  }
  return source
    .slice(start + 3, end)
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

function facadeDocumentation(): Record<string, string> {
  const sources = new Map<string, string>();
  return Object.fromEntries(
    Object.entries(SOURCE_BY_OPERATION).map(([operationId, path]) => {
      let source = sources.get(path);
      if (source === undefined) {
        source = readFileSync(resolve(process.cwd(), path), "utf8");
        sources.set(path, source);
      }
      return [operationId, normalizedJSDocForOperation(source, operationId)];
    }),
  );
}

function assertSameValue(actual: unknown, expected: unknown, location: string): void {
  if (
    expected !== null &&
    typeof expected === "object" &&
    !Array.isArray(expected) &&
    actual !== null &&
    typeof actual === "object" &&
    !Array.isArray(actual)
  ) {
    const actualRecord = actual as Record<string, unknown>;
    const expectedRecord = expected as Record<string, unknown>;
    const actualKeys = Object.keys(actualRecord).sort();
    const expectedKeys = Object.keys(expectedRecord).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new TypeError(`${location} fields differ`);
    }
    for (const key of expectedKeys) {
      assertSameValue(actualRecord[key], expectedRecord[key], `${location}.${key}`);
    }
    return;
  }
  if (!Object.is(actual, expected)) {
    throw new TypeError(`${location} differs`);
  }
}

function assertAuthorizationConformance(
  registry: Readonly<Record<string, unknown>>,
  documentation = facadeDocumentation(),
): void {
  const actualIds = Object.keys(registry).sort();
  const expectedIds = Object.keys(EXPECTED_AUTHORIZATION).sort();
  const missing = expectedIds.filter((operationId) => !actualIds.includes(operationId));
  const orphan = actualIds.filter((operationId) => !expectedIds.includes(operationId));
  if (missing.length > 0 || orphan.length > 0) {
    throw new TypeError(
      `Authorization operationId parity failure: missing=${missing.join(",")}; orphan=${orphan.join(",")}`,
    );
  }

  for (const [operationId, expected] of Object.entries(EXPECTED_AUTHORIZATION)) {
    assertSameValue(registry[operationId], expected, operationId);
    const documentationSummary = documentation[operationId];
    if (documentationSummary === undefined || !documentationSummary.includes(expected.summary)) {
      throw new TypeError(`${operationId} JSDoc differs from its authorization summary`);
    }
  }
}

function mutableAuthorizationRegistry(): MutableRegistry {
  return structuredClone(RESOURCE_AUTHORIZATION) as unknown as MutableRegistry;
}

describe("authorization metadata conformance", () => {
  it("keeps all 23 standard Security Requirement OR pairs independent", () => {
    const pairOperationIds = Object.entries(OPERATION_DESCRIPTORS)
      .filter(([, descriptor]) => descriptor.security.length === 2)
      .map(([operationId]) => operationId)
      .sort();

    expect(pairOperationIds).toEqual(Object.keys(STANDARD_SECURITY_PAIRS).sort());
    for (const [operationId, expectedRoles] of Object.entries(STANDARD_SECURITY_PAIRS)) {
      const actualRoles = OPERATION_DESCRIPTORS[
        operationId as keyof typeof OPERATION_DESCRIPTORS
      ].security
        .flat()
        .sort();
      expect(actualRoles, operationId).toEqual([...expectedRoles].sort());
    }
  });

  it("matches every structured resource rule and its public JSDoc", () => {
    expect(Object.keys(EXPECTED_AUTHORIZATION)).toHaveLength(22);
    expect(() => assertAuthorizationConformance(RESOURCE_AUTHORIZATION)).not.toThrow();
  });

  it("names fields and role pairs declared by the OpenAPI operations and resources", () => {
    const document = parseOpenApi(readFileSync(resolve(process.cwd(), "openapi.yaml"), "utf8"));
    expect(() => validateAuthorizationRegistry(document, RESOURCE_AUTHORIZATION)).not.toThrow();
  });

  it("rejects missing and orphan rules", () => {
    const missing = mutableAuthorizationRegistry();
    delete missing.createMessage;
    expect(() => assertAuthorizationConformance(missing)).toThrow(/missing=createMessage/);

    const orphan = mutableAuthorizationRegistry();
    orphan.deleteDomain = structuredClone(orphan.deleteRoute!);
    expect(() => assertAuthorizationConformance(orphan)).toThrow(/orphan=deleteDomain/);
  });

  it("rejects substituted fields and role pairs", () => {
    const substitutedField = mutableAuthorizationRegistry();
    substitutedField.createMessage!.bodyPath = "from.name";
    expect(() => assertAuthorizationConformance(substitutedField)).toThrow(
      /createMessage\.bodyPath/,
    );

    const substitutedRoles = mutableAuthorizationRegistry();
    const roles = substitutedRoles.getRoute!.roles as Record<string, unknown>;
    roles.domain = "routes:write:{domain}";
    expect(() => assertAuthorizationConformance(substitutedRoles)).toThrow(
      /getRoute\.roles\.domain/,
    );
  });

  it("rejects quantifier and transition substitutions", () => {
    const substitutedQuantifier = mutableAuthorizationRegistry();
    substitutedQuantifier.createWebhook!.quantifier = "at_least_one";
    expect(() => assertAuthorizationConformance(substitutedQuantifier)).toThrow(
      /createWebhook\.quantifier/,
    );

    const substitutedTransition = mutableAuthorizationRegistry();
    substitutedTransition.updateWebhook!.transition = "scoped_role_requires_filter";
    expect(() => assertAuthorizationConformance(substitutedTransition)).toThrow(
      /updateWebhook\.transition/,
    );
  });

  it("rejects public JSDoc drift", () => {
    const documentation = facadeDocumentation();
    documentation.getBounceStatistics = "Authorization documentation drifted.";
    expect(() => assertAuthorizationConformance(RESOURCE_AUTHORIZATION, documentation)).toThrow(
      /getBounceStatistics JSDoc/,
    );
  });
});
