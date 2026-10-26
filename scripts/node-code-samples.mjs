function sdkSource(body) {
  return `import { AhaSendClient } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();
${body}
`;
}

function entry(operationId, operationKey, facade, body) {
  return Object.freeze({
    operationId,
    operationKey,
    facade,
    sample: Object.freeze({
      lang: NODE_SAMPLE_LANGUAGE,
      label: NODE_SAMPLE_LABEL,
      source: sdkSource(body),
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const apiKey = await client.apiKeys.create({
  label: "Production API key",
  scopes: ["messages:send:all"],
});
console.log("API key created.", { id: apiKey.id, label: apiKey.label });`,
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
  ),
  entry(
    "deleteAPIKey",
    "DELETE /v2/accounts/{account_id}/api-keys/{key_id}",
    "client.apiKeys.delete",
    `const keyId = "00000000-0000-4000-8000-000000000001";
const result = await client.apiKeys.delete(keyId);
console.log("API key deleted.", { message: result.message });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const domain = await client.domains.create({ domain: "example.com" });
console.log("Domain created.", { id: domain.id, domain: domain.domain });`,
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
  ),
  entry(
    "deleteDomain",
    "DELETE /v2/accounts/{account_id}/domains/{domain}",
    "client.domains.delete",
    `const domainName = "example.com";
const result = await client.domains.delete(domainName);
console.log("Domain deleted.", { message: result.message });`,
  ),
  entry(
    "checkDomainDNS",
    "POST /v2/accounts/{account_id}/domains/{domain}/check-dns",
    "client.domains.checkDns",
    `const domainName = "example.com";
const domain = await client.domains.checkDns(domainName);
console.log("DNS check completed.", { domain: domain.domain, dnsValid: domain.dns_valid });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.messages.send({
  from: { email: "sender@example.com", name: "Example" },
  recipients: [{ email: "recipient@example.net" }],
  subject: "Hello from AhaSend",
  html_content: "<p>Hello!</p>",
  sandbox: true,
});
console.log("Sandbox message accepted.", { count: result.data.length });`,
  ),
  entry(
    "createTemplateMessage",
    "POST /v2/accounts/{account_id}/messages/template",
    "client.messages.sendTemplate",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.messages.sendTemplate({
  template_id: "00000000-0000-4000-8000-000000000009",
  recipients: [{ email: "recipient@example.net", substitutions: { first_name: "Ada" } }],
  sandbox: true,
});
console.log("Sandbox template message accepted.", { count: result.data.length });`,
  ),
  entry(
    "createConversationMessage",
    "POST /v2/accounts/{account_id}/messages/conversation",
    "client.messages.sendConversation",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.messages.sendConversation({
  from: { email: "sender@example.com", name: "Example" },
  to: [{ email: "recipient@example.net" }],
  subject: "Hello from AhaSend",
  html_content: "<p>Hello!</p>",
  sandbox: true,
});
console.log("Sandbox conversation accepted.", { count: result.data.length });`,
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
  ),
  entry(
    "listTemplates",
    "GET /v2/accounts/{account_id}/templates",
    "client.templates.list",
    `const page = await client.templates.list({ limit: 20 });
console.log("Templates listed.", { count: page.data.length });`,
  ),
  entry(
    "createTemplate",
    "POST /v2/accounts/{account_id}/templates",
    "client.templates.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const template = await client.templates.create({
  name: "Welcome email",
  subject: "Welcome, {{ first_name }}",
  content: { html: "<p>Hello {{ first_name }}, welcome aboard.</p>" },
  publish: true,
});
console.log("Template created.", { id: template.id, editor: template.editor });`,
  ),
  entry(
    "getTemplate",
    "GET /v2/accounts/{account_id}/templates/{template_id}",
    "client.templates.get",
    `const templateId = "00000000-0000-4000-8000-000000000009";
const template = await client.templates.get(templateId);
console.log("Template found.", { id: template.id, name: template.name });`,
  ),
  entry(
    "updateTemplate",
    "PUT /v2/accounts/{account_id}/templates/{template_id}",
    "client.templates.update",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const templateId = "00000000-0000-4000-8000-000000000009";
// Fields go to the template's draft; publish: true also publishes it.
// A simple design is written as AhaSend Markup (AhaML) in content.markup.
const template = await client.templates.update(templateId, {
  subject: "Welcome to the team, {{ first_name }}",
  content: {
    markup: \`<Email version="1">
  <Heading level="3">Welcome to the team</Heading>
  <Paragraph>Hi <Var name="first_name" fallback="there"/>, thanks for signing up.</Paragraph>
</Email>
\`,
  },
  publish: true,
});
console.log("Template updated.", { id: template.id, hasDraft: template.has_draft });`,
  ),
  entry(
    "deleteTemplate",
    "DELETE /v2/accounts/{account_id}/templates/{template_id}",
    "client.templates.delete",
    `const templateId = "00000000-0000-4000-8000-000000000009";
const result = await client.templates.delete(templateId);
console.log("Template deleted.", { message: result.message });`,
  ),
  entry(
    "getPublishedTemplate",
    "GET /v2/accounts/{account_id}/templates/{template_id}/published",
    "client.templates.getPublished",
    `const templateId = "00000000-0000-4000-8000-000000000009";
// The published copy is the one a send uses; get() returns the draft while one exists.
const template = await client.templates.getPublished(templateId);
console.log("Published template found.", {
  subject: template.subject,
  hasDraft: template.has_draft,
  variables: template.variables.length,
});`,
  ),
  entry(
    "discardTemplateDraft",
    "DELETE /v2/accounts/{account_id}/templates/{template_id}/draft",
    "client.templates.discardDraft",
    `const templateId = "00000000-0000-4000-8000-000000000009";
const template = await client.templates.discardDraft(templateId);
console.log("Template draft discarded.", { id: template.id, hasDraft: template.has_draft });`,
  ),
  entry(
    "publishTemplate",
    "POST /v2/accounts/{account_id}/templates/{template_id}/publish",
    "client.templates.publish",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const templateId = "00000000-0000-4000-8000-000000000009";
const template = await client.templates.publish(templateId);
console.log("Template published.", { id: template.id, hasDraft: template.has_draft });`,
  ),
  entry(
    "listTemplateVersions",
    "GET /v2/accounts/{account_id}/templates/{template_id}/versions",
    "client.templates.listVersions",
    `const templateId = "00000000-0000-4000-8000-000000000009";
const versions = await client.templates.listVersions(templateId);
console.log("Template versions listed.", { count: versions.data.length });`,
  ),
  entry(
    "getTemplateVersion",
    "GET /v2/accounts/{account_id}/templates/{template_id}/versions/{version_id}",
    "client.templates.getVersion",
    `const templateId = "00000000-0000-4000-8000-000000000009";
const versionId = "00000000-0000-4000-8000-000000000012";
const version = await client.templates.getVersion(templateId, versionId);
console.log("Template version found.", { id: version.id, version: version.version });`,
  ),
  entry(
    "restoreTemplateVersion",
    "POST /v2/accounts/{account_id}/templates/{template_id}/versions/{version_id}/restore",
    "client.templates.restoreVersion",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const templateId = "00000000-0000-4000-8000-000000000009";
const versionId = "00000000-0000-4000-8000-000000000012";
const template = await client.templates.restoreVersion(templateId, versionId, { publish: true });
console.log("Template version restored.", { id: template.id, hasDraft: template.has_draft });`,
  ),
  entry(
    "listCampaignTemplates",
    "GET /v2/accounts/{account_id}/campaign-templates",
    "client.campaignTemplates.list",
    `const page = await client.campaignTemplates.list({ limit: 20 });
console.log("Campaign templates listed.", { count: page.data.length });`,
  ),
  entry(
    "createCampaignTemplate",
    "POST /v2/accounts/{account_id}/campaign-templates",
    "client.campaignTemplates.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const template = await client.campaignTemplates.create({
  name: "Monthly newsletter",
  content: {
    html: '<p>Hello {{ first_name }}.</p><p><a href="{{ unsubscribe_url }}">Unsubscribe</a></p>',
  },
});
console.log("Campaign template created.", { id: template.id, editor: template.editor });`,
  ),
  entry(
    "getCampaignTemplate",
    "GET /v2/accounts/{account_id}/campaign-templates/{template_id}",
    "client.campaignTemplates.get",
    `const templateId = "00000000-0000-4000-8000-000000000013";
const template = await client.campaignTemplates.get(templateId);
console.log("Campaign template found.", { id: template.id, name: template.name });`,
  ),
  entry(
    "updateCampaignTemplate",
    "PUT /v2/accounts/{account_id}/campaign-templates/{template_id}",
    "client.campaignTemplates.update",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const templateId = "00000000-0000-4000-8000-000000000013";
// Campaigns already made from the template keep their own copies.
const template = await client.campaignTemplates.update(templateId, {
  name: "Monthly newsletter (2026)",
});
console.log("Campaign template updated.", { id: template.id, name: template.name });`,
  ),
  entry(
    "deleteCampaignTemplate",
    "DELETE /v2/accounts/{account_id}/campaign-templates/{template_id}",
    "client.campaignTemplates.delete",
    `const templateId = "00000000-0000-4000-8000-000000000013";
const result = await client.campaignTemplates.delete(templateId);
console.log("Campaign template deleted.", { message: result.message });`,
  ),
  entry(
    "listCampaigns",
    "GET /v2/accounts/{account_id}/campaigns",
    "client.campaigns.list",
    `const page = await client.campaigns.list({ status: "draft", limit: 20 });
console.log("Campaigns listed.", { count: page.data.length });`,
  ),
  entry(
    "createCampaign",
    "POST /v2/accounts/{account_id}/campaigns",
    "client.campaigns.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaign = await client.campaigns.create({
  name: "October newsletter",
  subject: "What is new in October",
  preheader: "Three things we shipped this month",
  from: { email: "news@example.com", name: "Example" },
  list_ids: ["00000000-0000-4000-8000-000000000010"],
  template_id: "00000000-0000-4000-8000-000000000013",
});
console.log("Campaign created.", { id: campaign.id, ready: campaign.ready });`,
  ),
  entry(
    "getCampaign",
    "GET /v2/accounts/{account_id}/campaigns/{campaign_id}",
    "client.campaigns.get",
    `const campaignId = "00000000-0000-4000-8000-000000000014";
const campaign = await client.campaigns.get(campaignId);
console.log("Campaign found.", { id: campaign.id, status: campaign.status, ready: campaign.ready });`,
  ),
  entry(
    "updateCampaign",
    "PUT /v2/accounts/{account_id}/campaigns/{campaign_id}",
    "client.campaigns.update",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaignId = "00000000-0000-4000-8000-000000000014";
// Only a draft can change; null clears the reply-to address.
const campaign = await client.campaigns.update(campaignId, {
  subject: "What we shipped in October",
  reply_to: null,
});
console.log("Campaign updated.", { id: campaign.id, ready: campaign.ready });`,
  ),
  entry(
    "deleteCampaign",
    "DELETE /v2/accounts/{account_id}/campaigns/{campaign_id}",
    "client.campaigns.delete",
    `const campaignId = "00000000-0000-4000-8000-000000000014";
const result = await client.campaigns.delete(campaignId);
console.log("Campaign deleted.", { message: result.message });`,
  ),
  entry(
    "duplicateCampaign",
    "POST /v2/accounts/{account_id}/campaigns/{campaign_id}/duplicate",
    "client.campaigns.duplicate",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaignId = "00000000-0000-4000-8000-000000000014";
const copy = await client.campaigns.duplicate(campaignId, { name: "November newsletter" });
console.log("Campaign duplicated.", { id: copy.id, status: copy.status });`,
  ),
  entry(
    "sendCampaign",
    "POST /v2/accounts/{account_id}/campaigns/{campaign_id}/send",
    "client.campaigns.send",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaignId = "00000000-0000-4000-8000-000000000014";
// Leave send_at out to send now. The campaign is checked before it sends.
const campaign = await client.campaigns.send(campaignId, { send_at: "2030-01-01T09:00:00Z" });
console.log("Campaign send accepted.", { status: campaign.status, warnings: campaign.warnings });`,
  ),
  entry(
    "unscheduleCampaign",
    "POST /v2/accounts/{account_id}/campaigns/{campaign_id}/unschedule",
    "client.campaigns.unschedule",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaignId = "00000000-0000-4000-8000-000000000014";
const campaign = await client.campaigns.unschedule(campaignId);
console.log("Campaign unscheduled.", { id: campaign.id, status: campaign.status });`,
  ),
  entry(
    "testCampaign",
    "POST /v2/accounts/{account_id}/campaigns/{campaign_id}/test",
    "client.campaigns.test",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const campaignId = "00000000-0000-4000-8000-000000000014";
const result = await client.campaigns.test(campaignId, { to: ["reviewer@example.com"] });
console.log("Campaign test sent.", {
  sentTo: result.sent_to,
  failed: result.failed.length,
  resultUnknown: result.result_unknown,
});`,
  ),
  entry(
    "getCampaignStats",
    "GET /v2/accounts/{account_id}/campaigns/{campaign_id}/stats",
    "client.campaigns.getStats",
    `const campaignId = "00000000-0000-4000-8000-000000000014";
const stats = await client.campaigns.getStats(campaignId);
console.log("Campaign stats loaded.", { delivered: stats.delivered, rates: stats.rates });`,
  ),
  entry(
    "listCampaignRecipients",
    "GET /v2/accounts/{account_id}/campaigns/{campaign_id}/recipients",
    "client.campaigns.recipients.list",
    `const campaignId = "00000000-0000-4000-8000-000000000014";
// Send exactly one of status and bounce_classification.
const page = await client.campaigns.recipients.list(campaignId, { status: "Delivered", limit: 20 });
console.log("Campaign recipients listed.", { count: page.data.length });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const member = await client.accounts.addMember({
  email: "developer@example.com",
  role: "Developer",
});
console.log("Account member added.", { userId: member.user_id, role: member.role });`,
  ),
  entry(
    "removeAccountMember",
    "DELETE /v2/accounts/{account_id}/members/{user_id}",
    "client.accounts.removeMember",
    `const userId = "00000000-0000-4000-8000-000000000003";
const result = await client.accounts.removeMember(userId);
console.log("Account member removed.", { message: result.message });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const subAccount = await client.subAccounts.create({
  name: "Example subsidiary",
  website: "subsidiary.example.com",
});
console.log("Sub-account created.", { id: subAccount.id, status: subAccount.status });`,
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
  ),
  entry(
    "deleteSubAccount",
    "DELETE /v2/accounts/{account_id}/sub-accounts/{sub_account_id}",
    "client.subAccounts.delete",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const result = await client.subAccounts.delete(subAccountId);
console.log("Sub-account deleted.", { message: result.message });`,
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
  ),
  entry(
    "unsuspendSubAccount",
    "POST /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/unsuspend",
    "client.subAccounts.unsuspend",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const subAccount = await client.subAccounts.unsuspend(subAccountId);
console.log("Sub-account unsuspended.", { id: subAccount.id, status: subAccount.status });`,
  ),
  entry(
    "unpauseSubAccountDomain",
    "POST /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/domains/{domain}/unpause",
    "client.subAccounts.unpauseDomain",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const domain = await client.subAccounts.unpauseDomain(subAccountId, "mail.example.com");
console.log("Sub-account domain unpaused.", { name: domain.domain, paused: domain.paused });`,
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
// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const apiKey = await client.subAccounts.apiKeys.create(subAccountId, {
  label: "Bootstrap key",
  scopes: ["messages:send:all"],
});
console.log("Sub-account API key created.", { id: apiKey.id, label: apiKey.label });`,
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
  ),
  entry(
    "deleteSubAccountAPIKey",
    "DELETE /v2/accounts/{account_id}/sub-accounts/{sub_account_id}/api-keys/{key_id}",
    "client.subAccounts.apiKeys.delete",
    `const subAccountId = "00000000-0000-4000-8000-000000000004";
const keyId = "00000000-0000-4000-8000-000000000005";
const result = await client.subAccounts.apiKeys.delete(subAccountId, keyId);
console.log("Sub-account API key deleted.", { message: result.message });`,
  ),
  entry(
    "getContacts",
    "GET /v2/accounts/{account_id}/contacts",
    "client.contacts.list",
    `const page = await client.contacts.list({ status: "enabled", subscribed: true, limit: 20 });
console.log("Contacts listed.", { count: page.data.length });`,
  ),
  entry(
    "createContact",
    "POST /v2/accounts/{account_id}/contacts",
    "client.contacts.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const contact = await client.contacts.create({
  email: "person@example.com",
  first_name: "Pat",
  attributes: { customer: true },
});
console.log("Contact created.", { id: contact.id, status: contact.status });`,
  ),
  entry(
    "batchUpsertContacts",
    "POST /v2/accounts/{account_id}/contacts/batch",
    "client.contacts.batchUpsert",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.contacts.batchUpsert({
  data: [
    { email: "new@example.com", attributes: { customer: true } },
    { email: "existing@example.com", attributes: { obsolete: null } },
  ],
});
console.log("Contact batch completed.", { created: result.created, updated: result.updated });`,
  ),
  entry(
    "getContact",
    "GET /v2/accounts/{account_id}/contacts/{id_or_email}",
    "client.contacts.get",
    `const idOrEmail = "User+Tag@Example.COM";
const contact = await client.contacts.get(idOrEmail);
console.log("Contact found.", { id: contact.id, status: contact.status });`,
  ),
  entry(
    "updateContact",
    "PUT /v2/accounts/{account_id}/contacts/{id_or_email}",
    "client.contacts.update",
    `const idOrEmail = "User+Tag@Example.COM";
const contact = await client.contacts.update(idOrEmail, {
  unsubscribed: true,
  attributes: { obsolete: null },
});
console.log("Contact updated.", { id: contact.id, unsubscribed: contact.unsubscribed });`,
  ),
  entry(
    "deleteContact",
    "DELETE /v2/accounts/{account_id}/contacts/{id_or_email}",
    "client.contacts.delete",
    `const idOrEmail = "User+Tag@Example.COM";
const result = await client.contacts.delete(idOrEmail);
console.log("Contact deleted.", { message: result.message });`,
  ),
  entry(
    "getLists",
    "GET /v2/accounts/{account_id}/lists",
    "client.lists.list",
    `const page = await client.lists.list({ name: "newsletter", limit: 20 });
console.log("Lists listed.", { count: page.data.length });`,
  ),
  entry(
    "createList",
    "POST /v2/accounts/{account_id}/lists",
    "client.lists.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const list = await client.lists.create({
  name: "Product updates",
  description: "Monthly release notes",
  tags: ["product"],
});
console.log("List created.", { id: list.id, contactCount: list.contact_count });`,
  ),
  entry(
    "getList",
    "GET /v2/accounts/{account_id}/lists/{list_id}",
    "client.lists.get",
    `const listId = "00000000-0000-4000-8000-000000000010";
const list = await client.lists.get(listId);
console.log("List found.", { id: list.id, contactCount: list.contact_count });`,
  ),
  entry(
    "updateList",
    "PUT /v2/accounts/{account_id}/lists/{list_id}",
    "client.lists.update",
    `const listId = "00000000-0000-4000-8000-000000000010";
const list = await client.lists.update(listId, { name: "Product news", tags: [] });
console.log("List updated.", { id: list.id, name: list.name });`,
  ),
  entry(
    "deleteList",
    "DELETE /v2/accounts/{account_id}/lists/{list_id}",
    "client.lists.delete",
    `const listId = "00000000-0000-4000-8000-000000000010";
const result = await client.lists.delete(listId);
console.log("List deleted.", { message: result.message });`,
  ),
  entry(
    "getListContacts",
    "GET /v2/accounts/{account_id}/lists/{list_id}/contacts",
    "client.lists.contacts.list",
    `const listId = "00000000-0000-4000-8000-000000000010";
const page = await client.lists.contacts.list(listId, {
  subscription_status: "confirmed",
  limit: 20,
});
console.log("List members listed.", { count: page.data.length });`,
  ),
  entry(
    "batchAddListContacts",
    "POST /v2/accounts/{account_id}/lists/{list_id}/contacts/batch",
    "client.lists.contacts.batchAdd",
    `const listId = "00000000-0000-4000-8000-000000000010";
// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.lists.contacts.batchAdd(listId, {
  data: [{ email: "one@example.com" }, { id: "00000000-0000-4000-8000-000000000011" }],
});
console.log("List batch completed.", { added: result.added, failed: result.failed });`,
  ),
  entry(
    "upsertListContact",
    "PUT /v2/accounts/{account_id}/lists/{list_id}/contacts/{id_or_email}",
    "client.lists.contacts.upsert",
    `const listId = "00000000-0000-4000-8000-000000000010";
const idOrEmail = "User+Tag@Example.COM";
const membership = await client.lists.contacts.upsert(listId, idOrEmail, {
  subscription_status: "unsubscribed",
});
console.log("List membership saved.", { status: membership.subscription_status });`,
  ),
  entry(
    "deleteListContact",
    "DELETE /v2/accounts/{account_id}/lists/{list_id}/contacts/{id_or_email}",
    "client.lists.contacts.delete",
    `const listId = "00000000-0000-4000-8000-000000000010";
const idOrEmail = "User+Tag@Example.COM";
const result = await client.lists.contacts.delete(listId, idOrEmail);
console.log("Contact removed from list.", { message: result.message });`,
  ),
  entry(
    "getContactLists",
    "GET /v2/accounts/{account_id}/contacts/{id_or_email}/lists",
    "client.contacts.lists.list",
    `const idOrEmail = "User+Tag@Example.COM";
const page = await client.contacts.lists.list(idOrEmail, { subscription_status: "confirmed" });
console.log("Contact lists listed.", { count: page.data.length });`,
  ),
  entry(
    "getSegments",
    "GET /v2/accounts/{account_id}/segments",
    "client.segments.list",
    `const page = await client.segments.list({ limit: 20 });
console.log("Segments listed.", { count: page.data.length });`,
  ),
  entry(
    "createSegment",
    "POST /v2/accounts/{account_id}/segments",
    "client.segments.create",
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
// A group holds conditions only, so groups nest one level deep.
const segment = await client.segments.create({
  name: "Engaged customers in Germany",
  timezone: "Europe/Berlin",
  definition: {
    schema_version: 1,
    match: "all",
    conditions: [
      { field: "attributes.country", op: "equal", value: "DE" },
      { field: "created_at", op: "after", value: "30 days ago" },
      { field: "list", op: "in", value: "00000000-0000-4000-8000-000000000010" },
      {
        match: "any",
        conditions: [
          { field: "campaign", op: "opened", value: "00000000-0000-4000-8000-000000000014" },
          { field: "any_campaign", op: "clicked", value: "14 days ago" },
          {
            field: "campaign_count",
            op: "opened_at_least",
            value: { count: 3, since: "90 days ago" },
          },
        ],
      },
    ],
  },
});
// A new segment is building until its members are found.
console.log("Segment created.", { id: segment.id, state: segment.state });`,
  ),
  entry(
    "previewSegment",
    "POST /v2/accounts/{account_id}/segments/preview",
    "client.segments.preview",
    `// Nothing is saved. count is null when the contacts cannot be counted within 10 seconds.
const preview = await client.segments.preview({
  definition: {
    schema_version: 1,
    match: "all",
    conditions: [{ field: "created_at", op: "after", value: "30 days ago" }],
  },
});
console.log("Segment previewed.", { count: preview.count, shown: preview.contacts.length });`,
  ),
  entry(
    "getSegment",
    "GET /v2/accounts/{account_id}/segments/{segment_id}",
    "client.segments.get",
    `const segmentId = "00000000-0000-4000-8000-000000000015";
const segment = await client.segments.get(segmentId);
// marketable_count is null while the segment is not ready.
console.log("Segment found.", {
  id: segment.id,
  state: segment.state,
  marketableCount: segment.marketable_count,
});`,
  ),
  entry(
    "updateSegment",
    "PUT /v2/accounts/{account_id}/segments/{segment_id}",
    "client.segments.update",
    `const segmentId = "00000000-0000-4000-8000-000000000015";
// A changed definition or time zone builds the members again; a new name does not.
const segment = await client.segments.update(segmentId, { name: "Engaged German customers" });
console.log("Segment updated.", { id: segment.id, name: segment.name });`,
  ),
  entry(
    "deleteSegment",
    "DELETE /v2/accounts/{account_id}/segments/{segment_id}",
    "client.segments.delete",
    `const segmentId = "00000000-0000-4000-8000-000000000015";
const result = await client.segments.delete(segmentId);
console.log("Segment deleted.", { message: result.message });`,
  ),
  entry(
    "getSegmentContacts",
    "GET /v2/accounts/{account_id}/segments/{segment_id}/contacts",
    "client.segments.contacts.list",
    `const segmentId = "00000000-0000-4000-8000-000000000015";
const page = await client.segments.contacts.list(segmentId, { limit: 20 });
console.log("Segment members listed.", { count: page.data.length });`,
  ),
  entry(
    "getContactSegments",
    "GET /v2/accounts/{account_id}/contacts/{id_or_email}/segments",
    "client.contacts.segments.list",
    `const idOrEmail = "User+Tag@Example.COM";
const page = await client.contacts.segments.list(idOrEmail, { limit: 20 });
console.log("Contact segments listed.", { count: page.data.length });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const result = await client.suppressions.create({
  email: "recipient@example.net",
  reason: "User requested removal",
  expires_at: "2030-01-01T00:00:00Z",
});
console.log("Suppression created.", { count: result.data.length });`,
  ),
  entry(
    "deleteSuppression",
    "DELETE /v2/accounts/{account_id}/suppressions",
    "client.suppressions.delete",
    `const result = await client.suppressions.delete({ email: "recipient@example.net" });
console.log("Suppression deleted.", { message: result.message });`,
  ),
  entry(
    "deleteAllSuppressions",
    "DELETE /v2/accounts/{account_id}/suppressions/all",
    "client.suppressions.wipe",
    `const result = await client.suppressions.wipe({ domain: "example.com" });
console.log("Domain suppressions deleted.", { message: result.message });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const route = await client.routes.create({
  name: "Inbound messages",
  url: "https://example.com/inbound",
  recipient: "inbound@example.com",
});
console.log("Route created.", { id: route.id, name: route.name });`,
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
  ),
  entry(
    "deleteRoute",
    "DELETE /v2/accounts/{account_id}/routes/{route_id}",
    "client.routes.delete",
    `const routeId = "00000000-0000-4000-8000-000000000006";
const result = await client.routes.delete(routeId);
console.log("Route deleted.", { message: result.message });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const webhook = await client.webhooks.create({
  name: "Delivery events",
  url: "https://example.com/webhooks/ahasend",
  scope: "global",
  on_delivered: true,
});
console.log("Webhook created.", { id: webhook.id, name: webhook.name });`,
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
  ),
  entry(
    "deleteWebhook",
    "DELETE /v2/accounts/{account_id}/webhooks/{webhook_id}",
    "client.webhooks.delete",
    `const webhookId = "00000000-0000-4000-8000-000000000007";
const result = await client.webhooks.delete(webhookId);
console.log("Webhook deleted.", { message: result.message });`,
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
    `// The SDK sends a fresh Idempotency-Key automatically and reuses it on its own retries.
const credential = await client.smtpCredentials.create({
  name: "Production SMTP",
  scope: "global",
});
console.log("SMTP credential created.", { id: credential.id, name: credential.name });`,
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
