import type { OperationExecutor } from "../operations.js";
import type { AhaSendPromise, ISODateTime, RequestOptions, UUID } from "../types/common.js";
import { forwardOptions } from "./_helpers.js";

export type StatisticsGranularity = "hour" | "day" | "week" | "month";

export interface StatisticsParams {
  /** Filter, not required — omit to query the full retention window. */
  from_time?: ISODateTime;
  /** Filter, not required — omit to query the full retention window. */
  to_time?: ISODateTime;
  sender_domain?: string;
  recipient_domains?: string;
  tags?: string;
  group_by?: StatisticsGranularity;
}

export interface DeliverabilityStatistics {
  from_timestamp: ISODateTime;
  to_timestamp: ISODateTime;
  reception_count: number;
  delivered_count: number;
  deferred_count: number;
  bounced_count: number;
  failed_count: number;
  suppressed_count: number;
  opened_count: number;
  clicked_count: number;
}

export interface DeliverabilityStatisticsResponse {
  object: "list";
  data: DeliverabilityStatistics[];
}

export interface BounceClassificationCount {
  classification: string;
  count: number;
}

export interface BounceStatistics {
  from_timestamp: ISODateTime;
  to_timestamp: ISODateTime;
  bounces: BounceClassificationCount[];
}

export interface BounceStatisticsResponse {
  object: "list";
  data: BounceStatistics[];
}

export interface DeliveryTimeBreakdown {
  recipient_domain: string;
  delivery_time: number;
  count: number;
}

export interface DeliveryTimeStatistics {
  from_timestamp: ISODateTime;
  to_timestamp: ISODateTime;
  avg_delivery_time: number;
  delivered_count: number;
  delivery_times: DeliveryTimeBreakdown[];
}

export interface DeliveryTimeStatisticsResponse {
  object: "list";
  data: DeliveryTimeStatistics[];
}

/** Transactional sending analytics. */
export interface StatisticsClient {
  /**
   * Return reception, delivery, bounce, open, and click counts bucketed by `group_by`.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  deliverability(
    params?: StatisticsParams,
    options?: RequestOptions,
  ): AhaSendPromise<DeliverabilityStatisticsResponse>;

  /**
   * Return bounce counts broken down by classification for each time bucket.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  bounces(
    params?: StatisticsParams,
    options?: RequestOptions,
  ): AhaSendPromise<BounceStatisticsResponse>;

  /**
   * Return average delivery latency and its recipient-domain breakdown per time bucket.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  deliveryTimes(
    params?: StatisticsParams,
    options?: RequestOptions,
  ): AhaSendPromise<DeliveryTimeStatisticsResponse>;
}

class StatisticsClientImplementation implements StatisticsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  /**
   * Return reception, delivery, bounce, open, and click counts bucketed by `group_by`.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  deliverability(
    params: StatisticsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<DeliverabilityStatisticsResponse> {
    return this.#operations.execute(
      "getDeliverabilityStatistics",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /**
   * Return bounce counts broken down by classification for each time bucket.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  bounces(
    params: StatisticsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<BounceStatisticsResponse> {
    return this.#operations.execute(
      "getBounceStatistics",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /**
   * Return average delivery latency and its recipient-domain breakdown per time bucket.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value.
   */
  deliveryTimes(
    params: StatisticsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<DeliveryTimeStatisticsResponse> {
    return this.#operations.execute(
      "getDeliveryTimeStatistics",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the statistics resource implementation for the root client. */
export function createStatisticsClient(
  operations: OperationExecutor,
  accountId: UUID,
): StatisticsClient {
  return new StatisticsClientImplementation(operations, accountId);
}
