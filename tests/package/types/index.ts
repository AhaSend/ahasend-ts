import type {
  AhaSendClient,
  ListDomainsParams,
  ListMessagesParams,
  ListRoutesParams,
  ListSuppressionsParams,
  ListWebhooksParams,
  PaginationParams,
} from "@ahasend/sdk";
import { WebhookVerifier } from "@ahasend/sdk/webhooks";

declare const client: AhaSendClient;

const direct: PaginationParams = { limit: 25, after: "direct-cursor" };
const domains: ListDomainsParams = { limit: 25, after: "domain-cursor", dns_valid: true };
const messages: ListMessagesParams = {
  limit: 25,
  after: "message-cursor",
  status: "delivered",
  sender: "sender@example.com",
  recipient: "recipient@example.com",
  subject: "subject",
  message_id_header: "<message@example.com>",
  tags: "transactional",
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
};
const routes: ListRoutesParams = { limit: 25, before: "route-cursor", domain: "example.com" };
const suppressions: ListSuppressionsParams = {
  limit: 25,
  before: "suppression-cursor",
  domain: "example.com",
  email: "recipient@example.com",
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
};
const webhooks: ListWebhooksParams = {
  limit: 25,
  before: "webhook-cursor",
  enabled: true,
  on_reception: true,
  on_delivered: true,
  on_transient_error: true,
  on_failed: true,
  on_bounced: true,
  on_suppressed: true,
  on_opened: true,
  on_clicked: true,
  on_suppression_created: true,
  on_dns_error: true,
};

void client.apiKeys.list(direct);
void client.smtpCredentials.list(direct);
void client.subAccounts.list(direct);
void client.subAccounts.apiKeys.list("sub-account-id", direct);
void client.domains.list(domains);
void client.messages.list(messages);
void client.routes.list(routes);
void client.suppressions.list(suppressions);
void client.webhooks.list(webhooks);
void new WebhookVerifier("whsec_dGVzdA==");

// @ts-expect-error Pagination cursors are mutually exclusive.
void client.apiKeys.list({ limit: 25, after: "after", before: "before" });
// @ts-expect-error Pagination cursors are mutually exclusive.
void client.smtpCredentials.list({ limit: 25, after: "after", before: "before" });
// @ts-expect-error Pagination cursors are mutually exclusive.
void client.subAccounts.list({ limit: 25, after: "after", before: "before" });
void client.subAccounts.apiKeys.list("sub-account-id", {
  limit: 25,
  after: "after",
  // @ts-expect-error Pagination cursors are mutually exclusive.
  before: "before",
});
// @ts-expect-error Filtered list parameters retain the cursor XOR.
void client.domains.list({ dns_valid: true, after: "after", before: "before" });
// @ts-expect-error Filtered list parameters retain the cursor XOR.
void client.messages.list({ status: "delivered", after: "after", before: "before" });
// @ts-expect-error Filtered list parameters retain the cursor XOR.
void client.routes.list({ domain: "example.com", after: "after", before: "before" });
void client.suppressions.list({
  email: "recipient@example.com",
  after: "after",
  // @ts-expect-error Filtered list parameters retain the cursor XOR.
  before: "before",
});
// @ts-expect-error Filtered list parameters retain the cursor XOR.
void client.webhooks.list({ enabled: true, after: "after", before: "before" });
