import type { MarkupProblem } from "../errors.js";
import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  AhaSendPromise,
  IdempotencyRequestOptions,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
  UUID,
} from "../types/common.js";
import { forwardOptions, forwardWithIdempotency } from "./_helpers.js";
import type { TemplateContent, TemplateContentInput, TemplateEditor } from "./templates.js";

/**
 * A design a campaign copies when it is made from it. A campaign template has no draft, no
 * versions, no subject and no sender; the campaign owns its subject and sender.
 */
export interface CampaignTemplate {
  object: "campaign_template";
  id: UUID;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  /** The name, as it appears in the dashboard. */
  name: string;
  /** The editor of the design. It never changes after the campaign template is created. */
  editor: TemplateEditor;
  /**
   * The content; `null` when the campaign template has neither HTML nor text, as for one created
   * without content. A campaign can be made from the campaign template only once it has HTML.
   * Absent from the items of `list()` and `iterate()`; every other method that returns a
   * CampaignTemplate sets it.
   */
  content?: TemplateContent | null;
  /**
   * Warnings about the AhaML in `content.markup`, up to the first 100; empty when there are none.
   * Present only in the answer to a write that carried `content.markup`.
   */
  markup_warnings?: MarkupProblem[];
}

/** A new campaign template. */
export interface CreateCampaignTemplateRequest {
  /** 1–255 characters after trimming. */
  name: string;
  /**
   * Required when `content` holds none of `markup`, `mjml` and `html`. `content.markup` means
   * `simple`, also beside `content.html`; `content.mjml` means `advanced`, and `content.html`
   * alone means `html`. An `editor` that disagrees with the content is refused. Without `content`
   * the campaign template gets an empty design, which the dashboard's editor opens.
   */
  editor?: TemplateEditor | undefined;
  /**
   * The content, by the rules of {@link TemplateContentInput}. A campaign template has no draft,
   * so where those rules name the draft, they mean the campaign template itself.
   */
  content?: TemplateContentInput | undefined;
}

/** Changes to a campaign template. A field left out is neither changed nor checked. */
export interface UpdateCampaignTemplateRequest {
  /** 1–255 characters after trimming. */
  name?: string | undefined;
  /**
   * The content, by the rules of {@link TemplateContentInput}, where the draft means the campaign
   * template itself. A `simple` design is written with `markup`.
   */
  content?: TemplateContentInput | undefined;
}

/** Cursor controls accepted by the campaign template list operation, which takes no filters. */
export type ListCampaignTemplatesParams = PaginationParams;

/**
 * Manage the account's campaign templates, the designs a campaign copies when it is made from
 * one. Transactional templates are a different resource; see `client.templates`.
 */
export interface CampaignTemplatesClient {
  /**
   * Fetch one newest-first page of campaign templates using mutually exclusive cursors. The items
   * carry no `content`. Authorization requires `templates:read`.
   */
  list(
    params?: ListCampaignTemplatesParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<CampaignTemplate>>;

  /** Iterate through every campaign template, fetching cursor pages lazily. */
  iterate(
    params?: ListCampaignTemplatesParams,
    options?: RequestOptions,
  ): AsyncGenerator<CampaignTemplate, void, undefined>;

  /**
   * Create a campaign template. MJML is compiled in strict mode, and images and stylesheets must
   * use `https://` URLs. Authorization requires `templates:write`.
   */
  create(
    body: CreateCampaignTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CampaignTemplate>;

  /**
   * Retrieve one campaign template with its content. A transactional template's ID answers 404.
   * Authorization requires `templates:read`.
   */
  get(templateId: UUID, options?: RequestOptions): AhaSendPromise<CampaignTemplate>;

  /**
   * Change a campaign template's name, its content, or both, at once. Campaigns already made from
   * it keep their own copies. A name or content equal to the stored one changes nothing, so the
   * same request can be sent again. A design saved later in the dashboard, also from an editor
   * opened before this request, replaces the design this request wrote: the dashboard's editor
   * saves the whole design. Authorization requires `templates:write`.
   */
  update(
    templateId: UUID,
    body: UpdateCampaignTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<CampaignTemplate>;

  /**
   * Delete a campaign template. Campaigns made from it keep their own copies.
   * Authorization requires `templates:delete`.
   */
  delete(templateId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;
}

class CampaignTemplatesClientImplementation implements CampaignTemplatesClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: ListCampaignTemplatesParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<CampaignTemplate>> {
    return this.#operations.execute(
      "listCampaignTemplates",
      { path: { account_id: this.#accountId }, query: params },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListCampaignTemplatesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<CampaignTemplate, void, undefined> {
    return paginate<CampaignTemplate, ListCampaignTemplatesParams>(
      (page) => this.list(page, options),
      params,
    );
  }

  create(
    body: CreateCampaignTemplateRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CampaignTemplate> {
    return this.#operations.execute(
      "createCampaignTemplate",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<CampaignTemplate> {
    return this.#operations.execute(
      "getCampaignTemplate",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }

  update(
    templateId: UUID,
    body: UpdateCampaignTemplateRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<CampaignTemplate> {
    return this.#operations.execute(
      "updateCampaignTemplate",
      { path: { account_id: this.#accountId, template_id: templateId }, body },
      forwardWithIdempotency(options),
    );
  }

  delete(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteCampaignTemplate",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }
}

/** @internal Construct the campaign templates resource implementation for the root client. */
export function createCampaignTemplatesClient(
  operations: OperationExecutor,
  accountId: UUID,
): CampaignTemplatesClient {
  return new CampaignTemplatesClientImplementation(operations, accountId);
}
