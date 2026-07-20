const operations = [
  ["ping", "GET", "/v2/ping"],
  ["getAPIKeys", "GET", "/v2/accounts/{account_id}/api-keys"],
  ["createAPIKey", "POST", "/v2/accounts/{account_id}/api-keys"],
  ["getAPIKey", "GET", "/v2/accounts/{account_id}/api-keys/{key_id}"],
  ["updateAPIKey", "PUT", "/v2/accounts/{account_id}/api-keys/{key_id}"],
  ["deleteAPIKey", "DELETE", "/v2/accounts/{account_id}/api-keys/{key_id}"],
  ["getDomains", "GET", "/v2/accounts/{account_id}/domains"],
  ["createDomain", "POST", "/v2/accounts/{account_id}/domains"],
  ["getDomain", "GET", "/v2/accounts/{account_id}/domains/{domain}"],
  ["updateDomain", "PUT", "/v2/accounts/{account_id}/domains/{domain}"],
  ["deleteDomain", "DELETE", "/v2/accounts/{account_id}/domains/{domain}"],
  ["checkDomainDNS", "POST", "/v2/accounts/{account_id}/domains/{domain}/check-dns"],
  ["getMessages", "GET", "/v2/accounts/{account_id}/messages"],
  ["createMessage", "POST", "/v2/accounts/{account_id}/messages"],
  ["createConversationMessage", "POST", "/v2/accounts/{account_id}/messages/conversation"],
  ["getMessage", "GET", "/v2/accounts/{account_id}/messages/{message_id}"],
  ["cancelMessage", "DELETE", "/v2/accounts/{account_id}/messages/{message_id}/cancel"],
  ["getAccount", "GET", "/v2/accounts/{account_id}"],
  ["updateAccount", "PUT", "/v2/accounts/{account_id}"],
  ["getAccountMembers", "GET", "/v2/accounts/{account_id}/members"],
  ["addAccountMember", "POST", "/v2/accounts/{account_id}/members"],
  ["removeAccountMember", "DELETE", "/v2/accounts/{account_id}/members/{user_id}"],
  ["listSubAccounts", "GET", "/v2/accounts/{account_id}/sub-accounts"],
  ["createSubAccount", "POST", "/v2/accounts/{account_id}/sub-accounts"],
  ["getSubAccountsUsage", "GET", "/v2/accounts/{account_id}/sub-accounts/usage"],
  ["getSubAccount", "GET", "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}"],
  ["updateSubAccount", "PUT", "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}"],
  ["deleteSubAccount", "DELETE", "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}"],
  ["suspendSubAccount", "POST", "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/suspend"],
  [
    "unsuspendSubAccount",
    "POST",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/unsuspend",
  ],
  [
    "listSubAccountAPIKeys",
    "GET",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys",
  ],
  [
    "createSubAccountAPIKey",
    "POST",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys",
  ],
  [
    "getSubAccountAPIKey",
    "GET",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
  ],
  [
    "updateSubAccountAPIKey",
    "PUT",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
  ],
  [
    "deleteSubAccountAPIKey",
    "DELETE",
    "/v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
  ],
  ["getSuppressions", "GET", "/v2/accounts/{account_id}/suppressions"],
  ["createSuppression", "POST", "/v2/accounts/{account_id}/suppressions"],
  ["deleteSuppression", "DELETE", "/v2/accounts/{account_id}/suppressions"],
  ["deleteAllSuppressions", "DELETE", "/v2/accounts/{account_id}/suppressions/all"],
  ["getRoutes", "GET", "/v2/accounts/{account_id}/routes"],
  ["createRoute", "POST", "/v2/accounts/{account_id}/routes"],
  ["getRoute", "GET", "/v2/accounts/{account_id}/routes/{route_id}"],
  ["updateRoute", "PUT", "/v2/accounts/{account_id}/routes/{route_id}"],
  ["deleteRoute", "DELETE", "/v2/accounts/{account_id}/routes/{route_id}"],
  ["getWebhooks", "GET", "/v2/accounts/{account_id}/webhooks"],
  ["createWebhook", "POST", "/v2/accounts/{account_id}/webhooks"],
  ["getWebhook", "GET", "/v2/accounts/{account_id}/webhooks/{webhook_id}"],
  ["updateWebhook", "PUT", "/v2/accounts/{account_id}/webhooks/{webhook_id}"],
  ["deleteWebhook", "DELETE", "/v2/accounts/{account_id}/webhooks/{webhook_id}"],
  ["getSMTPCredentials", "GET", "/v2/accounts/{account_id}/smtp-credentials"],
  ["createSMTPCredential", "POST", "/v2/accounts/{account_id}/smtp-credentials"],
  ["getSMTPCredential", "GET", "/v2/accounts/{account_id}/smtp-credentials/{smtp_credential_id}"],
  [
    "deleteSMTPCredential",
    "DELETE",
    "/v2/accounts/{account_id}/smtp-credentials/{smtp_credential_id}",
  ],
  [
    "getDeliverabilityStatistics",
    "GET",
    "/v2/accounts/{account_id}/statistics/transactional/deliverability",
  ],
  ["getBounceStatistics", "GET", "/v2/accounts/{account_id}/statistics/transactional/bounce"],
  [
    "getDeliveryTimeStatistics",
    "GET",
    "/v2/accounts/{account_id}/statistics/transactional/delivery-time",
  ],
];

const idempotentOperations = new Set([
  "createAPIKey",
  "createDomain",
  "createMessage",
  "createConversationMessage",
  "addAccountMember",
  "createSubAccount",
  "createSubAccountAPIKey",
  "createSuppression",
  "createRoute",
  "createWebhook",
  "createSMTPCredential",
]);

const requestBodies = {
  createAPIKey: { label: "Production API key", scopes: ["messages:send:all"] },
  updateAPIKey: { label: "Renamed API key" },
  createDomain: { domain: "example.com" },
  updateDomain: { tracking_subdomain: "click" },
  createMessage: {
    from: { email: "sender@example.com", name: "Example" },
    recipients: [{ email: "recipient@example.net" }],
    subject: "Hello from AhaSend",
    html_content: "<p>Hello!</p>",
  },
  createConversationMessage: {
    from: { email: "sender@example.com", name: "Example" },
    to: [{ email: "recipient@example.net" }],
    subject: "Hello from AhaSend",
    html_content: "<p>Hello!</p>",
  },
  updateAccount: { name: "Example, Inc." },
  addAccountMember: { email: "developer@example.com", role: "Developer" },
  createSubAccount: { name: "Example subsidiary", website: "subsidiary.example.com" },
  updateSubAccount: { name: "Renamed subsidiary" },
  suspendSubAccount: { reason: "Requested by account administrator" },
  createSubAccountAPIKey: { label: "Bootstrap key", scopes: ["messages:send:all"] },
  updateSubAccountAPIKey: { label: "Renamed bootstrap key" },
  createSuppression: {
    email: "recipient@example.net",
    reason: "User requested removal",
    expires_at: "2027-01-01T00:00:00Z",
  },
  createRoute: {
    name: "Inbound messages",
    url: "https://example.com/inbound",
    recipient: "inbound@example.com",
  },
  updateRoute: { url: "https://example.com/inbound-v2" },
  createWebhook: {
    name: "Delivery events",
    url: "https://example.com/webhooks/ahasend",
    scope: "global",
    on_delivered: true,
  },
  updateWebhook: { name: "Transactional delivery events" },
  createSMTPCredential: { name: "Production SMTP", scope: "global" },
};

const queryParameters = {
  deleteSuppression: { email: "recipient@example.net" },
  getDeliverabilityStatistics: {
    from_time: "2026-01-01T00:00:00Z",
    to_time: "2026-01-02T00:00:00Z",
  },
  getBounceStatistics: {
    from_time: "2026-01-01T00:00:00Z",
    to_time: "2026-01-02T00:00:00Z",
  },
  getDeliveryTimeStatistics: {
    from_time: "2026-01-01T00:00:00Z",
    to_time: "2026-01-02T00:00:00Z",
  },
};

const pathParameters = {
  key_id: ["keyId", "00000000-0000-0000-0000-000000000001"],
  domain: ["domain", "example.com"],
  message_id: ["messageId", "message-id"],
  user_id: ["userId", "00000000-0000-0000-0000-000000000002"],
  sub_account_id: ["subAccountId", "00000000-0000-0000-0000-000000000003"],
  route_id: ["routeId", "00000000-0000-0000-0000-000000000004"],
  webhook_id: ["webhookId", "00000000-0000-0000-0000-000000000005"],
  smtp_credential_id: ["smtpCredentialId", "00000000-0000-0000-0000-000000000006"],
};

function indentJson(value, spaces) {
  const indentation = " ".repeat(spaces);
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${indentation}`);
}

function buildSource(operationId, method, path) {
  const keyed = idempotentOperations.has(operationId);
  const body = requestBodies[operationId];
  const query = queryParameters[operationId];
  const declarations = [];
  let renderedPath = path;

  if (path.includes("{account_id}")) {
    declarations.push("const accountId = process.env.AHASEND_ACCOUNT_ID;");
    renderedPath = renderedPath.replaceAll("{account_id}", "${accountId}");
  }

  for (const [placeholder, [variable, example]] of Object.entries(pathParameters)) {
    if (path.includes(`{${placeholder}}`)) {
      declarations.push(`const ${variable} = ${JSON.stringify(example)};`);
      renderedPath = renderedPath.replaceAll(`{${placeholder}}`, `\${${variable}}`);
    }
  }

  const requiredEnvironment = path.includes("{account_id}")
    ? 'if (!apiKey || !accountId) throw new Error("Set AHASEND_API_KEY and AHASEND_ACCOUNT_ID");'
    : 'if (!apiKey) throw new Error("Set AHASEND_API_KEY");';
  const lines = [];

  if (keyed) lines.push('import { randomUUID } from "node:crypto";', "");
  lines.push(
    "const apiKey = process.env.AHASEND_API_KEY;",
    ...declarations,
    requiredEnvironment,
    "",
  );
  lines.push(`const url = new URL(\`https://api.ahasend.com${renderedPath}\`);`);

  if (query !== undefined) {
    for (const [name, value] of Object.entries(query)) {
      lines.push(`url.searchParams.set(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
    }
  }

  const headers = ["Authorization: `Bearer ${apiKey}`"];
  if (body !== undefined) headers.push('"Content-Type": "application/json"');
  if (keyed) headers.push('"Idempotency-Key": randomUUID()');

  lines.push(
    "",
    "const response = await fetch(url, {",
    `  method: ${JSON.stringify(method)},`,
    "  headers: {",
  );
  for (const header of headers) lines.push(`    ${header},`);
  lines.push("  },");
  if (body !== undefined) lines.push(`  body: JSON.stringify(${indentJson(body, 2)}),`);
  lines.push("});", "");
  lines.push(
    "if (!response.ok) {",
    "  throw new Error(`AhaSend request failed (${response.status}): ${await response.text()}`);",
    "}",
    "",
    "console.log(await response.json());",
    "",
  );

  return lines.join("\n");
}

export const NODE_SAMPLE_LANGUAGE = "javascript";
export const NODE_SAMPLE_LABEL = "Node.js 18+ (built-in fetch)";
export const NODE_OPERATION_KEYS = Object.freeze(
  Object.fromEntries(
    operations.map(([operationId, method, path]) => [operationId, `${method} ${path}`]),
  ),
);

export const NODE_CODE_SAMPLES = Object.freeze(
  Object.fromEntries(
    operations.map(([operationId, method, path]) => [
      operationId,
      Object.freeze({
        lang: NODE_SAMPLE_LANGUAGE,
        label: NODE_SAMPLE_LABEL,
        source: buildSource(operationId, method, path),
      }),
    ]),
  ),
);
