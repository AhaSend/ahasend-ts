import { AhaSendConfigurationError } from "../errors.js";
import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  AhaSendPromise,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import {
  assertNonEmptyArray,
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

const MESSAGE_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * Reduce a caller-supplied message ID to the bare UUID the API routes on.
 *
 * `send` returns ids in generated Message-ID form — `<uuid@sender-domain>` —
 * and the server's own parser trims the angle brackets and everything from
 * the `@` onward before parsing a UUID. Mirroring that here instead of
 * sending the full form matters because of an encoding asymmetry the first
 * live acceptance run surfaced: a client must percent-encode `<`, `@`, and
 * `>` in a path segment, but the server reads path parameters undecoded, so
 * an encoded full form arrives as `%3C…%40…%3E` and is refused with HTTP 400
 * `invalid message_id`. The bare UUID contains only unreserved characters —
 * encoded and raw are the same bytes — so it is the one spelling both sides
 * read identically.
 *
 * Anything that does not contain a UUID in that shape is refused locally as
 * {@link AhaSendConfigurationError}, before a request is dispatched. The
 * message does not echo the value.
 */
function messagePathId(messageId: string): string {
  let candidate = typeof messageId === "string" ? messageId.trim() : "";
  if (candidate.startsWith("<")) candidate = candidate.slice(1);
  if (candidate.endsWith(">")) candidate = candidate.slice(0, -1);
  const atIndex = candidate.indexOf("@");
  if (atIndex !== -1) candidate = candidate.slice(0, atIndex);
  if (!MESSAGE_UUID_PATTERN.test(candidate)) {
    throw new AhaSendConfigurationError(
      "AhaSend: `messageId` must be a message UUID, optionally in the generated Message-ID form `<uuid@domain>`.",
    );
  }
  return candidate;
}

/** A value in a Jinja2 substitution context, including nested objects and arrays. */
export type SubstitutionValue = unknown;

/** A single recipient of a `messages.send()` call. */
export interface Recipient {
  email: string;
  /** Display name rendered alongside the address. */
  name?: string | undefined;
  /**
   * Per-recipient template variables, rendered with Jinja2 syntax
   * (`{{ first_name }}`) in the subject and body. Overrides keys of the
   * same name in the request-level `substitutions`.
   */
  substitutions?: Record<string, SubstitutionValue> | undefined;
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
  base64?: boolean | undefined;
  /** `attachment` (default) or `inline` (for embedded images). */
  content_disposition?: string | undefined;
  /**
   * Content-ID for inline images. The value **must be wrapped in angle
   * brackets**, matching the MIME `Content-ID` header format — for example
   * `"<image1@example.com>"`. Reference it from `html_content` *without*
   * the brackets: `<img src="cid:image1@example.com">`.
   *
   * If the angle brackets are omitted the file is delivered as a regular
   * downloadable attachment instead of rendering inline.
   */
  content_id?: string | undefined;
}

/** Per-message tracking overrides. `null` restores all account defaults. */
export type Tracking = {
  /** `null` opts back to the account default. */
  open?: boolean | null | undefined;
  /** `null` opts back to the account default. */
  click?: boolean | null | undefined;
} | null;

/** Per-message retention overrides. `null` restores all account defaults. */
export type Retention = {
  /** `null` opts back to the account default. */
  metadata?: number | null | undefined;
  /** `null` opts back to the account default. */
  data?: number | null | undefined;
} | null;

/** Delivery scheduling for a message. */
export interface MessageSchedule {
  /**
   * RFC 3339 timestamp of the earliest delivery attempt. Must be in the
   * future and within 7 days of the request.
   */
  first_attempt?: ISODateTime | undefined;
  /**
   * RFC 3339 timestamp after which delivery is abandoned. Must be in
   * the future and within 8 days of the request.
   */
  expires?: ISODateTime | undefined;
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
 * multiple To/Cc/Bcc recipients, with Bcc recipients hidden.
 */
export interface CreateMessageRequest {
  /** Sender — must be on a verified sending domain of your account. */
  from: Address;
  /** 1–100 recipients (the API rejects an empty array). */
  recipients: readonly Recipient[];
  subject: string;
  reply_to?: Address | undefined;
  /** Plain-text body. Required if `html_content` is empty. */
  text_content?: string | undefined;
  /** HTML body. Required if `text_content` is empty. */
  html_content?: string | undefined;
  /** AMP HTML variant. */
  amp_content?: string | undefined;
  attachments?: readonly Attachment[] | undefined;
  /** Custom SMTP headers. `Reply-To` and `Message-ID` are managed by the API. */
  headers?: Record<string, string> | undefined;
  /** Request-level template variables; per-recipient substitutions win. */
  substitutions?: Record<string, SubstitutionValue> | undefined;
  /** Free-form tags for filtering in lists, statistics, and webhooks. */
  tags?: readonly string[] | undefined;
  /**
   * Sandbox mode: the API validates and accepts the request but no
   * email leaves the platform. The `from` domain must still be verified.
   */
  sandbox?: boolean | undefined;
  /** Simulated outcome when `sandbox: true`. Defaults to `deliver`. */
  sandbox_result?: SandboxResult | undefined;
  /** Open/click tracking overrides; `null` fields fall back to account defaults. */
  tracking?: Tracking | undefined;
  /** Data-retention overrides; `null` fields fall back to account defaults. */
  retention?: Retention | undefined;
  schedule?: MessageSchedule | undefined;
}

export interface CreateConversationMessageRequest {
  from: Address;
  /** 1–50 To recipients (combined To+Cc+Bcc must be ≤50). */
  to: readonly Address[];
  subject: string;
  cc?: readonly Address[] | undefined;
  bcc?: readonly Address[] | undefined;
  reply_to?: Address | undefined;
  text_content?: string | undefined;
  html_content?: string | undefined;
  amp_content?: string | undefined;
  attachments?: readonly Attachment[] | undefined;
  headers?: Record<string, string> | undefined;
  tags?: readonly string[] | undefined;
  sandbox?: boolean | undefined;
  sandbox_result?: SandboxResult | undefined;
  tracking?: Tracking | undefined;
  retention?: Retention | undefined;
  schedule?: MessageSchedule | undefined;
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
  status?: string | undefined;
  sender?: string | undefined;
  recipient?: string | undefined;
  subject?: string | undefined;
  message_id_header?: string | undefined;
  tags?: string | undefined;
  from_time?: ISODateTime | undefined;
  to_time?: ISODateTime | undefined;
};

/** Send, list, fetch, and cancel transactional messages. */
export interface MessagesClient {
  /**
   * Send a message to 1–100 recipients. Each recipient gets a separate
   * email with their own substitutions applied.
   *
   * **This is a multi-status operation.** A 202 does not mean every recipient
   * was accepted: the promise resolves with one {@link SendMessageResult} per
   * recipient, and an individual entry can carry `status: "error"` with a
   * non-null `error` and a null `id` (for example a suppressed address).
   * Inspect every entry — treating a resolved promise as full success silently
   * reports dropped mail as delivered:
   *
   * ```ts
   * const res = await client.messages.send({ ... });
   * const failed = res.data.filter((r) => r.status === "error");
   * if (failed.length > 0) {
   *   log.warn("some recipients were not queued", failed);
   * }
   * ```
   *
   * When automatic idempotency is enabled (the default), the SDK generates an
   * `Idempotency-Key` unless you pass `options.idempotencyKey`. Reuse a stable
   * key for your own retries; stored non-server-error results can be replayed
   * for 24 hours, while server errors release the key for re-execution.
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  send(
    body: CreateMessageRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<SendMessageResponse>;

  /**
   * Send a single message to multiple To/Cc/Bcc recipients (combined ≤ 50).
   * To and Cc recipients can see one another; Bcc recipients remain hidden.
   * Use {@link send} for individualized fan-out.
   *
   * **This is a multi-status operation.** A 202 does not mean every recipient
   * was accepted: the promise resolves with one {@link SendMessageResult} per
   * recipient, and an individual entry can carry `status: "error"` with a
   * non-null `error` and a null `id` (for example a suppressed address).
   * Inspect every entry — treating a resolved promise as full success silently
   * reports dropped mail as delivered:
   *
   * ```ts
   * const res = await client.messages.send({ ... });
   * const failed = res.data.filter((r) => r.status === "error");
   * if (failed.length > 0) {
   *   log.warn("some recipients were not queued", failed);
   * }
   * ```
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  sendConversation(
    body: CreateConversationMessageRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<SendMessageResponse>;

  /**
   * Fetch one page of messages using cursor pagination. Filters combine with AND semantics.
   *
   * `messages:read:all` returns every message; `messages:read:{domain}` returns
   * only messages whose `sender` domain is authorized.
   */
  list(
    params?: ListMessagesParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<MessageSummary>>;

  /** Iterate through every matching message, fetching cursor pages lazily. */
  iterate(
    params?: ListMessagesParams,
    options?: RequestOptions,
  ): AsyncGenerator<MessageSummary, void, undefined>;

  /**
   * Fetch a single message by its message ID. Accepts the generated
   * Message-ID returned by {@link send} when non-null, or its bare UUID
   * portion. Only the UUID is sent as the path segment — the server routes on
   * it, and it needs no percent-encoding — and a value containing no UUID is
   * refused locally as {@link AhaSendConfigurationError}.
   *
   * Authorization requires `messages:read:all` or `messages:read:{domain}`
   * matching the message's `sender` domain.
   */
  get(messageId: string, options?: RequestOptions): AhaSendPromise<Message>;

  /**
   * Cancel a queued or scheduled message. Only possible before the
   * first delivery attempt; already-sent messages cannot be recalled.
   * Accepts the generated Message-ID returned by {@link send} when non-null,
   * or its bare UUID portion.
   *
   * Authorization requires `messages:cancel:all` or `messages:cancel:{domain}`
   * matching the message's `sender` domain.
   */
  cancel(messageId: string, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class MessagesClientImplementation implements MessagesClient {
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
   * When automatic idempotency is enabled (the default), the SDK generates an
   * `Idempotency-Key` unless you pass `options.idempotencyKey`. Reuse a stable
   * key for your own retries; stored non-server-error results can be replayed
   * for 24 hours, while server errors release the key for re-execution.
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  send(
    body: CreateMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<SendMessageResponse> {
    const forwarded = forwardWithIdempotency(options);
    assertNonEmptyArray(body?.recipients, "recipients");
    return this.#operations.execute(
      "createMessage",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  /**
   * Send a single message to multiple To/Cc/Bcc recipients (combined ≤ 50).
   * To and Cc recipients can see one another; Bcc recipients remain hidden.
   * Use {@link send} for individualized fan-out.
   *
   * Authorization requires `messages:send:all` or `messages:send:{domain}`
   * matching the domain in `from.email`.
   */
  sendConversation(
    body: CreateConversationMessageRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<SendMessageResponse> {
    const forwarded = forwardWithIdempotency(options);
    assertNonEmptyArray(body?.to, "to");
    for (const field of ["cc", "bcc"] as const) {
      if (body?.[field] !== undefined) assertNonEmptyArray(body[field], field);
    }
    return this.#operations.execute(
      "createConversationMessage",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  /**
   * Fetch one page of messages using cursor pagination. Filters combine with AND semantics.
   *
   * `messages:read:all` returns every message; `messages:read:{domain}` returns
   * only messages whose `sender` domain is authorized.
   */
  list(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<MessageSummary>> {
    return this.#operations.execute(
      "getMessages",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every matching message, fetching cursor pages lazily. */
  iterate(
    params: ListMessagesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<MessageSummary, void, undefined> {
    return paginate<MessageSummary, ListMessagesParams>((p) => this.list(p, options), params);
  }

  /**
   * Fetch a single message by its message ID. Accepts the generated
   * Message-ID returned by {@link send} when non-null, or its bare UUID
   * portion. Only the UUID is sent as the path segment — the server routes on
   * it, and it needs no percent-encoding — and a value containing no UUID is
   * refused locally as {@link AhaSendConfigurationError}.
   *
   * Authorization requires `messages:read:all` or `messages:read:{domain}`
   * matching the message's `sender` domain.
   */
  get(messageId: string, options: RequestOptions = {}): AhaSendPromise<Message> {
    return this.#operations.execute(
      "getMessage",
      { path: { account_id: this.#accountId, message_id: messagePathId(messageId) } },
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
  cancel(messageId: string, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "cancelMessage",
      { path: { account_id: this.#accountId, message_id: messagePathId(messageId) } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the message resource implementation for the root client. */
export function createMessagesClient(
  operations: OperationExecutor,
  accountId: UUID,
): MessagesClient {
  return new MessagesClientImplementation(operations, accountId);
}
