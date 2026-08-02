import type * as SDK from "@ahasend/sdk";
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
import type { ExpressHandler, FastifyHandler, NextHandler } from "@ahasend/sdk/webhooks";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

declare const client: SDK.AhaSendClient;
declare function result<T>(): SDK.AhaSendPromise<T>;
declare function iterator<T>(): AsyncGenerator<T, void, undefined>;

const uuid = "11111111-1111-4111-8111-111111111111";
const messageId = "<11111111-1111-4111-8111-111111111111@example.com>";

const messageBody: SDK.CreateMessageRequest = {
  from: { email: "sender@example.com" },
  recipients: [{ email: "recipient@example.com" }],
  subject: "Package contract",
  attachments: [{ data: "hello", content_type: "text/plain", file_name: "hello.txt" }],
  tags: ["transactional"],
};
const conversationBody: SDK.CreateConversationMessageRequest = {
  from: { email: "sender@example.com" },
  to: [{ email: "recipient@example.com" }],
  subject: "Package conversation contract",
};
const domainBody: SDK.CreateDomainRequest = {
  domain: "example.com",
  dkim_selector: null,
};
const domainUpdate: SDK.UpdateDomainRequest = { dkim_selector: "" };
const domainModel: SDK.Domain = {
  object: "domain",
  id: uuid,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  domain: "example.com",
  account_id: uuid,
  dns_records: [
    {
      type: "TXT",
      host: "selector._domainkey.example.com",
      content: "public-key",
      required: true,
      propagated: false,
    },
  ],
  dns_valid: false,
  last_dns_check_at: null,
  tracking_subdomain: null,
  return_path_subdomain: null,
  subscription_subdomain: null,
  media_subdomain: null,
  dkim_rotation_interval_days: null,
  dkim_selector: null,
  rotation_ready: false,
  dsn_recipient: null,
};
const apiKeyBody: SDK.CreateAPIKeyRequest = {
  label: "Package key",
  scopes: ["messages:send:all"],
  ip_allow_list: ["192.0.2.1"],
};
const apiKeyUpdate: SDK.UpdateAPIKeyRequest = { scopes: ["messages:read:all"] };
const webhookBody: SDK.CreateWebhookRequest = {
  name: "Package webhook",
  url: "https://hooks.example.com/ahasend",
  scope: "scoped",
  domains: ["example.com"],
};
const webhookUpdate: SDK.UpdateWebhookRequest = { domains: [] };
const suppressionBody: SDK.CreateSuppressionRequest = {
  email: "recipient@example.com",
  expires_at: "2026-02-01T00:00:00Z",
};
const routeBody: SDK.CreateRouteRequest = {
  name: "Package route",
  url: "https://routes.example.com/ahasend",
  recipient: "inbox@example.com",
};
const routeUpdate: SDK.UpdateRouteRequest = { enabled: null, recipient: null };
const routeModel: SDK.Route = {
  object: "route",
  id: uuid,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  name: "Package route",
  url: "https://routes.example.com/ahasend",
  recipient: "inbox@example.com",
  attachments: false,
  headers: false,
  group_by_message_id: false,
  strip_replies: false,
  enabled: true,
  success_count: 0,
  error_count: 0,
  errors_since_last_success: 0,
  last_request_at: null,
};
const accountUpdate: SDK.UpdateAccountRequest = { track_opens: true };
const accountModel: SDK.Account = {
  object: "account",
  id: uuid,
  parent_account_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  name: "Package account",
  website: "https://example.com",
  about: "Package type fixture",
  track_opens: true,
  track_clicks: true,
  reject_bad_recipients: true,
  reject_mistyped_recipients: true,
  message_metadata_retention: 30,
  message_data_retention: 7,
  owner_id: uuid,
};
const memberBody: SDK.AddAccountMemberRequest = {
  email: "developer@example.com",
  role: "Developer",
};
const smtpBody: SDK.CreateSMTPCredentialRequest = {
  name: "Package SMTP credential",
  scope: "scoped",
  domains: ["example.com"],
};
const subAccountBody: SDK.CreateSubAccountRequest = {
  name: "Package child",
  website: "https://child.example.com",
};
const subAccountUpdate: SDK.UpdateSubAccountRequest = { monthly_credit: 1_000 };
const suspendBody: SDK.SuspendSubAccountRequest = { reason: "Package contract" };

const direct: SDK.PaginationParams = { limit: 25, after: "direct-cursor" };
const domains: SDK.ListDomainsParams = { limit: 25, after: "domain-cursor", dns_valid: true };
const messages: SDK.ListMessagesParams = {
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
const routes: SDK.ListRoutesParams = {
  limit: 25,
  before: "route-cursor",
  domain: "example.com",
};
const suppressions: SDK.ListSuppressionsParams = {
  limit: 25,
  before: "suppression-cursor",
  domain: "example.com",
  email: "recipient@example.com",
  from_time: "2026-01-01T00:00:00Z",
  to_time: "2026-01-02T00:00:00Z",
};
const webhooks: SDK.ListWebhooksParams = {
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
const statistics: SDK.StatisticsParams = {
  sender_domain: "example.com",
  group_by: "day",
};
const readonlyHeaders: Readonly<Record<string, string>> = {
  "x-correlation-id": "package-type-fixture",
};
const requestOptions: SDK.RequestOptions = {
  headers: readonlyHeaders,
  timeoutMs: 2_000,
  retry: {
    enabled: true,
    maxRetries: 1,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    strategy: "exponential",
    jitter: true,
  },
};
const noRetryOptions: SDK.RequestOptions = { retry: false };
type Expect<Condition extends true> = Condition;
type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type ErrorEventPhase = Expect<Equal<SDK.ErrorEvent["phase"], "pacing" | "attempt" | "backoff">>;
type AsyncTelemetryHookReturns = [
  Expect<
    Promise<void> extends ReturnType<NonNullable<SDK.TelemetryHooks["onRequest"]>> ? true : false
  >,
  Expect<
    Promise<void> extends ReturnType<NonNullable<SDK.TelemetryHooks["onResponse"]>> ? true : false
  >,
  Expect<
    Promise<void> extends ReturnType<NonNullable<SDK.TelemetryHooks["onRetry"]>> ? true : false
  >,
  Expect<
    Promise<void> extends ReturnType<NonNullable<SDK.TelemetryHooks["onError"]>> ? true : false
  >,
];
const asyncTelemetryHookReturns: AsyncTelemetryHookReturns = [true, true, true, true];
const errorEventPhase: ErrorEventPhase = true;
const telemetryHooks: SDK.TelemetryHooks = {
  onRequest: async (event) => {
    const requestEvent: SDK.RequestEvent = event;
    await Promise.resolve(requestEvent);
  },
  onResponse: async (event) => {
    const responseEvent: SDK.ResponseEvent = event;
    await Promise.resolve(responseEvent);
  },
  onRetry: async (event) => {
    const retryEvent: SDK.RetryEvent = event;
    await Promise.resolve(retryEvent);
  },
  onError: async (event) => {
    const errorEvent: SDK.ErrorEvent = event;
    await Promise.resolve(errorEvent);
  },
};
const phaseSixClientOptions: SDK.ClientOptions = {
  apiKey: "package-type-fixture",
  hooks: telemetryHooks,
};
if (requestOptions.headers) {
  // @ts-expect-error Per-call headers remain readonly through the packed declarations.
  requestOptions.headers["x-correlation-id"] = "changed";
}

void [
  accountModel,
  domainModel,
  routeModel,
  phaseSixClientOptions,
  asyncTelemetryHookReturns,
  errorEventPhase,
];

const pingResponse: Promise<SDK.AhaSendResponse<SDK.PingResponse>> = client.ping().withResponse();
const messageListResponse: Promise<SDK.AhaSendResponse<SDK.PaginatedResponse<SDK.MessageSummary>>> =
  client.messages.list(messages).withResponse();
const messageResponse: Promise<SDK.AhaSendResponse<SDK.Message>> = client.messages
  .get(messageId)
  .withResponse();
const createdDomainResponse: Promise<SDK.AhaSendResponse<SDK.Domain>> = client.domains
  .create(domainBody)
  .withResponse();
const deletedDomainResponse: Promise<SDK.AhaSendResponse<SDK.SuccessResponse>> = client.domains
  .delete("example.com")
  .withResponse();

void [
  pingResponse,
  messageListResponse,
  messageResponse,
  createdDomainResponse,
  deletedDomainResponse,
];

// Every resource operation must retain the response-envelope escape hatch in the packed package.
void client.messages.send(messageBody).withResponse();
void client.messages.sendConversation(conversationBody).withResponse();
void client.messages.cancel(messageId).withResponse();
void client.messages.get(messageId, requestOptions).withResponse();
void client.messages.list(messages, noRetryOptions).withResponse();

void client.domains.list(domains).withResponse();
void client.domains.get("example.com").withResponse();
void client.domains.update("example.com", domainUpdate).withResponse();
void client.domains.checkDns("example.com").withResponse();

void client.apiKeys.list(direct).withResponse();
void client.apiKeys.create(apiKeyBody).withResponse();
void client.apiKeys.get(uuid).withResponse();
void client.apiKeys.update(uuid, apiKeyUpdate).withResponse();
void client.apiKeys.delete(uuid).withResponse();

void client.webhooks.list(webhooks).withResponse();
void client.webhooks.create(webhookBody).withResponse();
void client.webhooks.get(uuid).withResponse();
void client.webhooks.update(uuid, webhookUpdate).withResponse();
void client.webhooks.delete(uuid).withResponse();

void client.statistics.deliverability(statistics).withResponse();
void client.statistics.bounces(statistics).withResponse();
void client.statistics.deliveryTimes(statistics).withResponse();

void client.suppressions.list(suppressions).withResponse();
void client.suppressions.create(suppressionBody).withResponse();
void client.suppressions.delete({ email: "recipient@example.com" }).withResponse();
void client.suppressions.wipe({ domain: "example.com" }).withResponse();

void client.routes.list(routes).withResponse();
void client.routes.create(routeBody).withResponse();
void client.routes.get(uuid).withResponse();
void client.routes.update(uuid, routeUpdate).withResponse();
void client.routes.delete(uuid).withResponse();

void client.accounts.get().withResponse();
void client.accounts.update(accountUpdate).withResponse();
void client.accounts.listMembers().withResponse();
void client.accounts.addMember(memberBody).withResponse();
void client.accounts.removeMember(uuid).withResponse();

void client.smtpCredentials.list(direct).withResponse();
void client.smtpCredentials.create(smtpBody).withResponse();
void client.smtpCredentials.get(uuid).withResponse();
void client.smtpCredentials.delete(uuid).withResponse();

void client.subAccounts.list(direct).withResponse();
void client.subAccounts.create(subAccountBody).withResponse();
void client.subAccounts.usage().withResponse();
void client.subAccounts.get(uuid).withResponse();
void client.subAccounts.update(uuid, subAccountUpdate).withResponse();
void client.subAccounts.delete(uuid).withResponse();
void client.subAccounts.suspend(uuid, suspendBody).withResponse();
void client.subAccounts.unsuspend(uuid).withResponse();

void client.subAccounts.apiKeys.list(uuid, direct).withResponse();
void client.subAccounts.apiKeys.create(uuid, apiKeyBody).withResponse();
void client.subAccounts.apiKeys.get(uuid, uuid).withResponse();
void client.subAccounts.apiKeys.update(uuid, uuid, apiKeyUpdate).withResponse();
void client.subAccounts.apiKeys.delete(uuid, uuid).withResponse();

const messagesMock: SDK.MessagesClient = {
  send: () => result<SDK.SendMessageResponse>(),
  sendConversation: () => result<SDK.SendMessageResponse>(),
  list: () => result<SDK.PaginatedResponse<SDK.MessageSummary>>(),
  iterate: () => iterator<SDK.MessageSummary>(),
  get: () => result<SDK.Message>(),
  cancel: () => result<SDK.SuccessResponse>(),
};

const domainsMock: SDK.DomainsClient = {
  list: () => result<SDK.PaginatedResponse<SDK.Domain>>(),
  iterate: () => iterator<SDK.Domain>(),
  create: () => result<SDK.Domain>(),
  get: () => result<SDK.Domain>(),
  update: () => result<SDK.Domain>(),
  delete: () => result<SDK.SuccessResponse>(),
  checkDns: () => result<SDK.Domain>(),
};

const apiKeysMock: SDK.APIKeysClient = {
  list: () => result<SDK.PaginatedResponse<SDK.APIKey>>(),
  iterate: () => iterator<SDK.APIKey>(),
  create: () => result<SDK.CreatedAPIKey>(),
  get: () => result<SDK.APIKey>(),
  update: () => result<SDK.APIKey>(),
  delete: () => result<SDK.SuccessResponse>(),
};

const webhooksMock: SDK.WebhooksClient = {
  list: () => result<SDK.PaginatedResponse<SDK.Webhook>>(),
  iterate: () => iterator<SDK.Webhook>(),
  create: () => result<SDK.CreatedWebhook>(),
  get: () => result<SDK.Webhook>(),
  update: () => result<SDK.Webhook>(),
  delete: () => result<SDK.SuccessResponse>(),
};

const statisticsMock: SDK.StatisticsClient = {
  deliverability: () => result<SDK.DeliverabilityStatisticsResponse>(),
  bounces: () => result<SDK.BounceStatisticsResponse>(),
  deliveryTimes: () => result<SDK.DeliveryTimeStatisticsResponse>(),
};

const suppressionsMock: SDK.SuppressionsClient = {
  list: () => result<SDK.PaginatedResponse<SDK.Suppression>>(),
  iterate: () => iterator<SDK.Suppression>(),
  create: () => result<SDK.CreateSuppressionResponse>(),
  delete: () => result<SDK.SuccessResponse>(),
  wipe: () => result<SDK.SuccessResponse>(),
};

const routesMock: SDK.RoutesClient = {
  list: () => result<SDK.PaginatedResponse<SDK.Route>>(),
  iterate: () => iterator<SDK.Route>(),
  create: () => result<SDK.CreatedRoute>(),
  get: () => result<SDK.Route>(),
  update: () => result<SDK.Route>(),
  delete: () => result<SDK.SuccessResponse>(),
};

const accountsMock: SDK.AccountsClient = {
  get: () => result<SDK.Account>(),
  update: () => result<SDK.Account>(),
  listMembers: () => result<SDK.ListAccountMembersResponse>(),
  addMember: () => result<SDK.UserAccount>(),
  removeMember: () => result<SDK.SuccessResponse>(),
};

const smtpCredentialsMock: SDK.SMTPCredentialsClient = {
  list: () => result<SDK.PaginatedResponse<SDK.SMTPCredential>>(),
  iterate: () => iterator<SDK.SMTPCredential>(),
  create: () => result<SDK.CreatedSMTPCredential>(),
  get: () => result<SDK.SMTPCredential>(),
  delete: () => result<SDK.SuccessResponse>(),
};

const subAccountAPIKeysMock: SDK.SubAccountAPIKeysClient = {
  list: () => result<SDK.PaginatedResponse<SDK.APIKey>>(),
  iterate: () => iterator<SDK.APIKey>(),
  create: () => result<SDK.CreatedAPIKey>(),
  get: () => result<SDK.APIKey>(),
  update: () => result<SDK.APIKey>(),
  delete: () => result<SDK.SuccessResponse>(),
};

const subAccountsMock: SDK.SubAccountsClient = {
  list: () => result<SDK.PaginatedResponse<SDK.SubAccount>>(),
  iterate: () => iterator<SDK.SubAccount>(),
  create: () => result<SDK.SubAccount>(),
  usage: () => result<SDK.SubAccountUsageResponse>(),
  get: () => result<SDK.SubAccount>(),
  update: () => result<SDK.SubAccount>(),
  delete: () => result<SDK.SuccessResponse>(),
  suspend: () => result<SDK.SubAccount>(),
  unsuspend: () => result<SDK.SubAccount>(),
  apiKeys: subAccountAPIKeysMock,
};

type ClientResourceSurface = Pick<
  SDK.AhaSendClient,
  | "messages"
  | "domains"
  | "apiKeys"
  | "webhooks"
  | "statistics"
  | "suppressions"
  | "routes"
  | "accounts"
  | "smtpCredentials"
  | "subAccounts"
>;

const clientMock: ClientResourceSurface = {
  messages: messagesMock,
  domains: domainsMock,
  apiKeys: apiKeysMock,
  webhooks: webhooksMock,
  statistics: statisticsMock,
  suppressions: suppressionsMock,
  routes: routesMock,
  accounts: accountsMock,
  smtpCredentials: smtpCredentialsMock,
  subAccounts: subAccountsMock,
};

void clientMock;

const expressHandler: ExpressHandler = (event, request, response) => {
  void [event, request, response];
};
const fastifyHandler: FastifyHandler = (event, request, reply) => {
  void [event, request, reply];
};
const nextHandler: NextHandler = (event, request) => {
  void [event, request];
  return new Response(null, { status: 204 });
};

void [expressHandler, fastifyHandler, nextHandler, new WebhookVerifier("whsec_dGVzdA==")];

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
const idempotencyConflict = new AhaSendIdempotencyConflictError({
  ...apiErrorParams,
  retryAfterSeconds: 1,
  idempotencyKey: "package-recovery-key",
});
const recoveryKey: string | undefined = idempotencyConflict.idempotencyKey;
void recoveryKey;
void new AhaSendUnprocessableEntityError(apiErrorParams);
void new AhaSendIdempotencyMismatchError(apiErrorParams);
void new AhaSendRateLimitError({ ...apiErrorParams, retryAfterSeconds: 1 });
void new AhaSendServerError(apiErrorParams);
void new AhaSendWebhookVerificationError("signature_mismatch");

function narrowAhaSendErrors(value: unknown): void {
  if (AhaSendError.is(value)) {
    const sdkError: AhaSendError = value;
    void sdkError;
  }
  if (AhaSendAPIError.is(value)) {
    const apiError: AhaSendAPIError = value;
    void apiError;
  }
}

void narrowAhaSendErrors;

// @ts-expect-error Pagination cursors are mutually exclusive.
void client.apiKeys.list({ limit: 25, after: "after", before: "before" });
// @ts-expect-error Pagination cursors are mutually exclusive.
void client.smtpCredentials.list({ limit: 25, after: "after", before: "before" });
// @ts-expect-error Pagination cursors are mutually exclusive.
void client.subAccounts.list({ limit: 25, after: "after", before: "before" });
void client.subAccounts.apiKeys.list(uuid, {
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
