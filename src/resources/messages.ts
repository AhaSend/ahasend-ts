import type { HttpClient } from "../http.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import {
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

/** Values allowed in a Jinja2 substitution context. */
export type SubstitutionValue = string | number | boolean | null;

export interface Recipient {
  email: string;
  name?: string;
  substitutions?: Record<string, SubstitutionValue>;
}

export interface Attachment {
  data: string;
  content_type: string;
  file_name: string;
  base64?: boolean;
  content_disposition?: string;
  content_id?: string;
}

export interface Tracking {
  /** `null` opts back to the account default (per spec `nullable: true`). */
  open?: boolean | null;
  /** `null` opts back to the account default (per spec `nullable: true`). */
  click?: boolean | null;
}

export interface Retention {
  /** `null` opts back to the account default (per spec `nullable: true`). */
  metadata?: number | null;
  /** `null` opts back to the account default (per spec `nullable: true`). */
  data?: number | null;
}

export interface MessageSchedule {
  first_attempt?: ISODateTime;
  expires?: ISODateTime;
}

export type SandboxResult = "deliver" | "bounce" | "defer" | "fail" | "suppress";

export interface CreateMessageRequest {
  from: Address;
  /** 1–100 recipients (the API rejects an empty array). */
  recipients: [Recipient, ...Recipient[]];
  subject: string;
  reply_to?: Address;
  text_content?: string;
  html_content?: string;
  amp_content?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  substitutions?: Record<string, SubstitutionValue>;
  tags?: string[];
  sandbox?: boolean;
  sandbox_result?: SandboxResult;
  tracking?: Tracking;
  retention?: Retention;
  schedule?: MessageSchedule;
}

export interface CreateConversationMessageRequest {
  from: Address;
  /** 1–50 To recipients (combined To+Cc+Bcc must be ≤50). */
  to: [Address, ...Address[]];
  subject: string;
  cc?: Address[];
  bcc?: Address[];
  reply_to?: Address;
  text_content?: string;
  html_content?: string;
  amp_content?: string;
  attachments?: Attachment[];
  headers?: Record<string, string>;
  tags?: string[];
  sandbox?: boolean;
  sandbox_result?: SandboxResult;
  tracking?: Tracking;
  retention?: Retention;
  schedule?: MessageSchedule;
}

export type SendMessageStatus = "queued" | "scheduled" | "error";

export interface SendMessageResult {
  object: "message";
  /**
   * RFC-822 Message-ID of the queued message, e.g. `<uuid@host>`.
   *
   * **This is NOT the resource UUID for `messages.get()`** — it is the
   * SMTP-level identifier the API records when the message is queued
   * for delivery. To fetch the message resource later use the UUID from
   * the `Message.id` field on the persisted record.
   */
  id: string | null;
  recipient: Recipient;
  status: SendMessageStatus;
  error: string | null;
  schedule?: MessageSchedule;
}

export interface SendMessageResponse {
  object: "list";
  data: SendMessageResult[];
}

export interface DeliveryAttempt {
  time: ISODateTime;
  log: string;
  status: string;
}

export interface MessageContentPart {
  content_type: string;
  content: string;
}

export interface MessageContentAttachment {
  filename: string;
  content: string;
  content_type: string;
  content_id?: string | null;
}

export interface MessageContentParsed {
  parts: MessageContentPart[];
  attachments: MessageContentAttachment[];
  headers: Record<string, string[]>;
}

export interface Message {
  object: "message";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  /** Not in the spec's `required` array — omitted while queued. */
  sent_at?: ISODateTime | null;
  /** Not in the spec's `required` array — omitted until delivered. */
  delivered_at?: ISODateTime | null;
  retain_until: ISODateTime;
  direction: "inbound" | "outbound";
  is_bounce_notification: boolean;
  /** Optional per spec — present only on bounce notifications. */
  bounce_classification?: string;
  delivery_attempts: DeliveryAttempt[];
  message_id: string;
  subject: string;
  tags: string[];
  sender: string;
  recipient: string;
  status: string;
  num_attempts: number;
  click_count: number;
  open_count: number;
  reference_message_id: number | null;
  domain_id: UUID;
  account_id: UUID;
  content?: string | null;
  content_parsed?: MessageContentParsed | null;
}

export interface ListMessagesParams extends PaginationParams {
  status?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  message_id_header?: string;
  tags?: string;
  from_time?: ISODateTime;
  to_time?: ISODateTime;
}

export class MessagesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  send(
    body: CreateMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<SendMessageResponse> {
    return this.http.request<SendMessageResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  sendConversation(
    body: CreateConversationMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<SendMessageResponse> {
    return this.http.request<SendMessageResponse>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/conversation`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  list(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Message>> {
    return this.http.request<PaginatedResponse<Message>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  iterate(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Message, void, undefined> {
    return paginate<Message, ListMessagesParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  get(messageId: UUID, options: RequestOptions = {}): Promise<Message> {
    return this.http.request<Message>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}`,
      ...forwardOptions(options),
    });
  }

  cancel(messageId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      ...forwardOptions(options),
    });
  }
}
