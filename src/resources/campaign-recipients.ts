import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  UUID,
} from "../types/common.js";
import { forwardOptions } from "./_helpers.js";

/** A recipient of a campaign. */
export interface CampaignRecipient {
  object: "campaign_recipient";
  contact_id: UUID;
  /** The address the campaign sent to. */
  email: string;
  /** The name of the list the contact was sent to from. */
  list_name: string;
  /** The status, under the name the dashboard's report shows, as a key of `by_status`. */
  status: string;
  /** `null` when the recipient has no bounce classification. */
  bounce_classification: string | null;
  /** `null` when the recipient has no bounce reason. */
  bounce_reason: string | null;
  /** The receiving server's bounce message; `null` when there is none. */
  bounce_message: string | null;
  /** Delivery attempts. */
  attempts: number;
  /** When the recipient was added to the send. */
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/**
 * The filter and cursor controls of a recipient listing. Name exactly one of `status` and
 * `bounce_classification`.
 */
export type ListCampaignRecipientsParams = PaginationParams &
  (
    | {
        /**
         * A status as a key of the stats' `by_status` names it, such as `Queued`, `Delivered` or
         * `Administratively Bounced`. 1–64 characters.
         */
        status: string;
        bounce_classification?: never;
      }
    | {
        status?: never;
        /**
         * A key of the stats' `by_bounce_classification`, except `Unknown`, which has no
         * recipient page. 1–255 characters.
         */
        bounce_classification: string;
      }
  );

/** Read the recipients of a campaign. */
export interface CampaignRecipientsClient {
  /**
   * Fetch one page of a campaign's recipients in one status or with one bounce classification,
   * by contact ID, the highest first, using mutually exclusive cursors. An empty page past the
   * last recipient has no `previous_cursor`; read the first page again with no cursor.
   * Authorization requires `campaigns:read`.
   */
  list(
    campaignId: UUID,
    params: ListCampaignRecipientsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<CampaignRecipient>>;

  /** Iterate through every matching recipient of a campaign, fetching cursor pages lazily. */
  iterate(
    campaignId: UUID,
    params: ListCampaignRecipientsParams,
    options?: RequestOptions,
  ): AsyncGenerator<CampaignRecipient, void, undefined>;
}

class CampaignRecipientsClientImplementation implements CampaignRecipientsClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    campaignId: UUID,
    params: ListCampaignRecipientsParams,
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<CampaignRecipient>> {
    return this.#operations.execute(
      "listCampaignRecipients",
      {
        path: { account_id: this.#accountId, campaign_id: campaignId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    campaignId: UUID,
    params: ListCampaignRecipientsParams,
    options: RequestOptions = {},
  ): AsyncGenerator<CampaignRecipient, void, undefined> {
    return paginate<CampaignRecipient, ListCampaignRecipientsParams>(
      (page) => this.list(campaignId, page, options),
      params,
    );
  }
}

/** @internal Construct the campaign recipients resource for the campaigns facade. */
export function createCampaignRecipientsClient(
  operations: OperationExecutor,
  accountId: UUID,
): CampaignRecipientsClient {
  return new CampaignRecipientsClientImplementation(operations, accountId);
}
