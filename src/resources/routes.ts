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
import {
  forwardOptions,
  forwardWithIdempotency,
  type IdempotencyRequestOptions,
} from "./_helpers.js";

export interface Route {
  object: "route";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  url: string;
  recipient: string;
  attachments: boolean;
  headers: boolean;
  group_by_message_id: boolean;
  strip_replies: boolean;
  enabled: boolean;
  success_count: number;
  error_count: number;
  errors_since_last_success: number;
  last_request_at: ISODateTime | null;
}

export interface CreatedRoute extends Route {
  secret: string;
}

export interface CreateRouteRequest {
  name: string;
  url: string;
  recipient: string;
  attachments?: boolean | undefined;
  headers?: boolean | undefined;
  group_by_message_id?: boolean | undefined;
  strip_replies?: boolean | undefined;
  enabled?: boolean | undefined;
}

export interface UpdateRouteRequest {
  name?: string | null | undefined;
  url?: string | null | undefined;
  recipient?: string | null | undefined;
  attachments?: boolean | null | undefined;
  headers?: boolean | null | undefined;
  group_by_message_id?: boolean | null | undefined;
  strip_replies?: boolean | null | undefined;
  enabled?: boolean | null | undefined;
}

export type ListRoutesParams = PaginationParams & {
  domain?: string | undefined;
};

/**
 * Manage inbound routes — rules that deliver received email to your
 * HTTP endpoint. The created route's `secret` (returned once) signs
 * `message.routing` webhook deliveries; verify them with
 * `WebhookVerifier` from `@ahasend/sdk/webhooks`.
 */
export interface RoutesClient {
  /**
   * Fetch one page of routes.
   *
   * Authorization requires `routes:read:all`, or `routes:read:{domain}` with
   * its matching `domain` query filter.
   */
  list(
    params?: ListRoutesParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Route>>;

  /** Iterate through every matching route, fetching cursor pages lazily. */
  iterate(
    params?: ListRoutesParams,
    options?: RequestOptions,
  ): AsyncGenerator<Route, void, undefined>;

  /**
   * Create an inbound route.
   *
   * Authorization requires `routes:write:all` or `routes:write:{domain}`
   * matching the domain in `recipient`.
   *
   * The response is the only time the route signing `secret` is exposed.
   */
  create(
    body: CreateRouteRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CreatedRoute>;

  /**
   * Fetch a route by ID.
   *
   * Authorization requires `routes:read:all` or `routes:read:{domain}` matching
   * the route's `recipient` domain.
   */
  get(routeId: UUID, options?: RequestOptions): AhaSendPromise<Route>;

  /**
   * Update a route by ID.
   *
   * Authorization requires `routes:write:all`, or `routes:write:{domain}` for
   * both the existing and replacement `recipient` domains.
   */
  update(routeId: UUID, body: UpdateRouteRequest, options?: RequestOptions): AhaSendPromise<Route>;

  /**
   * Delete a route by ID.
   *
   * Authorization requires `routes:delete:all` or `routes:delete:{domain}`
   * matching the route's `recipient` domain.
   */
  delete(routeId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class RoutesClientImplementation implements RoutesClient {
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
  ): AhaSendPromise<PaginatedResponse<Route>> {
    return this.#operations.execute(
      "getRoutes",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /** Iterate through every matching route, fetching cursor pages lazily. */
  iterate(
    params: ListRoutesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Route, void, undefined> {
    return paginate<Route, ListRoutesParams>((p) => this.list(p, options), params);
  }

  /**
   * Create an inbound route.
   *
   * Authorization requires `routes:write:all` or `routes:write:{domain}`
   * matching the domain in `recipient`.
   *
   * The response is the only time the route signing `secret` is exposed.
   */
  create(
    body: CreateRouteRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CreatedRoute> {
    return this.#operations.execute(
      "createRoute",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  /**
   * Fetch a route by ID.
   *
   * Authorization requires `routes:read:all` or `routes:read:{domain}` matching
   * the route's `recipient` domain.
   */
  get(routeId: UUID, options: RequestOptions = {}): AhaSendPromise<Route> {
    return this.#operations.execute(
      "getRoute",
      { path: { account_id: this.#accountId, route_id: routeId } },
      forwardOptions(options),
    );
  }

  /**
   * Update a route by ID.
   *
   * Authorization requires `routes:write:all`, or `routes:write:{domain}` for
   * both the existing and replacement `recipient` domains.
   */
  update(
    routeId: UUID,
    body: UpdateRouteRequest,
    options: RequestOptions = {},
  ): AhaSendPromise<Route> {
    return this.#operations.execute(
      "updateRoute",
      { path: { account_id: this.#accountId, route_id: routeId }, body },
      forwardOptions(options),
    );
  }

  /**
   * Delete a route by ID.
   *
   * Authorization requires `routes:delete:all` or `routes:delete:{domain}`
   * matching the route's `recipient` domain.
   */
  delete(routeId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteRoute",
      { path: { account_id: this.#accountId, route_id: routeId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the route resource implementation for the root client. */
export function createRoutesClient(operations: OperationExecutor, accountId: UUID): RoutesClient {
  return new RoutesClientImplementation(operations, accountId);
}
