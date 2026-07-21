import type { AccountsClient as AccountsClientType } from "./resources/accounts.js";
import type { APIKeysClient as APIKeysClientType } from "./resources/api-keys.js";
import type { DomainsClient as DomainsClientType } from "./resources/domains.js";
import type { MessagesClient as MessagesClientType } from "./resources/messages.js";
import type { RoutesClient as RoutesClientType } from "./resources/routes.js";
import type { SMTPCredentialsClient as SMTPCredentialsClientType } from "./resources/smtp-credentials.js";
import type { StatisticsClient as StatisticsClientType } from "./resources/statistics.js";
import type { SuppressionsClient as SuppressionsClientType } from "./resources/suppressions.js";
import type { WebhooksClient as WebhooksClientType } from "./resources/webhooks.js";

export { AhaSendClient } from "./client.js";
export type { AhaSendClientOptions, PingResponse } from "./client.js";

export type { ClientOptions } from "./config.js";
export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, optionsFromEnv } from "./config.js";

export {
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
  isAhaSendError,
} from "./errors.js";
export type { AhaSendErrorCode, ApiErrorBody, SerializedAhaSendError } from "./errors.js";

export {
  DEFAULT_IDEMPOTENCY_CONFIG,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  IdempotencyKeyBuilder,
  generateIdempotencyKey,
} from "./idempotency.js";
export type { IdempotencyConfig } from "./idempotency.js";

export type { RetryConfig, RetryStrategy } from "./retry.js";

export type { CategoryRateLimit, EndpointCategory, RateLimitConfig } from "./rate-limit.js";

export { composeHooks } from "./telemetry.js";
export type {
  ErrorEvent,
  RequestEvent,
  ResponseEvent,
  RetryEvent,
  TelemetryHooks,
} from "./telemetry.js";

export type {
  Address,
  AhaSendPromise,
  AhaSendResponse,
  IdempotencyRequestOptions,
  ISODateTime,
  NonEmptyArray,
  PaginatedResponse,
  PaginationMeta,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "./types/common.js";

export type {
  Attachment,
  CreateConversationMessageRequest,
  CreateMessageRequest,
  DeliveryAttempt,
  ListMessagesParams,
  Message,
  MessageSummary,
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
  SubstitutionValue,
  Tracking,
} from "./resources/messages.js";
export type MessagesClient = MessagesClientType;

export type {
  CreateDomainRequest,
  DNSRecord,
  Domain,
  DomainRequestOptions,
  ListDomainsParams,
  UpdateDomainRequest,
} from "./resources/domains.js";
export type DomainsClient = DomainsClientType;

export type {
  APIKey,
  APIKeyRequestOptions,
  APIKeyScope,
  APIKeyScopeName,
  CreateAPIKeyRequest,
  CreatedAPIKey,
  UpdateAPIKeyRequest,
} from "./resources/api-keys.js";
export type APIKeysClient = APIKeysClientType;

export type {
  CreateWebhookRequest,
  CreatedWebhook,
  ListWebhooksParams,
  UpdateWebhookRequest,
  Webhook,
  WebhookScope,
} from "./resources/webhooks.js";
export type WebhooksClient = WebhooksClientType;

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
export type StatisticsClient = StatisticsClientType;

export type {
  CreateSuppressionRequest,
  CreateSuppressionResponse,
  DeleteSuppressionParams,
  ListSuppressionsParams,
  Suppression,
  WipeSuppressionsParams,
} from "./resources/suppressions.js";
export type SuppressionsClient = SuppressionsClientType;

export type {
  CreateRouteRequest,
  CreatedRoute,
  ListRoutesParams,
  Route,
  UpdateRouteRequest,
} from "./resources/routes.js";
export type RoutesClient = RoutesClientType;

export type {
  Account,
  AccountMemberRole,
  AddAccountMemberRequest,
  ListAccountMembersResponse,
  ListMembersParams,
  UpdateAccountRequest,
  UserAccount,
} from "./resources/accounts.js";
export type AccountsClient = AccountsClientType;

export type {
  CreateSMTPCredentialRequest,
  CreatedSMTPCredential,
  SMTPCredential,
  SMTPCredentialScope,
} from "./resources/smtp-credentials.js";
export type SMTPCredentialsClient = SMTPCredentialsClientType;

export { SDK_VERSION } from "./version.js";
