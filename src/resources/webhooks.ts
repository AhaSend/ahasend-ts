import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import { assertNonEmptyArray, forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export type WebhookScope = "global" | "scoped";

/**
 * Who made a change that a contact or suppression event reports: `recipient` for the contact or
 * recipient, through an unsubscribe link, a one-click unsubscribe, or a spam complaint; `api` for
 * you, through the AhaSend API; `dashboard` for you, through the AhaSend dashboard; `system` for
 * AhaSend, for example after a bounce, an expired message or an email validation, or when AhaSend
 * support makes the change.
 */
export type WebhookOrigin = "recipient" | "api" | "dashboard" | "system";

export interface Webhook {
  object: "webhook";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  url: string;
  enabled: boolean;
  on_reception: boolean;
  on_delivered: boolean;
  on_transient_error: boolean;
  on_failed: boolean;
  on_bounced: boolean;
  on_suppressed: boolean;
  on_opened: boolean;
  on_clicked: boolean;
  on_unsubscribed: boolean;
  on_complained: boolean;
  on_suppression_created: boolean;
  on_suppression_deleted: boolean;
  on_dns_error: boolean;
  on_contact_created: boolean;
  on_contact_updated: boolean;
  on_contact_deleted: boolean;
  on_contact_added_to_list: boolean;
  on_contact_removed_from_list: boolean;
  on_contact_subscribed: boolean;
  on_contact_unsubscribed: boolean;
  on_contact_complained: boolean;
  /**
   * The origins of the contact and suppression events the webhook gets, or `null` for every
   * origin. Message events and `domain.dns_error` have no origin, and the webhook always gets them.
   */
  origins: WebhookOrigin[] | null;
  scope: WebhookScope;
  /** Always present. Global webhooks return an empty array. */
  domains: string[];
  success_count: number;
  error_count: number;
  errors_since_last_success: number;
  last_request_at: ISODateTime | null;
}

export interface CreatedWebhook extends Webhook {
  secret: string;
}

/**
 * Discriminated union mirroring the spec: `scope: "scoped"` requires a
 * non-empty `domains` array. Global webhooks may omit `domains` or send
 * any array or `null`; the API accepts and ignores supplied values.
 */
export type CreateWebhookRequest = {
  name: string;
  url: string;
  enabled?: boolean | undefined;
  on_reception?: boolean | undefined;
  on_delivered?: boolean | undefined;
  on_transient_error?: boolean | undefined;
  on_failed?: boolean | undefined;
  on_bounced?: boolean | undefined;
  on_suppressed?: boolean | undefined;
  on_opened?: boolean | undefined;
  on_clicked?: boolean | undefined;
  on_unsubscribed?: boolean | undefined;
  on_complained?: boolean | undefined;
  on_suppression_created?: boolean | undefined;
  on_suppression_deleted?: boolean | undefined;
  on_dns_error?: boolean | undefined;
  /** The contact events need the contact read scopes on the API key. */
  on_contact_created?: boolean | undefined;
  on_contact_updated?: boolean | undefined;
  on_contact_deleted?: boolean | undefined;
  on_contact_added_to_list?: boolean | undefined;
  on_contact_removed_from_list?: boolean | undefined;
  on_contact_subscribed?: boolean | undefined;
  on_contact_unsubscribed?: boolean | undefined;
  on_contact_complained?: boolean | undefined;
  /**
   * The origins of the contact and suppression events the webhook gets. Omit it or send `null` for
   * every origin. An empty array is refused with `400`: to stop contact or suppression events, turn
   * them off. All four origins are saved as `null`, so an origin added later reaches the webhook
   * too.
   */
  origins?: readonly WebhookOrigin[] | null | undefined;
} & (
  | { scope: "global"; domains?: readonly string[] | null | undefined }
  | { scope: "scoped"; domains: readonly string[] }
);

export interface UpdateWebhookRequest {
  /** Omit or send `null` to preserve the stored value. */
  name?: string | null | undefined;
  /** Omit or send `null` to preserve the stored value. */
  url?: string | null | undefined;
  enabled?: boolean | null | undefined;
  on_reception?: boolean | null | undefined;
  on_delivered?: boolean | null | undefined;
  on_transient_error?: boolean | null | undefined;
  on_failed?: boolean | null | undefined;
  on_bounced?: boolean | null | undefined;
  on_suppressed?: boolean | null | undefined;
  on_opened?: boolean | null | undefined;
  on_clicked?: boolean | null | undefined;
  on_unsubscribed?: boolean | null | undefined;
  on_complained?: boolean | null | undefined;
  on_suppression_created?: boolean | null | undefined;
  on_suppression_deleted?: boolean | null | undefined;
  on_dns_error?: boolean | null | undefined;
  /** The contact events need the contact read scopes on the API key. */
  on_contact_created?: boolean | null | undefined;
  on_contact_updated?: boolean | null | undefined;
  on_contact_deleted?: boolean | null | undefined;
  on_contact_added_to_list?: boolean | null | undefined;
  on_contact_removed_from_list?: boolean | null | undefined;
  on_contact_subscribed?: boolean | null | undefined;
  on_contact_unsubscribed?: boolean | null | undefined;
  on_contact_complained?: boolean | null | undefined;
  /**
   * Omit or send `null` to preserve the stored origins; send all four origins to get every origin
   * again. An empty array is refused with `400`.
   */
  origins?: readonly WebhookOrigin[] | null | undefined;
  /** Omit or send `null` to preserve the stored scope. */
  scope?: WebhookScope | null | undefined;
  /** Omit or send `null` to preserve associations; `[]` explicitly clears them. */
  domains?: readonly string[] | null | undefined;
}

export type ListWebhooksParams = PaginationParams & {
  enabled?: boolean | undefined;
  on_reception?: boolean | undefined;
  on_delivered?: boolean | undefined;
  on_transient_error?: boolean | undefined;
  on_failed?: boolean | undefined;
  on_bounced?: boolean | undefined;
  on_suppressed?: boolean | undefined;
  on_opened?: boolean | undefined;
  on_clicked?: boolean | undefined;
  on_unsubscribed?: boolean | undefined;
  on_complained?: boolean | undefined;
  on_suppression_created?: boolean | undefined;
  on_suppression_deleted?: boolean | undefined;
  on_dns_error?: boolean | undefined;
  on_contact_created?: boolean | undefined;
  on_contact_updated?: boolean | undefined;
  on_contact_deleted?: boolean | undefined;
  on_contact_added_to_list?: boolean | undefined;
  on_contact_removed_from_list?: boolean | undefined;
  on_contact_subscribed?: boolean | undefined;
  on_contact_unsubscribed?: boolean | undefined;
  on_contact_complained?: boolean | undefined;
};

/**
 * Manage webhook subscriptions for the account.
 *
 * Webhooks are account-scoped, not domain-scoped. Use the request body's
 * `scope: "scoped"` + `domains: [...]` fields to limit a webhook to a
 * subset of domains.
 */
export interface WebhooksClient {
  /**
   * Fetch one cursor-paginated page of configured webhooks.
   *
   * `webhooks:read:all` returns every webhook; `webhooks:read:{domain}` returns
   * only webhooks with at least one authorized `domains` entry.
   */
  list(
    params?: ListWebhooksParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Webhook>>;

  /** Iterate through every matching webhook, fetching cursor pages lazily. */
  iterate(
    params?: ListWebhooksParams,
    options?: RequestOptions,
  ): AsyncGenerator<Webhook, void, undefined>;

  /**
   * Create a configured webhook.
   *
   * A `scoped` webhook requires `webhooks:write:{domain}` for every `domains`
   * entry; `scope: "global"` requires `webhooks:write:all`.
   *
   * The response is the only time the signing `secret` is exposed.
   */
  create(
    body: CreateWebhookRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreatedWebhook>;

  /**
   * Fetch a configured webhook by ID.
   *
   * Authorization requires `webhooks:read:all` or `webhooks:read:{domain}`
   * matching at least one webhook `domains` entry.
   */
  get(webhookId: UUID, options?: RequestOptions): AhaSendPromise<Webhook>;

  /**
   * Partially update a configured webhook by ID.
   *
   * Authorization requires `webhooks:write:{domain}` for the existing webhook
   * and every new `domains` entry; changing `scope` to `global` requires
   * `webhooks:write:all`.
   */
  update(
    webhookId: UUID,
    body: UpdateWebhookRequest,
    options?: RequestOptions,
  ): AhaSendPromise<Webhook>;

  /**
   * Delete a configured webhook by ID.
   *
   * Authorization requires `webhooks:delete:all` or `webhooks:delete:{domain}`
   * matching at least one webhook `domains` entry.
   */
  delete(webhookId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class WebhooksClientImplementation implements WebhooksClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one page of configured webhooks.
   *
   * `webhooks:read:all` returns every webhook; `webhooks:read:{domain}` returns
   * only webhooks with at least one authorized `domains` entry.
   */
  list(
    params: ListWebhooksParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Webhook>> {
    return this.#operations.execute(
      "getWebhooks",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every matching webhook, fetching cursor pages lazily. */
  iterate(
    params: ListWebhooksParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Webhook, void, undefined> {
    return paginate<Webhook, ListWebhooksParams>((p) => this.list(p, options), params);
  }

  /**
   * Create a configured webhook.
   *
   * A `scoped` webhook requires `webhooks:write:{domain}` for every `domains`
   * entry; `scope: "global"` requires `webhooks:write:all`.
   *
   * The response is the only time the signing `secret` is exposed.
   */
  create(
    body: CreateWebhookRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreatedWebhook> {
    const forwarded = forwardWithIdempotency(options);
    if (body?.scope === "scoped") assertNonEmptyArray(body.domains, "domains");
    return this.#operations.execute(
      "createWebhook",
      { path: { account_id: this.#accountId }, body },
      forwarded,
    );
  }

  /**
   * Fetch a configured webhook by ID.
   *
   * Authorization requires `webhooks:read:all` or `webhooks:read:{domain}`
   * matching at least one webhook `domains` entry.
   */
  get(webhookId: UUID, options: RequestOptions = {}): AhaSendPromise<Webhook> {
    return this.#operations.execute(
      "getWebhook",
      { path: { account_id: this.#accountId, webhook_id: webhookId } },
      forwardOptions(options),
    );
  }

  /**
   * Partially update a configured webhook by ID.
   *
   * Authorization requires `webhooks:write:{domain}` for the existing webhook
   * and every new `domains` entry; changing `scope` to `global` requires
   * `webhooks:write:all`.
   */
  update(
    webhookId: UUID,
    body: UpdateWebhookRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<Webhook> {
    return this.#operations.execute(
      "updateWebhook",
      { path: { account_id: this.#accountId, webhook_id: webhookId }, body },
      forwardOptions(options),
    );
  }

  /**
   * Delete a configured webhook by ID.
   *
   * Authorization requires `webhooks:delete:all` or `webhooks:delete:{domain}`
   * matching at least one webhook `domains` entry.
   */
  delete(webhookId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteWebhook",
      { path: { account_id: this.#accountId, webhook_id: webhookId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the webhook resource implementation for the root client. */
export function createWebhooksClient(
  operations: OperationExecutor,
  accountId: UUID,
): WebhooksClient {
  return new WebhooksClientImplementation(operations, accountId);
}
