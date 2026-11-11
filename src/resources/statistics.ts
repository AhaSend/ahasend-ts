import { AhaSendError } from "../errors.js";
import type { OperationExecutor } from "../operations.js";
import { paginatePages } from "../pagination.js";
import type {
  AhaSendPromise,
  ISODateTime,
  PaginationMeta,
  RequestOptions,
  UUID,
} from "../types/common.js";
import { forwardOptions } from "./_helpers.js";

export type StatisticsGranularity = "hour" | "day" | "week" | "month";

export interface StatisticsParams {
  /** Filter, not required — omit to query the full retention window. */
  from_time?: ISODateTime | undefined;
  /** Filter, not required — omit to query the full retention window. */
  to_time?: ISODateTime | undefined;
  sender_domain?: string | undefined;
  recipient_domains?: string | undefined;
  tags?: string | undefined;
  group_by?: StatisticsGranularity | undefined;
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

/** Query parameters of {@link StatisticsClient.emails}. A parameter left unset is not sent. */
export interface EmailStatisticsParams {
  /**
   * Start of the range, included. It is rounded down to the start of its period. Defaults to 30
   * days before `to_time`.
   */
  from_time?: ISODateTime | undefined;
  /**
   * End of the range, excluded. It is rounded up to the start of the next period unless it is
   * already at the start of a period. Defaults to now; a time after now is now.
   */
  to_time?: ISODateTime | undefined;
  /**
   * Length of each period, in UTC. Weeks start on Monday. The range can be at most 31 days for
   * `hour`, 366 days for `day` and `week`, and 5 calendar years for `month`. Defaults to `day`.
   */
  group_by?: StatisticsGranularity | undefined;
  /**
   * Comma-separated domain names of the account, deleted domains included; the key must be able
   * to read every name. Defaults to every domain the key can read.
   */
  sender_domain?: string | undefined;
  /**
   * `domain` returns the rows of each domain, paged by domain. Without it, each row covers all the
   * domains the request selects.
   */
  breakdown?: "domain" | undefined;
  /**
   * Maximum number of domains on a page of a breakdown (1-50, default 25). Only with
   * `breakdown: "domain"`.
   */
  limit?: number | undefined;
  /**
   * Pagination cursor for the next page of a breakdown. Provide the value from `next_cursor` in
   * the response. Only with `breakdown: "domain"`.
   */
  after?: string | undefined;
}

/** The email counts of one period, or of the whole request. Every counter is at least 0. */
export interface EmailStatisticsTotals {
  /** Messages that AhaSend accepted, inbound mail included. Billing counts the same messages. */
  reception_count: number;
  /** Messages delivered */
  delivered_count: number;
  /** Messages bounced */
  bounced_count: number;
  /** Messages not sent because the recipient was suppressed */
  suppressed_count: number;
  /** Spam complaints */
  complained_count: number;
  /**
   * Temporary delivery failures. This counts events, and one message can add more than one, so it
   * differs from `deferred_count` of {@link StatisticsClient.deliverability}, which counts
   * messages.
   */
  deferred_count: number;
  /**
   * Opens. This counts events, and one message can add more than one, so it differs from
   * `opened_count` of {@link StatisticsClient.deliverability}, which counts messages. Opens are
   * not fully accurate; AhaSend makes a reasonable effort to filter out bots and scanners.
   */
  opened_count: number;
  /**
   * Clicks. This counts events, and one message can add more than one, so it differs from
   * `clicked_count` of {@link StatisticsClient.deliverability}, which counts messages. Clicks are
   * not fully accurate; AhaSend makes a reasonable effort to filter out bots and scanners.
   */
  clicked_count: number;
}

/** The email counts of one period, and of one domain in a breakdown. */
export interface EmailStatistics extends EmailStatisticsTotals {
  /** Start of the period */
  from_timestamp: ISODateTime;
  /** End of the period, excluded, which is the start of the next period */
  to_timestamp: ISODateTime;
  /** The domain name of the row in a breakdown. Null without a breakdown. */
  sender_domain: string | null;
}

/** One response of {@link StatisticsClient.emails}: one page of a breakdown, or the whole answer. */
export interface EmailStatisticsResponse {
  /** Object type identifier */
  object: "email_statistics";
  /** Start of the rounded range, included */
  from_time: ISODateTime;
  /** End of the rounded range, excluded */
  to_time: ISODateTime;
  /** Length of each period */
  group_by: StatisticsGranularity;
  /** `domain` for a breakdown by domain. Null without a breakdown. */
  breakdown: "domain" | null;
  /**
   * The counts of the whole request: the whole rounded range and every domain the request
   * selects, on every page of a breakdown
   */
  totals: EmailStatisticsTotals;
  /**
   * Without a breakdown, one row for each period, in time order. With a breakdown, the rows of the
   * domains of this page, by domain name, then by time.
   */
  data: EmailStatistics[];
  /**
   * Pages the domains of a breakdown. `next_cursor` is present when `has_more` is true;
   * `previous_cursor` is never present. Without a breakdown, `has_more` is false.
   */
  pagination: PaginationMeta;
}

/** Transactional sending analytics, and email counts that also cover campaign and inbound mail. */
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

  /**
   * Return the email counts of the account, or of each of its domains, in hourly, daily, weekly,
   * or monthly UTC periods, for any time in the account's history. The message metadata retention
   * period does not limit them. The counts cover transactional, campaign, and inbound mail.
   * Without `breakdown`, `data` has one row for each period of the rounded range. With
   * `breakdown: "domain"`, one call returns one page of up to `limit` domains; use
   * {@link StatisticsClient.emailsPages} to read every page. `totals` covers the whole request on
   * every page.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value. Without `sender_domain`, a key with domain scopes reads the domains
   * named in its scopes.
   */
  emails(
    params?: EmailStatisticsParams,
    options?: RequestOptions,
  ): AhaSendPromise<EmailStatisticsResponse>;

  /**
   * Iterate the responses of {@link StatisticsClient.emails} and yield each whole response,
   * `totals` included. With `breakdown: "domain"`, it passes each page's
   * `pagination.next_cursor` as `after` until `has_more` is false. Without a breakdown, it
   * yields the one response.
   */
  emailsPages(
    params?: EmailStatisticsParams,
    options?: RequestOptions,
  ): AsyncGenerator<EmailStatisticsResponse, void, undefined>;
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

  /**
   * Return the email counts of the account, or of each of its domains, in hourly, daily, weekly,
   * or monthly UTC periods, for any time in the account's history. The message metadata retention
   * period does not limit them. The counts cover transactional, campaign, and inbound mail.
   * Without `breakdown`, `data` has one row for each period of the rounded range. With
   * `breakdown: "domain"`, one call returns one page of up to `limit` domains; use
   * {@link StatisticsClient.emailsPages} to read every page. `totals` covers the whole request on
   * every page.
   * Authorization requires `statistics-transactional:read:all` or
   * `statistics-transactional:read:{domain}` for every comma-separated
   * `sender_domain` value. Without `sender_domain`, a key with domain scopes reads the domains
   * named in its scopes.
   */
  emails(
    params: EmailStatisticsParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<EmailStatisticsResponse> {
    return this.#operations.execute(
      "getEmailStatistics",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  /**
   * Iterate the responses of {@link StatisticsClient.emails} and yield each whole response,
   * `totals` included. With `breakdown: "domain"`, it passes each page's
   * `pagination.next_cursor` as `after` until `has_more` is false. Without a breakdown, it
   * yields the one response.
   *
   * The API works out the range of each request from the time of that request. Every page must
   * have the range of the first page, so the iterator throws an `AhaSendError` when a page comes
   * back with another `from_time` or `to_time`. Pass a `to_time` that is not in the future to
   * keep the range the same on every page.
   */
  async *emailsPages(
    params: EmailStatisticsParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<EmailStatisticsResponse, void, undefined> {
    let first: EmailStatisticsResponse | undefined;
    for await (const page of paginatePages<EmailStatisticsResponse, EmailStatisticsParams>(
      (pageParams) => this.emails(pageParams, options),
      params,
    )) {
      first ??= page;
      if (page.from_time !== first.from_time || page.to_time !== first.to_time) {
        throw new AhaSendError(
          "Email statistics range changed between pages; pass a to_time that is not in the future",
        );
      }
      yield page;
    }
  }
}

/** @internal Construct the statistics resource implementation for the root client. */
export function createStatisticsClient(
  operations: OperationExecutor,
  accountId: UUID,
): StatisticsClient {
  return new StatisticsClientImplementation(operations, accountId);
}
