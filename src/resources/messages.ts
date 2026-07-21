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

/** A single recipient of a `messages.send()` call. */
export interface Recipient {
  email: string;
  /** Display name rendered alongside the address. */
  name?: string;
  /**
   * Per-recipient template variables, rendered with Jinja2 syntax
   * (`{{ first_name }}`) in the subject and body. Overrides keys of the
   * same name in the request-level `substitutions`.
   */
  substitutions?: Record<string, SubstitutionValue>;
}

/** File attachment on an outgoing message. */
export interface Attachment {
  /**
   * The file content. Interpreted as plain UTF-8 text unless
   * `base64: true`, in which case it must be base64-encoded — required
   * for any binary format (PDF, images, archives).
   */
  data: string;
  /** MIME type, e.g. `application/pdf`. */
  content_type: string;
  file_name: string;
  /** Set `true` when `data` is base64-encoded. Defaults to `false`. */
  base64?: boolean;
  /** `attachment` (default) or `inline` (for embedded images). */
  content_disposition?: string;
  /**
   * Content-ID for inline images — reference it from HTML as
   * `<img src="cid:THIS_VALUE">`.
   */
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

/** Delivery scheduling for a message. */
export interface MessageSchedule {
  /**
   * RFC 3339 timestamp of the earliest delivery attempt. Must be in the
   * future and within 7 days of the request.
   */
  first_attempt?: ISODateTime;
  /**
   * RFC 3339 timestamp after which delivery is abandoned. Must be in
   * the future and within 8 days of the request.
   */
  expires?: ISODateTime;
}

/**
 * The outcome to simulate when `sandbox: true`. Lets you exercise your
 * bounce/suppression handling without sending real traffic.
 */
export type SandboxResult = "deliver" | "bounce" | "defer" | "fail" | "suppress";

/**
 * Body for {@link MessagesClient.send}. Each recipient receives a
 * **separate** message (with their own substitutions applied); use
 * {@link MessagesClient.sendConversation} for a single message with
 * multiple visible To/Cc/Bcc recipients.
 */
export interface CreateMessageRequest {
  /** Sender — must be on a verified sending domain of your account. */
  from: Address;
  /** 1–100 recipients (the API rejects an empty array). */
  recipients: [Recipient, ...Recipient[]];
  subject: string;
  reply_to?: Address;
  /** Plain-text body. Required if `html_content` is empty. */
  text_content?: string;
  /** HTML body. Required if `text_content` is empty. */
  html_content?: string;
  /** AMP HTML variant. */
  amp_content?: string;
  attachments?: Attachment[];
  /** Custom SMTP headers. `Reply-To` and `Message-ID` are managed by the API. */
  headers?: Record<string, string>;
  /** Request-level template variables; per-recipient substitutions win. */
  substitutions?: Record<string, SubstitutionValue>;
  /** Free-form tags for filtering in lists, statistics, and webhooks. */
  tags?: string[];
  /**
   * Sandbox mode: the API validates and accepts the request but no
   * email leaves the platform. The `from` domain must still be verified.
   */
  sandbox?: boolean;
  /** Simulated outcome when `sandbox: true`. Defaults to `deliver`. */
  sandbox_result?: SandboxResult;
  /** Open/click tracking overrides; `null` fields fall back to account defaults. */
  tracking?: Tracking;
  /** Data-retention overrides; `null` fields fall back to account defaults. */
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

export type ListMessagesParams = PaginationParams & {
  status?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  message_id_header?: string;
  tags?: string;
  from_time?: ISODateTime;
  to_time?: ISODateTime;
};

/** Send, list, fetch, and cancel transactional messages. */
export class MessagesClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  /**
   * Send a message to 1–100 recipients. Each recipient gets a separate
   * email with their own substitutions applied.
   *
   * An `Idempotency-Key` is auto-generated unless you pass
   * `options.idempotencyKey`; retries (the SDK's and yours, if you reuse
   * the key) can never double-send.
   *
   * Requires scope `messages:send:all` or `messages:send:{domain}`.
   */
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

  /**
   * Send a single message with multiple visible To/Cc/Bcc recipients
   * (combined ≤ 50) — like a normal mail client, everyone sees the
   * recipient list. Use {@link send} for individualized fan-out.
   */
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

  /** Fetch one page of messages. Filters combine with AND semantics. */
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

  /**
   * Iterate every message matching the filters, fetching pages lazily:
   * `for await (const msg of client.messages.iterate({ status: "Delivered" }))`.
   */
  iterate(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Message, void, undefined> {
    return paginate<Message, ListMessagesParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  /**
   * Fetch a single message by its resource UUID (the `Message.id` field
   * from {@link list} — not the RFC-822 Message-ID that
   * {@link send} returns).
   */
  get(messageId: UUID, options: RequestOptions = {}): Promise<Message> {
    return this.http.request<Message>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}`,
      ...forwardOptions(options),
    });
  }

  /**
   * Cancel a queued or scheduled message. Only possible before the
   * first delivery attempt; already-sent messages cannot be recalled.
   * Requires scope `messages:cancel:all` or `messages:cancel:{domain}`.
   */
  cancel(messageId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/messages/${encodeURIComponent(messageId)}/cancel`,
      ...forwardOptions(options),
    });
  }
}
