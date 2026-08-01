export { AhaSendClient } from "./client.js";
export type { AhaSendClientOptions, PingResponse } from "./client.js";

export type { ClientOptions } from "./config.js";
export { optionsFromEnv } from "./config.js";

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

export { IdempotencyKeyBuilder, generateIdempotencyKey } from "./idempotency.js";
export type { IdempotencyConfig } from "./idempotency.js";

export type { RetryConfig, RetryStrategy } from "./retry.js";

export type { CategoryRateLimit, RateLimitConfig } from "./rate-limit.js";

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
  MessagesClient,
} from "./resources/messages.js";

export type {
  CreateDomainRequest,
  DNSRecord,
  Domain,
  DomainsClient,
  ListDomainsParams,
  UpdateDomainRequest,
} from "./resources/domains.js";

export type {
  APIKey,
  APIKeyScope,
  APIKeyScopeName,
  APIKeysClient,
  CreateAPIKeyRequest,
  CreatedAPIKey,
  UpdateAPIKeyRequest,
} from "./resources/api-keys.js";

export type {
  CreateWebhookRequest,
  CreatedWebhook,
  ListWebhooksParams,
  UpdateWebhookRequest,
  Webhook,
  WebhooksClient,
  WebhookScope,
} from "./resources/webhooks.js";

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
  StatisticsClient,
  StatisticsParams,
} from "./resources/statistics.js";

export type {
  CreateSuppressionRequest,
  CreateSuppressionResponse,
  DeleteSuppressionParams,
  ListSuppressionsParams,
  Suppression,
  SuppressionsClient,
  WipeSuppressionsParams,
} from "./resources/suppressions.js";

export type {
  CreateRouteRequest,
  CreatedRoute,
  ListRoutesParams,
  Route,
  RoutesClient,
  UpdateRouteRequest,
} from "./resources/routes.js";

export type {
  Account,
  AccountMemberRole,
  AccountsClient,
  AddAccountMemberRequest,
  ListAccountMembersResponse,
  UpdateAccountRequest,
  UserAccount,
} from "./resources/accounts.js";

export type {
  CreateSMTPCredentialRequest,
  CreatedSMTPCredential,
  SMTPCredential,
  SMTPCredentialsClient,
  SMTPCredentialScope,
} from "./resources/smtp-credentials.js";

export type {
  CreateSubAccountRequest,
  ListSubAccountsParams,
  SubAccount,
  SubAccountStatus,
  SubAccountUsageBreakdown,
  SubAccountUsageResponse,
  SubAccountsClient,
  SuspendSubAccountRequest,
  UpdateSubAccountRequest,
} from "./resources/sub-accounts.js";
export type { SubAccountAPIKeysClient } from "./resources/sub-account-api-keys.js";

export { SDK_VERSION } from "./version.js";
