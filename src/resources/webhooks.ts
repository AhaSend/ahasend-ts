import type { HttpClient } from "../http.js";
import { paginate } from "../pagination.js";
import type {
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { IdempotencyRequestOptions } from "./_helpers.js";

export type WebhookScope = "global" | "scoped";

export interface Webhook {
  object: "webhook";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  url: string;
  enabled: boolean;
  on_reception?: boolean;
  on_delivered?: boolean;
  on_transient_error?: boolean;
  on_failed?: boolean;
  on_bounced?: boolean;
  on_suppressed?: boolean;
  on_opened?: boolean;
  on_clicked?: boolean;
  on_suppression_created?: boolean;
  on_dns_error?: boolean;
  scope?: WebhookScope;
  domains?: string[] | null;
  success_count?: number;
  error_count?: number;
  errors_since_last_success?: number;
  last_request_at?: ISODateTime | null;
}

export interface CreatedWebhook extends Webhook {
  secret: string;
}

interface CreateWebhookBase {
  name: string;
  url: string;
  enabled?: boolean;
  on_reception?: boolean;
  on_delivered?: boolean;
  on_transient_error?: boolean;
  on_failed?: boolean;
  on_bounced?: boolean;
  on_suppressed?: boolean;
  on_opened?: boolean;
  on_clicked?: boolean;
  on_suppression_created?: boolean;
  on_dns_error?: boolean;
}

/**
 * Discriminated union mirroring the spec: `scope: "scoped"` requires a
 * `domains` array; `scope: "global"` must not supply one.
 */
export type CreateWebhookRequest =
  | (CreateWebhookBase & { scope: "global"; domains?: never })
  | (CreateWebhookBase & { scope: "scoped"; domains: string[] });

export interface UpdateWebhookRequest {
  /** Required on the persisted webhook — cannot be cleared via `null`. */
  name?: string;
  /** Required on the persisted webhook — cannot be cleared via `null`. */
  url?: string;
  enabled?: boolean;
  on_reception?: boolean;
  on_delivered?: boolean;
  on_transient_error?: boolean;
  on_failed?: boolean;
  on_bounced?: boolean;
  on_suppressed?: boolean;
  on_opened?: boolean;
  on_clicked?: boolean;
  on_suppression_created?: boolean;
  on_dns_error?: boolean;
  /** Required on the persisted webhook — cannot be cleared via `null`. */
  scope?: WebhookScope;
  /** `null` clears the scoped domains list; an array replaces it. */
  domains?: string[] | null;
}

export type ListWebhooksParams = PaginationParams & {
  enabled?: boolean;
  on_reception?: boolean;
  on_delivered?: boolean;
  on_transient_error?: boolean;
  on_failed?: boolean;
  on_bounced?: boolean;
  on_suppressed?: boolean;
  on_opened?: boolean;
  on_clicked?: boolean;
  on_suppression_created?: boolean;
  on_dns_error?: boolean;
};

/**
 * Manage webhook subscriptions for the account.
 *
 * Webhooks are account-scoped, not domain-scoped. Use the request body's
 * `scope: "scoped"` + `domains: [...]` fields to limit a webhook to a
 * subset of domains.
 */
export class WebhooksClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    params: ListWebhooksParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Webhook>> {
    return this.http.request<PaginatedResponse<Webhook>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/webhooks`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  iterate(
    params: ListWebhooksParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Webhook, void, undefined> {
    return paginate<Webhook, ListWebhooksParams>(
      (p) => this.list(p, options),
      params,
    );
  }

  create(
    body: CreateWebhookRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedWebhook> {
    return this.http.request<CreatedWebhook>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/webhooks`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(webhookId: UUID, options: RequestOptions = {}): Promise<Webhook> {
    return this.http.request<Webhook>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/webhooks/${encodeURIComponent(webhookId)}`,
      ...forwardOptions(options),
    });
  }

  update(
    webhookId: UUID,
    body: UpdateWebhookRequest,
    options: RequestOptions = {},
  ): Promise<Webhook> {
    return this.http.request<Webhook>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/webhooks/${encodeURIComponent(webhookId)}`,
      body,
      ...forwardOptions(options),
    });
  }

  delete(webhookId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/webhooks/${encodeURIComponent(webhookId)}`,
      ...forwardOptions(options),
    });
  }
}
