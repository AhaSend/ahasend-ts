import type { OperationExecutor } from "../operations.js";
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

export interface Route {
  object: "route";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  url: string;
  /** Optional per spec — omitted entirely when the route has no recipient filter. */
  recipient?: string | null;
  attachments?: boolean;
  headers?: boolean;
  group_by_message_id?: boolean;
  strip_replies?: boolean;
  enabled: boolean;
  success_count?: number;
  error_count?: number;
  errors_since_last_success?: number;
  last_request_at?: ISODateTime | null;
}

export interface CreatedRoute extends Route {
  secret: string;
}

export interface CreateRouteRequest {
  name: string;
  url: string;
  recipient: string;
  attachments?: boolean;
  headers?: boolean;
  group_by_message_id?: boolean;
  strip_replies?: boolean;
  enabled?: boolean;
}

export interface UpdateRouteRequest {
  /** Required on the persisted route — cannot be cleared via `null`. */
  name?: string;
  /** Required on the persisted route — cannot be cleared via `null`. */
  url?: string;
  recipient?: string | null;
  attachments?: boolean;
  headers?: boolean;
  group_by_message_id?: boolean;
  strip_replies?: boolean;
  enabled?: boolean;
}

export type ListRoutesParams = PaginationParams & {
  domain?: string;
};

/**
 * Manage inbound routes — rules that deliver received email to your
 * HTTP endpoint. The created route's `secret` (returned once) signs
 * `route.message` webhook deliveries; verify them with
 * `WebhookVerifier` from `@ahasend/sdk/webhooks`.
 */
export class RoutesClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Fetch one page of routes.
   *
   * Authorization requires `routes:read:all`, or `routes:read:{domain}` with
   * its matching `domain` query filter.
   */
  list(
    params: ListRoutesParams = {},
    options: RequestOptions = {},
  ): Promise<PaginatedResponse<Route>> {
    return this.#operations.execute<PaginatedResponse<Route>>(
      "getRoutes",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListRoutesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Route, void, undefined> {
    return paginate<Route, ListRoutesParams>((p) => this.list(p, options), params);
  }

  /**
   * Create a route.
   *
   * Authorization requires `routes:write:all` or `routes:write:{domain}`
   * matching the domain in `recipient`.
   *
   * The response is the only time the route signing `secret` is exposed.
   */
  create(body: CreateRouteRequest, options: IdempotencyRequestOptions = {}): Promise<CreatedRoute> {
    return this.#operations.execute<CreatedRoute>(
      "createRoute",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Fetch a route.
   *
   * Authorization requires `routes:read:all` or `routes:read:{domain}` matching
   * the route's `recipient` domain.
   */
  get(routeId: UUID, options: RequestOptions = {}): Promise<Route> {
    return this.#operations.execute<Route>(
      "getRoute",
      { path: { account_id: this.#accountId, route_id: routeId } },
      forwardOptions(options),
    );
  }

  /**
   * Update a route.
   *
   * Authorization requires `routes:write:all`, or `routes:write:{domain}` for
   * both the existing and replacement `recipient` domains.
   */
  update(routeId: UUID, body: UpdateRouteRequest, options: RequestOptions = {}): Promise<Route> {
    return this.#operations.execute<Route>(
      "updateRoute",
      { path: { account_id: this.#accountId, route_id: routeId }, body },
      forwardOptions(options),
    );
  }

  /**
   * Delete a route.
   *
   * Authorization requires `routes:delete:all` or `routes:delete:{domain}`
   * matching the route's `recipient` domain.
   */
  delete(routeId: UUID, options: RequestOptions = {}): Promise<SuccessResponse> {
    return this.#operations.execute<SuccessResponse>(
      "deleteRoute",
      { path: { account_id: this.#accountId, route_id: routeId } },
      forwardOptions(options),
    );
  }
}
