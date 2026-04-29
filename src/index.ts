export { AhaSendClient } from "./client.js";
export type { AhaSendClientOptions, PingResponse } from "./client.js";

export type { ClientOptions } from "./config.js";
export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./config.js";

export {
  AhaSendAPIError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConnectionError,
  AhaSendError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
  AhaSendRateLimitError,
  AhaSendServerError,
  AhaSendTimeoutError,
} from "./errors.js";
export type { ApiErrorBody } from "./errors.js";

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
  CreateAPIKeyRequest,
  UpdateAPIKeyRequest,
} from "./resources/api-keys.js";

export { SDK_VERSION } from "./version.js";
