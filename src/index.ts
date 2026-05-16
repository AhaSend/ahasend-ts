export { AhaSendClient } from "./client.js";
export type { AhaSendClientOptions, PingResponse } from "./client.js";

export type { ClientOptions } from "./config.js";
export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./config.js";

export {
  AhaSendAPIError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConflictError,
  AhaSendConnectionError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  AhaSendIdempotencyMismatchError,
  AhaSendIdempotencyPreconditionFailedError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
  AhaSendUnprocessableEntityError,
} from "./errors.js";
export type { ApiErrorBody } from "./errors.js";

export {
  DEFAULT_IDEMPOTENCY_CONFIG,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyKeyBuilder,
  generateIdempotencyKey,
} from "./idempotency.js";
export type { IdempotencyConfig, ResolvedIdempotencyConfig } from "./idempotency.js";

export {
  DEFAULT_RETRY_CONFIG,
  computeBackoffMs,
  computeRetryDelayMs,
  isRetryableError,
} from "./retry.js";
export type { ResolvedRetryConfig, RetryConfig, RetryStrategy } from "./retry.js";

export {
  DEFAULT_RATE_LIMIT_CONFIG,
  RateLimiter,
  detectCategory,
} from "./rate-limit.js";
export type {
  CategoryRateLimit,
  EndpointCategory,
  RateLimitConfig,
  ResolvedCategoryRateLimit,
  ResolvedRateLimitConfig,
} from "./rate-limit.js";

export { collect, paginate } from "./pagination.js";

export { composeHooks, debugConsoleHooks } from "./telemetry.js";
export type {
  ErrorEvent,
  RequestEvent,
  ResolvedTelemetryHooks,
  ResponseEvent,
  RetryEvent,
  TelemetryHooks,
} from "./telemetry.js";

export type {
  Address,
  ISODateTime,
  PaginatedResponse,
  PaginationMeta,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "./types/common.js";

export { MessagesClient } from "./resources/messages.js";
export type {
  Attachment,
  CreateConversationMessageRequest,
  CreateMessageRequest,
  DeliveryAttempt,
  ListMessagesParams,
  Message,
  MessageContentAttachment,
  MessageContentParsed,
  MessageContentPart,
  MessageSchedule,
  Recipient,
  Retention,
  SandboxResult,
  SendMessageResponse,
  SendMessageResult,
  SendMessageStatus,
  Tracking,
} from "./resources/messages.js";

export { DomainsClient } from "./resources/domains.js";
export type {
  CreateDomainRequest,
  DNSRecord,
  Domain,
  DomainRequestOptions,
  ListDomainsParams,
  UpdateDomainRequest,
} from "./resources/domains.js";

export { APIKeysClient } from "./resources/api-keys.js";
export type {
  APIKey,
  APIKeyRequestOptions,
  APIKeyScope,
  APIKeyScopeName,
  CreateAPIKeyRequest,
  UpdateAPIKeyRequest,
} from "./resources/api-keys.js";

export { WebhooksClient } from "./resources/webhooks.js";
export type {
  CreateWebhookRequest,
  CreatedWebhook,
  ListWebhooksParams,
  UpdateWebhookRequest,
  Webhook,
  WebhookScope,
} from "./resources/webhooks.js";

export { StatisticsClient } from "./resources/statistics.js";
export type {
  BounceClassificationCount,
  BounceStatistics,
  BounceStatisticsResponse,
  DeliverabilityStatistics,
  DeliverabilityStatisticsResponse,
  DeliveryTimeBreakdown,
  DeliveryTimeStatistics,
  DeliveryTimeStatisticsResponse,
  StatisticsGranularity,
  StatisticsParams,
} from "./resources/statistics.js";

export { SuppressionsClient } from "./resources/suppressions.js";
export type {
  CreateSuppressionRequest,
  CreateSuppressionResponse,
  DeleteSuppressionParams,
  ListSuppressionsParams,
  Suppression,
  WipeSuppressionsParams,
} from "./resources/suppressions.js";

export { RoutesClient } from "./resources/routes.js";
export type {
  CreateRouteRequest,
  CreatedRoute,
  ListRoutesParams,
  Route,
  UpdateRouteRequest,
} from "./resources/routes.js";

export { AccountsClient } from "./resources/accounts.js";
export type {
  Account,
  AccountMemberRole,
  AddAccountMemberRequest,
  ListAccountMembersResponse,
  ListMembersParams,
  UpdateAccountRequest,
  UserAccount,
} from "./resources/accounts.js";

export { SMTPCredentialsClient } from "./resources/smtp-credentials.js";
export type {
  CreateSMTPCredentialRequest,
  CreatedSMTPCredential,
  SMTPCredential,
  SMTPCredentialScope,
} from "./resources/smtp-credentials.js";

export type { IdempotencyRequestOptions } from "./resources/_helpers.js";

export { SDK_VERSION } from "./version.js";
