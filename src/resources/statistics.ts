import type { HttpClient } from "../http.js";
import type { ISODateTime, RequestOptions, UUID } from "../types/common.js";
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
  delivery_times?: DeliveryTimeBreakdown[];
}

export interface DeliveryTimeStatisticsResponse {
  object: "list";
  data: DeliveryTimeStatistics[];
}

/**
 * Transactional sending analytics.
 *
 * Statistics endpoints are rate-limited far more aggressively than the
 * rest of the API (1 req/s vs 100 req/s) — the SDK's built-in limiter
 * paces these calls automatically.
 */
export class StatisticsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly accountId: UUID,
  ) {}

  /** Reception/delivery/bounce/open/click counts, bucketed by `group_by`. */
  deliverability(
    params: StatisticsParams,
    options: RequestOptions = {},
  ): Promise<DeliverabilityStatisticsResponse> {
    return this.http.request<DeliverabilityStatisticsResponse>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/statistics/transactional/deliverability`,
      query: params as unknown as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  /** Bounce counts broken down by bounce classification per time bucket. */
  bounces(
    params: StatisticsParams,
    options: RequestOptions = {},
  ): Promise<BounceStatisticsResponse> {
    return this.http.request<BounceStatisticsResponse>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/statistics/transactional/bounce`,
      query: params as unknown as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }

  /** Average delivery latency per time bucket, with per-recipient-domain breakdown. */
  deliveryTimes(
    params: StatisticsParams,
    options: RequestOptions = {},
  ): Promise<DeliveryTimeStatisticsResponse> {
    return this.http.request<DeliveryTimeStatisticsResponse>({
      method: "GET",
      path: `/v2/accounts/${encodeURIComponent(this.accountId)}/statistics/transactional/delivery-time`,
      query: params as unknown as Record<string, unknown>,
      ...forwardOptions(options),
    });
  }
}
