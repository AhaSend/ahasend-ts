import type {
  AhaSendClient,
  CreateMessageRequest,
  CreateSMTPCredentialRequest,
  CreateWebhookRequest,
  ListDomainsParams,
  ListMessagesParams,
  ListRoutesParams,
  ListSuppressionsParams,
  ListWebhooksParams,
  PaginationParams,
  UpdateWebhookRequest,
} from "@ahasend/sdk";
import {
  AhaSendAbortError,
  AhaSendAPIError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConflictError,
  AhaSendConfigurationError,
  AhaSendConnectionError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  AhaSendIdempotencyMismatchError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
  AhaSendRateLimitError,
  AhaSendResponseParseError,
  AhaSendServerError,
  AhaSendTimeoutError,
  AhaSendUnprocessableEntityError,
} from "@ahasend/sdk";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

declare const client: AhaSendClient;

const messageBody: CreateMessageRequest = {
  from: { email: "sender@example.com" },
  recipients: [{ email: "recipient@example.com" }],
  subject: "Package contract",
  attachments: [{ data: "hello", content_type: "text/plain", file_name: "hello.txt" }],
  tags: ["transactional"],
};
const webhookBody: CreateWebhookRequest = {
  name: "Package webhook",
  url: "https://hooks.example.com/ahasend",
  scope: "scoped",
  domains: ["example.com"],
};
const webhookUpdate: UpdateWebhookRequest = { domains: [] };
const smtpBody: CreateSMTPCredentialRequest = {
  name: "Package SMTP credential",
  scope: "scoped",
  domains: ["example.com"],
};

void client.ping();
void client.messages.send(messageBody);
void client.webhooks.create(webhookBody);
void client.webhooks.update("33333333-3333-4333-8333-333333333333", webhookUpdate);
void client.smtpCredentials.create(smtpBody);
void client.accounts.get();

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

const apiErrorParams = { status: 400, message: "failed", body: null };
void new AhaSendError("failed");
void new AhaSendConfigurationError("failed");
void new AhaSendConnectionError("failed");
void new AhaSendAbortError();
void new AhaSendTimeoutError();
void new AhaSendResponseParseError({ status: 200, body: "invalid" });
void new AhaSendAPIError(apiErrorParams);
void new AhaSendAuthenticationError(apiErrorParams);
void new AhaSendPermissionError(apiErrorParams);
void new AhaSendNotFoundError(apiErrorParams);
void new AhaSendBadRequestError(apiErrorParams);
void new AhaSendConflictError(apiErrorParams);
void new AhaSendIdempotencyConflictError({ ...apiErrorParams, retryAfterSeconds: 1 });
void new AhaSendUnprocessableEntityError(apiErrorParams);
void new AhaSendIdempotencyMismatchError(apiErrorParams);
void new AhaSendRateLimitError({ ...apiErrorParams, retryAfterSeconds: 1 });
void new AhaSendServerError(apiErrorParams);
void new AhaSendWebhookVerificationError("signature_mismatch");

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
