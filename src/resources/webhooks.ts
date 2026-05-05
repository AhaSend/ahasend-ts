import type { HttpClient } from "../http.js";
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
  domains?: string[];
  success_count?: number;
  error_count?: number;
  errors_since_last_success?: number;
  last_request_at?: ISODateTime | null;
}

export interface CreatedWebhook extends Webhook {
  secret: string;
}

export interface CreateWebhookRequest {
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
  scope: WebhookScope;
  domains?: string[];
}

export interface UpdateWebhookRequest {
  name?: string | null;
  url?: string | null;
  enabled?: boolean | null;
  on_reception?: boolean | null;
  on_delivered?: boolean | null;
  on_transient_error?: boolean | null;
  on_failed?: boolean | null;
  on_bounced?: boolean | null;
  on_suppressed?: boolean | null;
  on_opened?: boolean | null;
  on_clicked?: boolean | null;
  on_suppression_created?: boolean | null;
  on_dns_error?: boolean | null;
  scope?: WebhookScope | null;
  domains?: string[] | null;
}

export class WebhooksClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  list(
    domain: string,
    params: PaginationParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Webhook>> {
    return this.http.request<PaginatedResponse<Webhook>>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/webhooks`,
      query: params as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  create(
    domain: string,
    body: CreateWebhookRequest,
    options: IdempotencyRequestOptions = {},
  ): Promise<CreatedWebhook> {
    return this.http.request<CreatedWebhook>({
      method: "POST",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/webhooks`,
      body,
      ...forwardWithIdempotency(options),
    });
  }

  get(domain: string, webhookId: UUID, options: RequestOptions = {}): Promise<Webhook> {
    return this.http.request<Webhook>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/webhooks/${encodeURIComponent(webhookId)}`,
      ...forwardOptions(options),
    });
  }

  update(
    domain: string,
    webhookId: UUID,
    body: UpdateWebhookRequest,
    options: RequestOptions = {},
  ): Promise<Webhook> {
    return this.http.request<Webhook>({
      method: "PUT",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/webhooks/${encodeURIComponent(webhookId)}`,
      body,
      ...forwardOptions(options),
    });
  }

  delete(domain: string, webhookId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.http.request<SuccessResponse>({
      method: "DELETE",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/domains/${encodeURIComponent(domain)}/webhooks/${encodeURIComponent(webhookId)}`,
      ...forwardOptions(options),
    });
  }
}
