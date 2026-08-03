/**
 * Facade contract matrix.
 *
 * The expected facade and method names below are deliberately handwritten.
 * Generated profile and descriptor values are the actual side of the
 * comparison; openapi.yaml supplies the independent HTTP contract.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import type { AhaSendClient } from "../src/client.js";
import type {
  AddAccountMemberRequest,
  CreateAPIKeyRequest,
  CreateConversationMessageRequest,
  CreateMessageRequest,
  CreateSMTPCredentialRequest,
  CreateWebhookRequest,
} from "../src/index.js";
import type { OperationId, RetryMode } from "../src/generated/operations.js";
import { OPERATION_DESCRIPTORS } from "../src/generated/operations.js";
import type { OperationProfileMapping } from "../src/generated/operation-profile.js";
import { OPERATION_PROFILE } from "../src/generated/operation-profile.js";
import type { IdempotencyRequestOptions, RequestOptions } from "../src/types/common.js";
import type { ResourceCall } from "./helpers/resource-call.js";
import {
  ACCOUNT_ID,
  API_KEY_ID,
  captureFetch,
  HOSTNAME,
  makeClient,
  ROUTE_ID,
  SMTP_CREDENTIAL_ID,
  SUB_ACCOUNT_ID,
  USER_ID,
  WEBHOOK_ID,
} from "./helpers/resource-call.js";

const SPEC_PATH = resolve(process.cwd(), "openapi.yaml");
const ACCOUNT_PATH = `/v2/accounts/${ACCOUNT_ID}`;
const CONTRACT_HEADER = "matrix-options";
const IDEMPOTENCY_KEY = "matrix-idempotency-key";

const IDS = {
  key: API_KEY_ID,
  domain: HOSTNAME,
  message: "message/id",
  user: USER_ID,
  subAccount: SUB_ACCOUNT_ID,
  webhook: WEBHOOK_ID,
  route: ROUTE_ID,
  smtpCredential: SMTP_CREDENTIAL_ID,
} as const;

const REQUEST_OPTIONS: RequestOptions = {
  headers: { "x-contract-test": CONTRACT_HEADER },
};
const IDEMPOTENCY_OPTIONS: IdempotencyRequestOptions = {
  ...REQUEST_OPTIONS,
  idempotencyKey: IDEMPOTENCY_KEY,
};

const PAGINATION_QUERY = { limit: "17", after: "matrix-cursor" } as const;
const PAGINATION_PARAMS = { limit: 17, after: "matrix-cursor" } as const;
const STATISTICS_PARAMS = {
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
  sender_domain: "example.test",
  group_by: "day",
} as const;

interface OpenAPIParameter {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: {
    readonly format?: unknown;
  };
}

interface OpenAPIOperation {
  readonly operationId: string;
  readonly parameters?: readonly OpenAPIParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
  };
  readonly responses: Readonly<
    Record<
      string,
      {
        readonly content?: Readonly<Record<string, { readonly schema?: unknown }>>;
      }
    >
  >;
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}

interface OpenAPIDocument {
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, unknown>> };
}

interface SpecOperation {
  readonly httpMethod: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly operation: OpenAPIOperation;
}

interface ExpectedInput {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

interface Invocation {
  readonly result: Promise<unknown>;
  readonly input: ExpectedInput;
}

interface PrimaryMatrixRow {
  readonly operationId: OperationId;
  readonly facade: string;
  readonly method: string;
  readonly invoke: (client: AhaSendClient) => Invocation;
}

interface IteratorMatrixRow {
  readonly operationId: OperationId;
  readonly facade: string;
  readonly method: "iterate";
  readonly invoke: (client: AhaSendClient) => Invocation;
}

let specDocument: OpenAPIDocument;
let specOperations: ReadonlyMap<string, SpecOperation>;

beforeAll(() => {
  specDocument = yaml.load(readFileSync(SPEC_PATH, "utf8")) as OpenAPIDocument;
  const entries = collectSpecOperations(specDocument);
  specOperations = new Map(entries.map((entry) => [entry.operation.operationId, entry]));
});

const PRIMARY_MATRIX = [
  primary("ping", "client", "ping", (client) => ({
    result: client.ping(REQUEST_OPTIONS),
    input: { path: "/v2/ping" },
  })),
  primary("getAPIKeys", "apiKeys", "list", (client) => ({
    result: client.apiKeys.list(PAGINATION_PARAMS, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/api-keys`, query: PAGINATION_QUERY },
  })),
  primary("createAPIKey", "apiKeys", "create", (client) => {
    const body = {
      label: "matrix",
      scopes: ["messages:send:all"],
    } satisfies CreateAPIKeyRequest;
    return {
      result: client.apiKeys.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/api-keys`, body },
    };
  }),
  primary("getAPIKey", "apiKeys", "get", (client) => ({
    result: client.apiKeys.get(IDS.key, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/api-keys/${API_KEY_ID}` },
  })),
  primary("updateAPIKey", "apiKeys", "update", (client) => {
    const body = { label: "updated" };
    return {
      result: client.apiKeys.update(IDS.key, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/api-keys/${API_KEY_ID}`, body },
    };
  }),
  primary("deleteAPIKey", "apiKeys", "delete", (client) => ({
    result: client.apiKeys.delete(IDS.key, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/api-keys/${API_KEY_ID}` },
  })),
  primary("getDomains", "domains", "list", (client) => ({
    result: client.domains.list({ ...PAGINATION_PARAMS, dns_valid: true }, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/domains`,
      query: { dns_valid: "true", ...PAGINATION_QUERY },
    },
  })),
  primary("createDomain", "domains", "create", (client) => {
    const body = { domain: "example.test" };
    return {
      result: client.domains.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/domains`, body },
    };
  }),
  primary("getDomain", "domains", "get", (client) => ({
    result: client.domains.get(IDS.domain, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/domains/${HOSTNAME}` },
  })),
  primary("updateDomain", "domains", "update", (client) => {
    const body = { tracking_subdomain: "track" };
    return {
      result: client.domains.update(IDS.domain, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/domains/${HOSTNAME}`, body },
    };
  }),
  primary("deleteDomain", "domains", "delete", (client) => ({
    result: client.domains.delete(IDS.domain, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/domains/${HOSTNAME}` },
  })),
  primary("checkDomainDNS", "domains", "checkDns", (client) => ({
    result: client.domains.checkDns(IDS.domain, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/domains/${HOSTNAME}/check-dns` },
  })),
  primary("getMessages", "messages", "list", (client) => ({
    result: client.messages.list(
      { ...PAGINATION_PARAMS, status: "Delivered", sender: "sender@example.test" },
      REQUEST_OPTIONS,
    ),
    input: {
      path: `${ACCOUNT_PATH}/messages`,
      query: {
        status: "Delivered",
        sender: "sender@example.test",
        ...PAGINATION_QUERY,
      },
    },
  })),
  primary("createMessage", "messages", "send", (client) => {
    const body = {
      from: { email: "sender@example.test" },
      recipients: [{ email: "recipient@example.test" }],
      subject: "Matrix",
      attachments: [{ data: "hello", content_type: "text/plain", file_name: "hello.txt" }],
      tags: ["transactional"],
    } satisfies CreateMessageRequest;
    return {
      result: client.messages.send(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/messages`, body },
    };
  }),
  primary("createConversationMessage", "messages", "sendConversation", (client) => {
    const body = {
      from: { email: "sender@example.test" },
      to: [{ email: "recipient@example.test" }],
      subject: "Matrix conversation",
      attachments: [{ data: "hello", content_type: "text/plain", file_name: "hello.txt" }],
      tags: ["transactional"],
    } satisfies CreateConversationMessageRequest;
    return {
      result: client.messages.sendConversation(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/messages/conversation`, body },
    };
  }),
  primary("getMessage", "messages", "get", (client) => ({
    result: client.messages.get(IDS.message, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/messages/message%2Fid` },
  })),
  primary("cancelMessage", "messages", "cancel", (client) => ({
    result: client.messages.cancel(IDS.message, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/messages/message%2Fid/cancel` },
  })),
  primary("getAccount", "accounts", "get", (client) => ({
    result: client.accounts.get(REQUEST_OPTIONS),
    input: { path: ACCOUNT_PATH },
  })),
  primary("updateAccount", "accounts", "update", (client) => {
    const body = { name: "Matrix account" };
    return {
      result: client.accounts.update(body, REQUEST_OPTIONS),
      input: { path: ACCOUNT_PATH, body },
    };
  }),
  primary("getAccountMembers", "accounts", "listMembers", (client) => ({
    result: client.accounts.listMembers(REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/members` },
  })),
  primary("addAccountMember", "accounts", "addMember", (client) => {
    const body = {
      email: "member@example.test",
      role: "Developer",
    } satisfies AddAccountMemberRequest;
    return {
      result: client.accounts.addMember(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/members`, body },
    };
  }),
  primary("removeAccountMember", "accounts", "removeMember", (client) => ({
    result: client.accounts.removeMember(IDS.user, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/members/${USER_ID}` },
  })),
  primary("listSubAccounts", "subAccounts", "list", (client) => ({
    result: client.subAccounts.list(PAGINATION_PARAMS, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts`, query: PAGINATION_QUERY },
  })),
  primary("createSubAccount", "subAccounts", "create", (client) => {
    const body = { name: "Matrix child", website: "child.example.test" };
    return {
      result: client.subAccounts.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/sub-accounts`, body },
    };
  }),
  primary("getSubAccountsUsage", "subAccounts", "usage", (client) => ({
    result: client.subAccounts.usage(REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/usage` },
  })),
  primary("getSubAccount", "subAccounts", "get", (client) => ({
    result: client.subAccounts.get(IDS.subAccount, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}` },
  })),
  primary("updateSubAccount", "subAccounts", "update", (client) => {
    const body = { name: "Updated child" };
    return {
      result: client.subAccounts.update(IDS.subAccount, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}`, body },
    };
  }),
  primary("deleteSubAccount", "subAccounts", "delete", (client) => ({
    result: client.subAccounts.delete(IDS.subAccount, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}` },
  })),
  primary("suspendSubAccount", "subAccounts", "suspend", (client) => {
    const body = { reason: "Matrix suspension" };
    return {
      result: client.subAccounts.suspend(IDS.subAccount, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/suspend`, body },
    };
  }),
  primary("unsuspendSubAccount", "subAccounts", "unsuspend", (client) => ({
    result: client.subAccounts.unsuspend(IDS.subAccount, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/unsuspend` },
  })),
  primary("listSubAccountAPIKeys", "subAccounts.apiKeys", "list", (client) => ({
    result: client.subAccounts.apiKeys.list(IDS.subAccount, PAGINATION_PARAMS, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`,
      query: PAGINATION_QUERY,
    },
  })),
  primary("createSubAccountAPIKey", "subAccounts.apiKeys", "create", (client) => {
    const body = {
      label: "Matrix child key",
      scopes: ["messages:send:all"],
    } satisfies CreateAPIKeyRequest;
    return {
      result: client.subAccounts.apiKeys.create(IDS.subAccount, body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`, body },
    };
  }),
  primary("getSubAccountAPIKey", "subAccounts.apiKeys", "get", (client) => ({
    result: client.subAccounts.apiKeys.get(IDS.subAccount, IDS.key, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys/${API_KEY_ID}` },
  })),
  primary("updateSubAccountAPIKey", "subAccounts.apiKeys", "update", (client) => {
    const body = { label: "Updated child key" };
    return {
      result: client.subAccounts.apiKeys.update(IDS.subAccount, IDS.key, body, REQUEST_OPTIONS),
      input: {
        path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys/${API_KEY_ID}`,
        body,
      },
    };
  }),
  primary("deleteSubAccountAPIKey", "subAccounts.apiKeys", "delete", (client) => ({
    result: client.subAccounts.apiKeys.delete(IDS.subAccount, IDS.key, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys/${API_KEY_ID}` },
  })),
  primary("getSuppressions", "suppressions", "list", (client) => ({
    result: client.suppressions.list(
      { ...PAGINATION_PARAMS, domain: "example.test", email: "blocked@example.test" },
      REQUEST_OPTIONS,
    ),
    input: {
      path: `${ACCOUNT_PATH}/suppressions`,
      query: {
        domain: "example.test",
        email: "blocked@example.test",
        ...PAGINATION_QUERY,
      },
    },
  })),
  primary("createSuppression", "suppressions", "create", (client) => {
    const body = {
      email: "blocked@example.test",
      expires_at: "2027-01-01T00:00:00Z",
    };
    return {
      result: client.suppressions.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/suppressions`, body },
    };
  }),
  primary("deleteSuppression", "suppressions", "delete", (client) => ({
    result: client.suppressions.delete(
      { email: "blocked@example.test", domain: "example.test" },
      REQUEST_OPTIONS,
    ),
    input: {
      path: `${ACCOUNT_PATH}/suppressions`,
      query: { email: "blocked@example.test", domain: "example.test" },
    },
  })),
  primary("deleteAllSuppressions", "suppressions", "wipe", (client) => ({
    result: client.suppressions.wipe({ domain: "example.test" }, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/suppressions/all`,
      query: { domain: "example.test" },
    },
  })),
  primary("getRoutes", "routes", "list", (client) => ({
    result: client.routes.list({ ...PAGINATION_PARAMS, domain: "example.test" }, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/routes`,
      query: { domain: "example.test", ...PAGINATION_QUERY },
    },
  })),
  primary("createRoute", "routes", "create", (client) => {
    const body = {
      name: "Matrix route",
      url: "https://example.test/route",
      recipient: "inbound@example.test",
    };
    return {
      result: client.routes.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/routes`, body },
    };
  }),
  primary("getRoute", "routes", "get", (client) => ({
    result: client.routes.get(IDS.route, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/routes/${ROUTE_ID}` },
  })),
  primary("updateRoute", "routes", "update", (client) => {
    const body = { name: "Updated route" };
    return {
      result: client.routes.update(IDS.route, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/routes/${ROUTE_ID}`, body },
    };
  }),
  primary("deleteRoute", "routes", "delete", (client) => ({
    result: client.routes.delete(IDS.route, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/routes/${ROUTE_ID}` },
  })),
  primary("getWebhooks", "webhooks", "list", (client) => ({
    result: client.webhooks.list(
      { ...PAGINATION_PARAMS, enabled: true, on_delivered: true },
      REQUEST_OPTIONS,
    ),
    input: {
      path: `${ACCOUNT_PATH}/webhooks`,
      query: { enabled: "true", on_delivered: "true", ...PAGINATION_QUERY },
    },
  })),
  primary("createWebhook", "webhooks", "create", (client) => {
    const body = {
      name: "Matrix webhook",
      url: "https://example.test/webhook",
      scope: "global",
    } satisfies CreateWebhookRequest;
    return {
      result: client.webhooks.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/webhooks`, body },
    };
  }),
  primary("getWebhook", "webhooks", "get", (client) => ({
    result: client.webhooks.get(IDS.webhook, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/webhooks/${WEBHOOK_ID}` },
  })),
  primary("updateWebhook", "webhooks", "update", (client) => {
    const body = { name: "Updated webhook" };
    return {
      result: client.webhooks.update(IDS.webhook, body, REQUEST_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/webhooks/${WEBHOOK_ID}`, body },
    };
  }),
  primary("deleteWebhook", "webhooks", "delete", (client) => ({
    result: client.webhooks.delete(IDS.webhook, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/webhooks/${WEBHOOK_ID}` },
  })),
  primary("getSMTPCredentials", "smtpCredentials", "list", (client) => ({
    result: client.smtpCredentials.list(PAGINATION_PARAMS, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/smtp-credentials`, query: PAGINATION_QUERY },
  })),
  primary("createSMTPCredential", "smtpCredentials", "create", (client) => {
    const body = {
      name: "Matrix SMTP",
      scope: "global",
    } satisfies CreateSMTPCredentialRequest;
    return {
      result: client.smtpCredentials.create(body, IDEMPOTENCY_OPTIONS),
      input: { path: `${ACCOUNT_PATH}/smtp-credentials`, body },
    };
  }),
  primary("getSMTPCredential", "smtpCredentials", "get", (client) => ({
    result: client.smtpCredentials.get(IDS.smtpCredential, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/smtp-credentials/${SMTP_CREDENTIAL_ID}` },
  })),
  primary("deleteSMTPCredential", "smtpCredentials", "delete", (client) => ({
    result: client.smtpCredentials.delete(IDS.smtpCredential, REQUEST_OPTIONS),
    input: { path: `${ACCOUNT_PATH}/smtp-credentials/${SMTP_CREDENTIAL_ID}` },
  })),
  primary("getDeliverabilityStatistics", "statistics", "deliverability", (client) => ({
    result: client.statistics.deliverability(STATISTICS_PARAMS, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/statistics/transactional/deliverability`,
      query: STATISTICS_PARAMS,
    },
  })),
  primary("getBounceStatistics", "statistics", "bounces", (client) => ({
    result: client.statistics.bounces(STATISTICS_PARAMS, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/statistics/transactional/bounce`,
      query: STATISTICS_PARAMS,
    },
  })),
  primary("getDeliveryTimeStatistics", "statistics", "deliveryTimes", (client) => ({
    result: client.statistics.deliveryTimes(STATISTICS_PARAMS, REQUEST_OPTIONS),
    input: {
      path: `${ACCOUNT_PATH}/statistics/transactional/delivery-time`,
      query: STATISTICS_PARAMS,
    },
  })),
] as const satisfies readonly PrimaryMatrixRow[];

const ITERATOR_MATRIX = [
  iterator("getAPIKeys", "apiKeys", (client) => ({
    result: client.apiKeys.iterate(PAGINATION_PARAMS, REQUEST_OPTIONS).next(),
    input: { path: `${ACCOUNT_PATH}/api-keys`, query: PAGINATION_QUERY },
  })),
  iterator("getDomains", "domains", (client) => ({
    result: client.domains
      .iterate({ ...PAGINATION_PARAMS, dns_valid: true }, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/domains`,
      query: { dns_valid: "true", ...PAGINATION_QUERY },
    },
  })),
  iterator("getMessages", "messages", (client) => ({
    result: client.messages
      .iterate({ ...PAGINATION_PARAMS, status: "Delivered" }, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/messages`,
      query: { status: "Delivered", ...PAGINATION_QUERY },
    },
  })),
  iterator("listSubAccounts", "subAccounts", (client) => ({
    result: client.subAccounts.iterate(PAGINATION_PARAMS, REQUEST_OPTIONS).next(),
    input: { path: `${ACCOUNT_PATH}/sub-accounts`, query: PAGINATION_QUERY },
  })),
  iterator("listSubAccountAPIKeys", "subAccounts.apiKeys", (client) => ({
    result: client.subAccounts.apiKeys
      .iterate(IDS.subAccount, PAGINATION_PARAMS, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/sub-accounts/${SUB_ACCOUNT_ID}/api-keys`,
      query: PAGINATION_QUERY,
    },
  })),
  iterator("getSuppressions", "suppressions", (client) => ({
    result: client.suppressions
      .iterate({ ...PAGINATION_PARAMS, domain: "example.test" }, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/suppressions`,
      query: { domain: "example.test", ...PAGINATION_QUERY },
    },
  })),
  iterator("getRoutes", "routes", (client) => ({
    result: client.routes
      .iterate({ ...PAGINATION_PARAMS, domain: "example.test" }, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/routes`,
      query: { domain: "example.test", ...PAGINATION_QUERY },
    },
  })),
  iterator("getWebhooks", "webhooks", (client) => ({
    result: client.webhooks
      .iterate({ ...PAGINATION_PARAMS, enabled: true }, REQUEST_OPTIONS)
      .next(),
    input: {
      path: `${ACCOUNT_PATH}/webhooks`,
      query: { enabled: "true", ...PAGINATION_QUERY },
    },
  })),
  iterator("getSMTPCredentials", "smtpCredentials", (client) => ({
    result: client.smtpCredentials.iterate(PAGINATION_PARAMS, REQUEST_OPTIONS).next(),
    input: { path: `${ACCOUNT_PATH}/smtp-credentials`, query: PAGINATION_QUERY },
  })),
] as const satisfies readonly IteratorMatrixRow[];

describe("Facade operation conformance matrix", () => {
  it("accounts for exactly 56 primary operations", () => {
    expect(PRIMARY_MATRIX).toHaveLength(56);
    expect(new Set(PRIMARY_MATRIX.map(({ operationId }) => operationId)).size).toBe(56);
    expect(OPERATION_PROFILE.operations).toHaveLength(56);
    expect(profileShape(OPERATION_PROFILE.operations)).toEqual(profileShape(PRIMARY_MATRIX));
  });

  for (const row of PRIMARY_MATRIX) {
    it(`${row.facade}.${row.method} -> ${row.operationId}`, async () => {
      await expectMatrixRow(row, OPERATION_PROFILE.operations);
    });
  }
});

describe("Facade iterator conformance matrix", () => {
  it("accounts for exactly nine iterator aliases", () => {
    expect(ITERATOR_MATRIX).toHaveLength(9);
    expect(new Set(ITERATOR_MATRIX.map(({ facade, method }) => `${facade}.${method}`)).size).toBe(
      9,
    );
    expect(OPERATION_PROFILE.iterators).toHaveLength(9);
    expect(profileShape(OPERATION_PROFILE.iterators)).toEqual(profileShape(ITERATOR_MATRIX));
  });

  for (const row of ITERATOR_MATRIX) {
    it(`${row.facade}.${row.method} -> ${row.operationId}`, async () => {
      await expectMatrixRow(row, OPERATION_PROFILE.iterators);
    });
  }
});

describe("Non-empty request array coverage", () => {
  it("guards every resource module that carries a minItems-one request schema", () => {
    // The spec's `minItems: 1` used to be enforced by a non-empty tuple type.
    // It is now a runtime guard, which means a NEW resource module reusing an
    // existing request type silently loses the guarantee — exactly what
    // happened to the sub-account API-key paths. Derive the requirement from
    // the spec so the next reuse cannot ship unguarded.
    const schemas = specDocument.components?.schemas ?? {};
    const constrained = new Set<string>();
    const walk = (node: unknown, schemaName: string): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, schemaName);
        return;
      }
      const record = node as Record<string, unknown>;
      if (record["minItems"] === 1) constrained.add(schemaName);
      for (const value of Object.values(record)) walk(value, schemaName);
    };
    for (const [name, schema] of Object.entries(schemas)) walk(schema, name);

    expect(constrained.size).toBeGreaterThan(0);

    const resourceDir = resolve(process.cwd(), "src/resources");
    const resourceFiles = readdirSync(resourceDir).filter((name) => name.endsWith(".ts"));
    const unguarded: string[] = [];

    for (const schemaName of constrained) {
      for (const file of resourceFiles) {
        const source = readFileSync(resolve(resourceDir, file), "utf8");
        // A module that names the constrained request type must also guard it.
        if (source.includes(schemaName) && !source.includes("assertNonEmptyArray")) {
          unguarded.push(`${file} uses ${schemaName} without assertNonEmptyArray`);
        }
      }
    }

    expect(unguarded).toEqual([]);
  });
});

describe("Generated operation inventory", () => {
  it("maps every OpenAPI operation to one descriptor and primary facade row", () => {
    const operationIds = [...specOperations.keys()];
    expect(operationIds).toHaveLength(56);
    expect(Object.keys(OPERATION_DESCRIPTORS)).toEqual(operationIds);
    expect(PRIMARY_MATRIX.map(({ operationId }) => operationId)).toEqual(operationIds);
  });
});

function primary(
  operationId: OperationId,
  facade: string,
  method: string,
  invoke: (client: AhaSendClient) => Invocation,
): PrimaryMatrixRow {
  return { operationId, facade, method, invoke };
}

function iterator(
  operationId: OperationId,
  facade: string,
  invoke: (client: AhaSendClient) => Invocation,
): IteratorMatrixRow {
  return { operationId, facade, method: "iterate", invoke };
}

function profileShape(
  mappings: readonly Pick<OperationProfileMapping, "operationId" | "facade" | "method">[],
): Array<Pick<OperationProfileMapping, "operationId" | "facade" | "method">> {
  return mappings.map(({ operationId, facade, method }) => ({ operationId, facade, method }));
}

async function expectMatrixRow(
  row: PrimaryMatrixRow | IteratorMatrixRow,
  profile: readonly OperationProfileMapping[],
): Promise<void> {
  const mapping = profile.find(
    ({ facade, method }) => facade === row.facade && method === row.method,
  );
  expect(mapping, `${row.facade}.${row.method}`).toEqual({
    operationId: row.operationId,
    facade: row.facade,
    method: row.method,
  });

  const spec = specOperations.get(row.operationId);
  expect(spec, row.operationId).toBeDefined();
  const descriptor = OPERATION_DESCRIPTORS[row.operationId];
  const parameters = spec!.operation.parameters ?? [];
  const idempotency = parameters.some(
    ({ $ref }) => $ref === "#/components/parameters/IdempotencyKey",
  );

  expect(descriptor.method, row.operationId).toBe(spec!.httpMethod);
  expect(descriptor.path, row.operationId).toBe(spec!.path);
  expect(descriptor.pathParameters, row.operationId).toEqual(
    parameters.filter((parameter) => parameter.in === "path").map(parameterDescriptorFact),
  );
  expect(descriptor.query, row.operationId).toEqual(
    parameters.filter((parameter) => parameter.in === "query").map(parameterDescriptorFact),
  );
  expect(descriptor.body, row.operationId).toEqual(requestBodyFact(spec!.operation));
  expect(descriptor.success, row.operationId).toEqual(successFacts(spec!.operation));
  expect(descriptor.idempotency, row.operationId).toBe(idempotency);
  expect(descriptor.retry, row.operationId).toBe(expectedRetryMode(spec!.httpMethod, idempotency));
  expect(descriptor.security, row.operationId).toEqual(
    (spec!.operation.security ?? specDocument.security ?? []).map(
      (requirement) => requirement["BearerAuth"] ?? [],
    ),
  );

  const { fetch, calls } = captureFetch(
    () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [],
          pagination: { has_more: false },
          message: "ok",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  const invocation = row.invoke(makeClient(fetch));
  await invocation.result;
  expect(calls).toHaveLength(1);
  expectSerializedInput(
    calls[0]!,
    invocation.input,
    row.operationId,
    descriptor.method,
    idempotency,
  );
}

function expectSerializedInput(
  call: ResourceCall,
  input: ExpectedInput,
  operationId: OperationId,
  method: SpecOperation["httpMethod"],
  idempotency: boolean,
): void {
  const url = new URL(call.url);
  expect(call.operationId).toBe(operationId);
  expect(call.method).toBe(method);
  expect(url.pathname).toBe(input.path);
  expect(Object.fromEntries(url.searchParams)).toEqual(input.query ?? {});
  expect(call.body).toBe(input.body === undefined ? undefined : JSON.stringify(input.body));
  expect(call.headers["x-contract-test"]).toBe(CONTRACT_HEADER);
  if (idempotency) {
    expect(call.headers["idempotency-key"]).toBe(IDEMPOTENCY_KEY);
  } else {
    expect(call.headers).not.toHaveProperty("idempotency-key");
  }
}

function collectSpecOperations(document: OpenAPIDocument): SpecOperation[] {
  const entries: SpecOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of ["get", "post", "put", "delete"] as const) {
      const operation = pathItem[method] as OpenAPIOperation | undefined;
      if (operation === undefined) continue;
      entries.push({
        httpMethod: method.toUpperCase() as SpecOperation["httpMethod"],
        path,
        operation,
      });
    }
  }
  return entries;
}

function parameterDescriptorFact(parameter: OpenAPIParameter): {
  name: string;
  required: boolean;
  format: string | null;
} {
  return {
    name: parameter.name!,
    required: parameter.required === true,
    format:
      parameter.schema !== undefined &&
      typeof parameter.schema === "object" &&
      !Array.isArray(parameter.schema) &&
      typeof parameter.schema.format === "string"
        ? parameter.schema.format
        : null,
  };
}

function schemaName(schema: unknown): string | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const reference = (schema as Record<string, unknown>)["$ref"];
  return typeof reference === "string" && reference.startsWith("#/components/schemas/")
    ? reference.slice("#/components/schemas/".length)
    : "inline";
}

function requestBodyFact(
  operation: OpenAPIOperation,
): { required: boolean; schema: string | null } | null {
  if (operation.requestBody === undefined) return null;
  return {
    required: operation.requestBody.required === true,
    schema: schemaName(operation.requestBody.content?.["application/json"]?.schema),
  };
}

function successFacts(
  operation: OpenAPIOperation,
): Array<{ status: number; schema: string | null }> {
  return Object.entries(operation.responses)
    .filter(([status]) => /^2\d\d$/.test(status))
    .map(([status, response]) => ({
      status: Number(status),
      schema: schemaName(response.content?.["application/json"]?.schema),
    }));
}

function expectedRetryMode(method: SpecOperation["httpMethod"], idempotency: boolean): RetryMode {
  if (method === "GET") return "safe";
  if (method === "PUT" || method === "DELETE") return "idempotent";
  return idempotency ? "idempotency_key" : "never";
}
