const mutationGuard = `if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Set AHASEND_ALLOW_MUTATIONS=1 after reviewing this mutation.");
}

`;

function sdkSource(body, { guarded = false } = {}) {
  return `import { AhaSendClient } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();
${guarded ? mutationGuard : ""}${body}
`;
}

function entry(operationId, operationKey, facade, body, options) {
  return Object.freeze({
    operationId,
    operationKey,
    facade,
    sample: Object.freeze({
      lang: NODE_SAMPLE_LANGUAGE,
      label: NODE_SAMPLE_LABEL,
      source: sdkSource(body, options),
    }),
  });
}

export const NODE_SAMPLE_LANGUAGE = "javascript";
export const NODE_SAMPLE_LABEL = "Node.js 22+ (AhaSend SDK)";

export const NODE_SAMPLE_REGISTRY = Object.freeze([
  entry(
    "ping",
    "GET /v2/ping",
    "client.ping",
    `const health = await client.ping();
console.log("AhaSend API is reachable.", { message: health.message });`,
  ),
  entry(
    "getAPIKeys",
    "GET /v2/accounts/{account_id}/api-keys",
    "client.apiKeys.list",
    `const page = await client.apiKeys.list({ limit: 20 });
console.log("API keys listed.", { count: page.data.length });`,
  ),
  entry(
    "createAPIKey",
    "POST /v2/accounts/{account_id}/api-keys",
    "client.apiKeys.create",
    `const apiKey = await client.apiKeys.create(
  { label: "Production API key", scopes: ["messages:send:all"] },
  { idempotencyKey: "sdk-sample-create-api-key" },
);
console.log("API key created.", { id: apiKey.id, label: apiKey.label });`,
    { guarded: true },
  ),
  entry(
    "getAPIKey",
    "GET /v2/accounts/{account_id}/api-keys/{key_id}",
    "client.apiKeys.get",
    `const keyId = "00000000-0000-4000-8000-000000000001";
const apiKey = await client.apiKeys.get(keyId);
console.log("API key found.", { id: apiKey.id, label: apiKey.label });`,
  ),
  entry(
    "updateAPIKey",
    "PUT /v2/accounts/{account_id}/api-keys/{key_id}",
    "client.apiKeys.update",
    `const keyId = "00000000-0000-4000-8000-000000000001";
const apiKey = await client.apiKeys.update(keyId, { label: "Renamed API key" });
console.log("API key updated.", { id: apiKey.id, label: apiKey.label });`,
    { guarded: true },
  ),
  entry(
    "deleteAPIKey",
    "DELETE /v2/accounts/{account_id}/api-keys/{key_id}",
    "client.apiKeys.delete",
    `const keyId = "00000000-0000-4000-8000-000000000001";
const result = await client.apiKeys.delete(keyId);
console.log("API key deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getDomains",
    "GET /v2/accounts/{account_id}/domains",
    "client.domains.list",
    `const page = await client.domains.list({ limit: 20 });
console.log("Domains listed.", { count: page.data.length });`,
  ),
  entry(
    "createDomain",
    "POST /v2/accounts/{account_id}/domains",
    "client.domains.create",
    `const domain = await client.domains.create(
  { domain: "example.com" },
  { idempotencyKey: "sdk-sample-create-domain" },
);
console.log("Domain created.", { id: domain.id, domain: domain.domain });`,
    { guarded: true },
  ),
  entry(
    "getDomain",
    "GET /v2/accounts/{account_id}/domains/{domain}",
    "client.domains.get",
    `const domainName = "example.com";
const domain = await client.domains.get(domainName);
console.log("Domain found.", { domain: domain.domain, dnsValid: domain.dns_valid });`,
  ),
  entry(
    "updateDomain",
    "PUT /v2/accounts/{account_id}/domains/{domain}",
    "client.domains.update",
    `const domainName = "example.com";
const domain = await client.domains.update(domainName, { tracking_subdomain: "click" });
console.log("Domain updated.", { domain: domain.domain });`,
    { guarded: true },
  ),
  entry(
    "deleteDomain",
    "DELETE /v2/accounts/{account_id}/domains/{domain}",
    "client.domains.delete",
    `const domainName = "example.com";
const result = await client.domains.delete(domainName);
console.log("Domain deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "checkDomainDNS",
    "POST /v2/accounts/{account_id}/domains/{domain}/check-dns",
    "client.domains.checkDns",
    `const domainName = "example.com";
const domain = await client.domains.checkDns(domainName);
console.log("DNS check completed.", { domain: domain.domain, dnsValid: domain.dns_valid });`,
    { guarded: true },
  ),
  entry(
    "getMessages",
    "GET /v2/accounts/{account_id}/messages",
    "client.messages.list",
    `const page = await client.messages.list({ limit: 20 });
console.log("Messages listed.", { count: page.data.length });`,
  ),
  entry(
    "createMessage",
    "POST /v2/accounts/{account_id}/messages",
    "client.messages.send",
    `const result = await client.messages.send(
  {
    from: { email: "sender@example.com", name: "Example" },
    recipients: [{ email: "recipient@example.net" }],
    subject: "Hello from AhaSend",
    html_content: "<p>Hello!</p>",
    sandbox: true,
  },
  { idempotencyKey: "sdk-sample-send-message" },
);
console.log("Sandbox message accepted.", { count: result.data.length });`,
    { guarded: true },
  ),
  entry(
    "createConversationMessage",
    "POST /v2/accounts/{account_id}/messages/conversation",
    "client.messages.sendConversation",
    `const result = await client.messages.sendConversation(
  {
    from: { email: "sender@example.com", name: "Example" },
    to: [{ email: "recipient@example.net" }],
    subject: "Hello from AhaSend",
    html_content: "<p>Hello!</p>",
    sandbox: true,
  },
  { idempotencyKey: "sdk-sample-send-conversation" },
);
console.log("Sandbox conversation accepted.", { count: result.data.length });`,
    { guarded: true },
  ),
  entry(
    "getMessage",
    "GET /v2/accounts/{account_id}/messages/{message_id}",
    "client.messages.get",
    `const messageId = "00000000-0000-4000-8000-000000000002";
const message = await client.messages.get(messageId);
console.log("Message found.", { id: message.id, status: message.status });`,
  ),
  entry(
    "cancelMessage",
    "DELETE /v2/accounts/{account_id}/messages/{message_id}/cancel",
    "client.messages.cancel",
    `const messageId = "00000000-0000-4000-8000-000000000002";
const result = await client.messages.cancel(messageId);
console.log("Message cancellation requested.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getAccount",
    "GET /v2/accounts/{account_id}",
    "client.accounts.get",
    `const account = await client.accounts.get();
console.log("Account found.", { id: account.id, name: account.name });`,
  ),
  entry(
    "updateAccount",
    "PUT /v2/accounts/{account_id}",
    "client.accounts.update",
    `const account = await client.accounts.update({ name: "Example, Inc." });
console.log("Account updated.", { id: account.id, name: account.name });`,
    { guarded: true },
  ),
  entry(
    "getAccountMembers",
    "GET /v2/accounts/{account_id}/members",
    "client.accounts.listMembers",
    `const members = await client.accounts.listMembers();
console.log("Account members listed.", { count: members.data.length });`,
  ),
  entry(
    "addAccountMember",
    "POST /v2/accounts/{account_id}/members",
    "client.accounts.addMember",
    `const member = await client.accounts.addMember(
  { email: "developer@example.com", role: "Developer" },
  { idempotencyKey: "sdk-sample-add-account-member" },
);
console.log("Account member added.", { userId: member.user_id, role: member.role });`,
    { guarded: true },
  ),
  entry(
    "removeAccountMember",
    "DELETE /v2/accounts/{account_id}/members/{user_id}",
    "client.accounts.removeMember",
    `const userId = "00000000-0000-4000-8000-000000000003";
const result = await client.accounts.removeMember(userId);
console.log("Account member removed.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "listSubAccounts",
    "GET /v2/accounts/{account_id}/sub-accounts",
    "client.subAccounts.list",
    `const page = await client.subAccounts.list({ limit: 20 });
console.log("Sub-accounts listed.", { count: page.data.length });`,
  ),
  entry(
    "createSubAccount",
    "POST /v2/accounts/{account_id}/sub-accounts",
    "client.subAccounts.create",
    `const subAccount = await client.subAccounts.create(
  { name: "Example subsidiary", website: "subsidiary.example.com" },
  { idempotencyKey: "sdk-sample-create-sub-account" },
);
console.log("Sub-account created.", { id: subAccount.id, status: subAccount.status });`,
    { guarded: true },
  ),
  entry(
    "getSubAccountsUsage",
    "GET /v2/accounts/{account_id}/sub-accounts/usage",
    "client.subAccounts.usage",
    `const usage = await client.subAccounts.usage();
console.log("Sub-account usage loaded.", {
  currency: usage.currency,
  subAccountCount: usage.sub_accounts.length,
});`,
  ),
  entry(
    "getSubAccount",
    "GET /v2/accounts/{account_id}/sub-accounts/{sub_account_id}",
    "client.subAccounts.get",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const subAccount = await client.subAccounts.get(subAccountId);
console.log("Sub-account found.", { id: subAccount.id, status: subAccount.status });`,
  ),
  entry(
    "updateSubAccount",
    "PUT /v2/accounts/{account_id}/sub-accounts/{sub_account_id}",
    "client.subAccounts.update",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const subAccount = await client.subAccounts.update(subAccountId, {
  name: "Renamed subsidiary",
});
console.log("Sub-account updated.", { id: subAccount.id, status: subAccount.status });`,
    { guarded: true },
  ),
  entry(
    "deleteSubAccount",
    "DELETE /v2/accounts/{account_id}/sub-accounts/{sub_account_id}",
    "client.subAccounts.delete",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const result = await client.subAccounts.delete(subAccountId);
console.log("Sub-account deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "suspendSubAccount",
    "POST /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/suspend",
    "client.subAccounts.suspend",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const subAccount = await client.subAccounts.suspend(subAccountId, {
  reason: "Requested by account administrator",
});
console.log("Sub-account suspended.", { id: subAccount.id, status: subAccount.status });`,
    { guarded: true },
  ),
  entry(
    "unsuspendSubAccount",
    "POST /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/unsuspend",
    "client.subAccounts.unsuspend",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const subAccount = await client.subAccounts.unsuspend(subAccountId);
console.log("Sub-account unsuspended.", { id: subAccount.id, status: subAccount.status });`,
    { guarded: true },
  ),
  entry(
    "listSubAccountAPIKeys",
    "GET /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys",
    "client.subAccounts.apiKeys.list",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const page = await client.subAccounts.apiKeys.list(subAccountId, { limit: 20 });
console.log("Sub-account API keys listed.", { count: page.data.length });`,
  ),
  entry(
    "createSubAccountAPIKey",
    "POST /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys",
    "client.subAccounts.apiKeys.create",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const apiKey = await client.subAccounts.apiKeys.create(
  subAccountId,
  { label: "Bootstrap key", scopes: ["messages:send:all"] },
  { idempotencyKey: "sdk-sample-create-sub-account-api-key" },
);
console.log("Sub-account API key created.", { id: apiKey.id, label: apiKey.label });`,
    { guarded: true },
  ),
  entry(
    "getSubAccountAPIKey",
    "GET /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
    "client.subAccounts.apiKeys.get",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const keyId = "00000000-0000-4000-8000-000000000005";
const apiKey = await client.subAccounts.apiKeys.get(subAccountId, keyId);
console.log("Sub-account API key found.", { id: apiKey.id, label: apiKey.label });`,
  ),
  entry(
    "updateSubAccountAPIKey",
    "PUT /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
    "client.subAccounts.apiKeys.update",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const keyId = "00000000-0000-4000-8000-000000000005";
const apiKey = await client.subAccounts.apiKeys.update(subAccountId, keyId, {
  label: "Renamed bootstrap key",
});
console.log("Sub-account API key updated.", { id: apiKey.id, label: apiKey.label });`,
    { guarded: true },
  ),
  entry(
    "deleteSubAccountAPIKey",
    "DELETE /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
    "client.subAccounts.apiKeys.delete",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const keyId = "00000000-0000-4000-8000-000000000005";
const result = await client.subAccounts.apiKeys.delete(subAccountId, keyId);
console.log("Sub-account API key deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getSuppressions",
    "GET /v2/accounts/{account_id}/suppressions",
    "client.suppressions.list",
    `const page = await client.suppressions.list({ limit: 20 });
console.log("Suppressions listed.", { count: page.data.length });`,
  ),
  entry(
    "createSuppression",
    "POST /v2/accounts/{account_id}/suppressions",
    "client.suppressions.create",
    `const result = await client.suppressions.create(
  {
    email: "recipient@example.net",
    reason: "User requested removal",
    expires_at: "2030-01-01T00:00:00Z",
  },
  { idempotencyKey: "sdk-sample-create-suppression" },
);
console.log("Suppression created.", { count: result.data.length });`,
    { guarded: true },
  ),
  entry(
    "deleteSuppression",
    "DELETE /v2/accounts/{account_id}/suppressions",
    "client.suppressions.delete",
    `const result = await client.suppressions.delete({ email: "recipient@example.net" });
console.log("Suppression deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "deleteAllSuppressions",
    "DELETE /v2/accounts/{account_id}/suppressions/all",
    "client.suppressions.wipe",
    `const result = await client.suppressions.wipe({ domain: "example.com" });
console.log("Domain suppressions deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getRoutes",
    "GET /v2/accounts/{account_id}/routes",
    "client.routes.list",
    `const page = await client.routes.list({ domain: "example.com", limit: 20 });
console.log("Routes listed.", { count: page.data.length });`,
  ),
  entry(
    "createRoute",
    "POST /v2/accounts/{account_id}/routes",
    "client.routes.create",
    `const route = await client.routes.create(
  {
    name: "Inbound messages",
    url: "https://example.com/inbound",
    recipient: "inbound@example.com",
  },
  { idempotencyKey: "sdk-sample-create-route" },
);
console.log("Route created.", { id: route.id, name: route.name });`,
    { guarded: true },
  ),
  entry(
    "getRoute",
    "GET /v2/accounts/{account_id}/routes/{route_id}",
    "client.routes.get",
    `const routeId = "00000000-0000-4000-8000-000000000006";
const route = await client.routes.get(routeId);
console.log("Route found.", { id: route.id, name: route.name });`,
  ),
  entry(
    "updateRoute",
    "PUT /v2/accounts/{account_id}/routes/{route_id}",
    "client.routes.update",
    `const routeId = "00000000-0000-4000-8000-000000000006";
const route = await client.routes.update(routeId, {
  url: "https://example.com/inbound-v2",
});
console.log("Route updated.", { id: route.id, name: route.name });`,
    { guarded: true },
  ),
  entry(
    "deleteRoute",
    "DELETE /v2/accounts/{account_id}/routes/{route_id}",
    "client.routes.delete",
    `const routeId = "00000000-0000-4000-8000-000000000006";
const result = await client.routes.delete(routeId);
console.log("Route deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getWebhooks",
    "GET /v2/accounts/{account_id}/webhooks",
    "client.webhooks.list",
    `const page = await client.webhooks.list({ limit: 20 });
console.log("Webhooks listed.", { count: page.data.length });`,
  ),
  entry(
    "createWebhook",
    "POST /v2/accounts/{account_id}/webhooks",
    "client.webhooks.create",
    `const webhook = await client.webhooks.create(
  {
    name: "Delivery events",
    url: "https://example.com/webhooks/ahasend",
    scope: "global",
    on_delivered: true,
  },
  { idempotencyKey: "sdk-sample-create-webhook" },
);
console.log("Webhook created.", { id: webhook.id, name: webhook.name });`,
    { guarded: true },
  ),
  entry(
    "getWebhook",
    "GET /v2/accounts/{account_id}/webhooks/{webhook_id}",
    "client.webhooks.get",
    `const webhookId = "00000000-0000-4000-8000-000000000007";
const webhook = await client.webhooks.get(webhookId);
console.log("Webhook found.", { id: webhook.id, name: webhook.name });`,
  ),
  entry(
    "updateWebhook",
    "PUT /v2/accounts/{account_id}/webhooks/{webhook_id}",
    "client.webhooks.update",
    `const webhookId = "00000000-0000-4000-8000-000000000007";
const webhook = await client.webhooks.update(webhookId, {
  name: "Transactional delivery events",
});
console.log("Webhook updated.", { id: webhook.id, name: webhook.name });`,
    { guarded: true },
  ),
  entry(
    "deleteWebhook",
    "DELETE /v2/accounts/{account_id}/webhooks/{webhook_id}",
    "client.webhooks.delete",
    `const webhookId = "00000000-0000-4000-8000-000000000007";
const result = await client.webhooks.delete(webhookId);
console.log("Webhook deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getSMTPCredentials",
    "GET /v2/accounts/{account_id}/smtp-credentials",
    "client.smtpCredentials.list",
    `const page = await client.smtpCredentials.list({ limit: 20 });
console.log("SMTP credentials listed.", { count: page.data.length });`,
  ),
  entry(
    "createSMTPCredential",
    "POST /v2/accounts/{account_id}/smtp-credentials",
    "client.smtpCredentials.create",
    `const credential = await client.smtpCredentials.create(
  { name: "Production SMTP", scope: "global" },
  { idempotencyKey: "sdk-sample-create-smtp-credential" },
);
console.log("SMTP credential created.", { id: credential.id, name: credential.name });`,
    { guarded: true },
  ),
  entry(
    "getSMTPCredential",
    "GET /v2/accounts/{account_id}/smtp-credentials/{smtp_credential_id}",
    "client.smtpCredentials.get",
    `const credentialId = "00000000-0000-4000-8000-000000000008";
const credential = await client.smtpCredentials.get(credentialId);
console.log("SMTP credential found.", { id: credential.id, name: credential.name });`,
  ),
  entry(
    "deleteSMTPCredential",
    "DELETE /v2/accounts/{account_id}/smtp-credentials/{smtp_credential_id}",
    "client.smtpCredentials.delete",
    `const credentialId = "00000000-0000-4000-8000-000000000008";
const result = await client.smtpCredentials.delete(credentialId);
console.log("SMTP credential deleted.", { message: result.message });`,
    { guarded: true },
  ),
  entry(
    "getDeliverabilityStatistics",
    "GET /v2/accounts/{account_id}/statistics/transactional/deliverability",
    "client.statistics.deliverability",
    `const statistics = await client.statistics.deliverability({
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
});
console.log("Deliverability statistics loaded.", { buckets: statistics.data.length });`,
  ),
  entry(
    "getBounceStatistics",
    "GET /v2/accounts/{account_id}/statistics/transactional/bounce",
    "client.statistics.bounces",
    `const statistics = await client.statistics.bounces({
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
});
console.log("Bounce statistics loaded.", { buckets: statistics.data.length });`,
  ),
  entry(
    "getDeliveryTimeStatistics",
    "GET /v2/accounts/{account_id}/statistics/transactional/delivery-time",
    "client.statistics.deliveryTimes",
    `const statistics = await client.statistics.deliveryTimes({
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
});
console.log("Delivery-time statistics loaded.", { buckets: statistics.data.length });`,
  ),
]);

export const NODE_OPERATION_KEYS = Object.freeze(
  Object.fromEntries(
    NODE_SAMPLE_REGISTRY.map(({ operationId, operationKey }) => [operationId, operationKey]),
  ),
);

export const NODE_CODE_SAMPLES = Object.freeze(
  Object.fromEntries(NODE_SAMPLE_REGISTRY.map(({ operationId, sample }) => [operationId, sample])),
);
