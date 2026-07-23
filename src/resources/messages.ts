import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  ISODateTime,
  NonEmptyArray,
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

/** A value in a Jinja2 substitution context, including nested objects and arrays. */
export type SubstitutionValue = unknown;

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

/** Per-message tracking overrides. `null` restores all account defaults. */
export type Tracking = {
  /** `null` opts back to the account default. */
  open?: boolean | null;
  /** `null` opts back to the account default. */
  click?: boolean | null;
} | null;

/** Per-message retention overrides. `null` restores all account defaults. */
export type Retention = {
  /** `null` opts back to the account default. */
  metadata?: number | null;
  /** `null` opts back to the account default. */
  data?: number | null;
} | null;

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
  recipients: NonEmptyArray<Recipient>;
  subject: string;
  reply_to?: Address;
  /** Plain-text body. Required if `html_content` is empty. */
  text_content?: string;
  /** HTML body. Required if `text_content` is empty. */
  html_content?: string;
  /** AMP HTML variant. */
  amp_content?: string;
  attachments?: readonly Attachment[];
  /** Custom SMTP headers. `Reply-To` and `Message-ID` are managed by the API. */
  headers?: Record<string, string>;
  /** Request-level template variables; per-recipient substitutions win. */
  substitutions?: Record<string, SubstitutionValue>;
  /** Free-form tags for filtering in lists, statistics, and webhooks. */
  tags?: readonly string[];
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
  to: NonEmptyArray<Address>;
  subject: string;
  cc?: NonEmptyArray<Address>;
  bcc?: NonEmptyArray<Address>;
  reply_to?: Address;
  text_content?: string;
  html_content?: string;
  amp_content?: string;
  attachments?: readonly Attachment[];
  headers?: Record<string, string>;
  tags?: readonly string[];
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
   * Generated Message-ID of the queued message, e.g. `<uuid@host>`, or `null`
   * when the message was not sent.
   *
   * When non-null, this value can be passed directly to {@link MessagesClient.get}
   * or {@link MessagesClient.cancel}; those methods also accept its bare UUID portion.
   */
  id: string | null;
  recipient: Recipient & { name: string };
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
  content_id: string;
}

export interface MessageContentParsed {
  parts: MessageContentPart[];
  attachments: MessageContentAttachment[];
  headers: Record<string, string[]>;
}

export interface MessageSummary {
  object: "message";
  id: string | null;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  sent_at: ISODateTime | null;
  delivered_at: ISODateTime | null;
  retain_until: ISODateTime;
  direction: "inbound" | "outbound";
  is_bounce_notification: boolean;
  bounce_classification: string;
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
}

export interface Message extends MessageSummary {
  content?: string;
  content_parsed?: MessageContentParsed;
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
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Send a message to 1–100 recipients. Each recipient gets a separate
   * email with their own substitutions applied.
   *
   * An `Idempotency-Key` is auto-generated unless you pass
   * `options.idempotencyKey`; retries (the SDK's and yours, if you reuse
   * the key) can never double-send.
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  send(
    body: CreateMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<SendMessageResponse> {
    return this.#operations.execute<SendMessageResponse>(
      "createMessage",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Send a single message with multiple visible To/Cc/Bcc recipients
   * (combined ≤ 50) — like a normal mail client, everyone sees the
   * recipient list. Use {@link send} for individualized fan-out.
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  sendConversation(
    body: CreateConversationMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<SendMessageResponse> {
    return this.#operations.execute<SendMessageResponse>(
      "createConversationMessage",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Fetch one page of messages. Filters combine with AND semantics.
   *
   * `messages:read:all` returns every message; `messages:read:{domain}` returns
   * only messages whose `sender` domain is authorized.
   */
  list(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<MessageSummary>> {
    return this.#operations.execute<PaginatedResponse<MessageSummary>>(
      "getMessages",
      {
        path: { account_id: this.#accountId },
        query: params as Readonly<Record<string, unknown>>,
      },
      forwardOptions(options),
    );
  }

  /**
   * Iterate every message matching the filters, fetching pages lazily:
   * `for await (const msg of client.messages.iterate({ status: "Delivered" }))`.
   */
  iterate(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<MessageSummary, void, undefined> {
    return paginate<MessageSummary, ListMessagesParams>((p) => this.list(p, options), params);
  }

  /**
   * Fetch a single message by its opaque message ID. Accepts the generated
   * Message-ID returned by {@link send} when non-null, or its bare UUID portion.
   * The ID is encoded as one path segment.
   *
   * Authorization requires `messages:read:all` or `messages:read:{domain}`
   * matching the message's `sender` domain.
   */
  get(messageId: string, options: RequestOptions = {}): Promise<Message> {
    return this.#operations.execute<Message>(
      "getMessage",
      { path: { account_id: this.#accountId, message_id: messageId } },
      forwardOptions(options),
    );
  }

  /**
   * Cancel a queued or scheduled message. Only possible before the
   * first delivery attempt; already-sent messages cannot be recalled.
   * Accepts the generated Message-ID returned by {@link send} when non-null,
   * or its bare UUID portion.
   *
   * Authorization requires `messages:cancel:all` or `messages:cancel:{domain}`
   * matching the message's `sender` domain.
   */
  cancel(messageId: string, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "cancelMessage",
      { path: { account_id: this.#accountId, message_id: messageId } },
      forwardOptions(options),
    );
  }
}
