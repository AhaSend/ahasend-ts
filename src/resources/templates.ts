import type { MarkupProblem } from "../errors.js";
import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  Address,
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

/**
 * What kind of value to send for a template variable.
 *
 * - `value`: text or a number that appears in the email, such as a first name.
 * - `condition`: used only to decide whether a part of the email is shown, for example "show this
 *   section if `vip` is set". It never appears in the email. To make it set, send a value that is
 *   not empty, such as `true` or `"yes"`. To make it not set, leave it out or send `""`, `false`,
 *   `0`, `null`, `[]` or `{}`. The strings `"false"` and `"0"` are not empty, so they make it set.
 *   A rule can also compare it, for example "show this section if `plan` equals `gold`"; then send
 *   a value that meets the rule to show the section.
 * - `list`: an array. A section of the email is repeated once for each element, for example one
 *   row per product in an order. `item_fields` names the fields each element should have.
 */
export type TemplateVariableKind = "value" | "condition" | "list";

/** One variable a template's design uses: its kind, and whether a send must supply it. */
export interface TemplateVariable {
  name: string;
  /**
   * False for a variable the design wraps in a fallback, and for `email` and
   * `unsubscribe_url`, which the send supplies itself.
   */
  required: boolean;
  /** What kind of value to send for this variable. */
  kind: TemplateVariableKind;
  /**
   * Only on a `list` variable. The fields the repeated section uses from each element: send each
   * element as an object with these fields. A field an element does not have is taken from the
   * variable of the same name in `substitutions`, if there is one.
   *
   * A section that shows each element as it is, such as a list of tags, uses the field `value`;
   * when `item_fields` is `["value"]`, the elements can be plain values, such as
   * `["new", "sale"]`. Empty when the section uses nothing from its elements: send one element, of
   * any kind, for each time the section repeats.
   */
  item_fields?: string[];
}

/**
 * The editor a template is designed with. It never changes after the template is created.
 *
 * - `advanced`: designed in MJML.
 * - `simple`: designed with the dashboard's simple editor. Its HTML is made from the design and
 *   cannot be changed through the API. A read of one item gives the design as AhaSend Markup
 *   (AhaML) in `content.markup`, and a write changes the design with `content.markup`.
 * - `html`: an HTML template.
 */
export type TemplateEditor = "advanced" | "simple" | "html";

/**
 * Why a `simple` design could not be read as AhaML.
 *
 * - `no_design`: the design has no blocks yet.
 * - `html_block`: the design holds an HTML block, which AhaML cannot show. Remove the block in the
 *   dashboard to read and write the design as AhaML.
 * - `unmapped_block`: the design holds a block or a mark that AhaML has no tag for.
 * - `bad_stored_value`: the design holds a value that AhaML cannot write.
 * - `renderer_unavailable`: AhaML cannot be made now. Read the design again later.
 * - `rate_limited`: the account reads and writes AhaML more often than its limit allows. Read the
 *   design again in a second.
 */
export type TemplateMarkupErrorCode =
  | "no_design"
  | "html_block"
  | "unmapped_block"
  | "bad_stored_value"
  | "renderer_unavailable"
  | "rate_limited";

/** Why `content.markup` is `null`. */
export interface TemplateMarkupError {
  code: TemplateMarkupErrorCode;
  /** What went wrong, in words for a person. */
  message: string;
}

/**
 * A template's content. A key that does not apply to the template's editor is left out, and so
 * are `mjml`, `html` and `text` when they are empty. A read of one `simple` design also gives the
 * design as AhaSend Markup (AhaML) in `markup`. When AhaML cannot be made, the read still
 * succeeds, with `markup` set to `null` and `markup_error` saying why.
 */
export interface TemplateContent {
  /** The MJML source. Only for `advanced` templates. */
  mjml?: string;
  /** The HTML of an `html` template, or the HTML made from the design of a `simple` template. */
  html?: string;
  /** The plain text version of the email. */
  text?: string;
  /** Whether the text was written rather than made from the HTML. */
  text_is_custom: boolean;
  /**
   * The design as AhaSend Markup (AhaML). Only for `simple` designs, and then always present.
   * `null` when AhaML cannot be made; `markup_error` then says why.
   */
  markup?: string | null;
  /** Why `markup` is `null`. Present only when it is. */
  markup_error?: TemplateMarkupError;
}

/**
 * A transactional template. `get()` and the writes return its working copy: the draft while one
 * exists, and the published copy otherwise. `getPublished()`, `list()` and `iterate()` return its
 * published copy, which is what a send uses.
 */
export interface Template {
  object: "template";
  id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  /**
   * This copy's subject. Empty until one is set. A send uses the published subject, unless it
   * names its own `subject`.
   */
  subject: string;
  /** This copy's preview text, which a send of the published copy injects into the HTML. */
  preheader: string;
  /**
   * Every variable this copy's design uses. A send uses the published copy's variables, which
   * `getPublished()` returns, and takes the values only from each recipient's `substitutions`.
   * Each variable's `kind` says what shape of value to send.
   */
  variables: TemplateVariable[];
  /**
   * This copy's default sender. A send that names no `from` uses the published copy's. `null`
   * when the copy has none; a send of a published copy with none must give a `from`.
   */
  from: Address | null;
  /**
   * This copy's default reply-to address. A send that sets no reply-to, also one that names its
   * own `from`, uses the published copy's. `null` when the copy has none. It has the shape of a
   * send's `reply_to`, and its `name` is always empty.
   */
  reply_to: Address | null;
  editor: TemplateEditor;
  /**
   * Whether changes saved in the dashboard or through the API wait to be published. `get()`
   * returns the draft while one exists.
   */
  has_draft: boolean;
  /**
   * This copy's content; `null` when it has no body, as for the published copy of a template that
   * was never published. Absent from the items of `list()` and `iterate()`; every other method
   * that returns a Template sets it.
   */
  content?: TemplateContent | null;
  /**
   * Warnings about the AhaML in `content.markup`, up to the first 100; empty when there are none.
   * Present only in the answer to a write that carried `content.markup`.
   */
  markup_warnings?: MarkupProblem[];
}

/** Who published a template version. */
export interface TemplatePublisher {
  /** `user` for a version published in the dashboard, `api_key` for one published through the API. */
  type: "user" | "api_key";
  /** The user's ID, as `accounts.listMembers()` shows it, or the API key's ID. */
  id: UUID;
}

/** One published version of a template, without its content. */
export interface TemplateVersion {
  object: "template_version";
  id: UUID;
  /** The version number, counted from 1 for each template. */
  version: number;
  published_at: ISODateTime;
  /**
   * Who published the version. `null` when this is not known, as for older versions, or when
   * the user or API key was deleted for good.
   */
  published_by: TemplatePublisher | null;
}

/** One published version of a template with its content. */
export interface TemplateVersionDetail extends TemplateVersion {
  subject: string;
  preheader: string;
  /**
   * Every variable the version uses, as saved when the version was published. A version published
   * before kinds were recorded shows every variable as `value`, with no `item_fields`; save and
   * publish the template again to get a version that records them.
   */
  variables: TemplateVariable[];
  from: Address | null;
  /** The version's default reply-to address. Its `name` is always empty. */
  reply_to: Address | null;
  /** The version's content; `null` when the version has no body. */
  content: TemplateContent | null;
}

/** A template's published versions, newest first. The list is not paginated. */
export interface ListTemplateVersionsResponse {
  object: "list";
  data: TemplateVersion[];
}

/**
 * The content of a template write. It holds at most one of `mjml` and `html`, never `markup`
 * beside `mjml`, and at least one of `markup`, `mjml`, `html` and `text`. The `content` that
 * `get()` returns, the working copy, can be sent back as it is. While a draft exists, a design
 * equal to the published copy's, which `getPublished()` returns, takes the published copy's
 * stored design, and a draft that then equals the published copy is dropped.
 *
 * A `simple` design is written as AhaSend Markup (AhaML) in `markup`. Its `html` is made from the
 * design: beside `markup` it is ignored, and without `markup` it is ignored when it equals the
 * working copy's stored HTML, and refused otherwise; an empty `html` is refused, as for every
 * editor. AhaML that prints the same as the stored design keeps that design and its HTML. A read
 * `content` sent back is still checked, so a stored design that breaks a rule of AhaML, also one
 * saved in the dashboard, is refused, such as an image that is not an `https://` URL.
 */
export interface TemplateContentInput {
  /**
   * The MJML source; only for `advanced` templates. It is compiled in strict mode. Images and
   * stylesheets must use `https://` URLs; a URL that starts with a `{{ variable }}` is accepted.
   */
  mjml?: string | undefined;
  /**
   * The HTML; only for `html` templates. Images and stylesheets must use `https://` URLs; a URL
   * that starts with a `{{ variable }}` is accepted. The HTML of a `simple` design is made from
   * its `markup`, and is accepted only as the rules above give.
   */
  html?: string | undefined;
  /**
   * The plain text version. `null` makes the text from the HTML. Left out beside a new `markup`,
   * `mjml` or `html`, it keeps the draft's text when that text is custom, and that text must still
   * render; otherwise, and on a create, the text is made from the new HTML.
   */
  text?: string | null | undefined;
  /** Accepted so a read `content` can be sent back, and ignored. */
  text_is_custom?: boolean | undefined;
  /**
   * The design as AhaSend Markup (AhaML); only for `simple` designs. On a create, and on a
   * campaign with no design yet, it means `editor: "simple"`. The answer lists warnings about it in
   * `markup_warnings`. A refused `markup` throws an `AhaSendBadRequestError` whose `errors` lists
   * the problems. `null` is the same as no `markup`, and an empty string is refused. The writes
   * that carry it count against a per-account limit, beside the API's own rate limit.
   */
  markup?: string | null | undefined;
  /** Accepted so a read `content` can be sent back, and ignored, whatever it holds. */
  markup_error?: unknown;
}

/**
 * A new template. Its fields go to its draft, as a dashboard save does; `publish: true`
 * publishes the draft in the same request, so sends use it.
 */
export interface CreateTemplateRequest {
  /** 1–255 characters after trimming. */
  name: string;
  /**
   * Required when `content` holds none of `markup`, `mjml` and `html`. `content.markup` means
   * `simple`, also beside `content.html`; `content.mjml` means `advanced`, and `content.html`
   * alone means `html`. An `editor` that disagrees with the content is refused.
   */
  editor?: TemplateEditor | undefined;
  subject?: string | null | undefined;
  preheader?: string | null | undefined;
  /** The default sender, on a domain of this account with valid DNS that is not paused. */
  from?: Address | null | undefined;
  /** The default reply-to address. It needs a `from`, and its `name` must be empty. */
  reply_to?: Address | null | undefined;
  content?: TemplateContentInput | undefined;
  /** Publish the draft once it is written. Defaults to `false`. */
  publish?: boolean | undefined;
}

/**
 * Changes to a template. A field left out is neither changed nor checked, apart from a custom
 * text kept beside a new design (see {@link TemplateContentInput.text}); `null` clears the field.
 * Every field but `name` goes to the draft, and `name` changes at once.
 */
export interface UpdateTemplateRequest {
  /** 1–255 characters after trimming. */
  name?: string | undefined;
  /** `null` or `""` clears the subject. */
  subject?: string | null | undefined;
  /** `null` or `""` clears the preview text. */
  preheader?: string | null | undefined;
  /**
   * Replaces the sender's address and name together, so a missing `name` clears the name; the
   * reply-to is kept. `null` clears the sender and the reply-to.
   */
  from?: Address | null | undefined;
  /** `null` clears the reply-to. It needs a sender, and its `name` must be empty. */
  reply_to?: Address | null | undefined;
  /** The content to write. It cannot be `null`. */
  content?: TemplateContentInput | undefined;
  /**
   * Publish the draft once it is written. With only `publish: true`, the request publishes the
   * draft. Defaults to `false`.
   */
  publish?: boolean | undefined;
}

/** Options for restoring a template version. */
export interface RestoreTemplateVersionRequest {
  /** Publish the draft once the version is restored into it. Defaults to `false`. */
  publish?: boolean | undefined;
}

/** Cursor controls accepted by the template list operation, which takes no filters. */
export type ListTemplatesParams = PaginationParams;

/**
 * Manage the account's transactional templates. A write changes the template's draft, the same
 * draft the dashboard edits, and sends use the published copy until the draft is published. A
 * publish publishes the whole draft, including changes made in the dashboard. `get()` and the
 * writes return the working copy, so a template read, changed and sent back to `update()` builds
 * on what was read; `getPublished()` returns the copy a send uses.
 */
export interface TemplatesClient {
  /**
   * Fetch one newest-first page of templates using mutually exclusive cursors. The items carry
   * no `content`. Authorization requires `templates:read`.
   */
  list(
    params?: ListTemplatesParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Template>>;

  /** Iterate through every template, fetching cursor pages lazily. */
  iterate(
    params?: ListTemplatesParams,
    options?: RequestOptions,
  ): AsyncGenerator<Template, void, undefined>;

  /**
   * Create a template. MJML is compiled in strict mode, and images and stylesheets must use
   * `https://` URLs. A 503 means the AhaML in `content.markup` could not be read now, because the
   * service that reads it is down or busy; nothing was written, and the request can be sent again
   * after `Retry-After`. Authorization requires `templates:write`.
   */
  create(
    body: CreateTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Template>;

  /**
   * Retrieve one template's working copy by UUID: its draft while it has one, and its published
   * copy otherwise; `has_draft` says which. Authorization requires `templates:read`.
   */
  get(templateId: string, options?: RequestOptions): AhaSendPromise<Template>;

  /**
   * Retrieve one template's published copy by UUID, the one a send uses, with its content and the
   * variables a send must supply. Read it to build a send. Authorization requires `templates:read`.
   */
  getPublished(templateId: UUID, options?: RequestOptions): AhaSendPromise<Template>;

  /**
   * Change a template and return its working copy; `has_draft` says whether a draft is left.
   * Sending the same request again changes nothing more, and a retry with the same idempotency
   * key replays the first answer. A 503 means nothing was written, for one of two reasons: the
   * template kept changing while the request wrote it, or the AhaML in `content.markup` could not
   * be read now, because the service that reads it is down or busy. The request can be sent again
   * after `Retry-After`. Authorization requires `templates:write`.
   */
  update(
    templateId: UUID,
    body: UpdateTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Template>;

  /** Delete a template; sends of it fail from then on. Authorization requires `templates:delete`. */
  delete(templateId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Discard a template's draft and return the published copy. A template with no draft is
   * returned as it is. Authorization requires `templates:write`.
   */
  discardDraft(templateId: UUID, options?: RequestOptions): AhaSendPromise<Template>;

  /**
   * Publish a template's draft, so sends use it, and keep it as a new version. A template with
   * no draft is returned as it is when its published copy has a body.
   * Authorization requires `templates:write`.
   */
  publish(templateId: UUID, options?: IdempotencyRequestOptions): AhaSendPromise<Template>;

  /**
   * List a template's published versions, newest first, without their content. A template keeps
   * its most recent versions. Authorization requires `templates:read`.
   */
  listVersions(
    templateId: UUID,
    options?: RequestOptions,
  ): AhaSendPromise<ListTemplateVersionsResponse>;

  /** Retrieve one published version with its content. Authorization requires `templates:read`. */
  getVersion(
    templateId: UUID,
    versionId: UUID,
    options?: RequestOptions,
  ): AhaSendPromise<TemplateVersionDetail>;

  /**
   * Restore a published version into the template's draft, and with `publish: true` publish it.
   * Authorization requires `templates:write`.
   */
  restoreVersion(
    templateId: UUID,
    versionId: UUID,
    body?: RestoreTemplateVersionRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Template>;
}

class TemplatesClientImplementation implements TemplatesClient {
  readonly #operations: OperationExecutor;
  readonly #accountId: UUID;

  constructor(operations: OperationExecutor, accountId: UUID) {
    this.#operations = operations;
    this.#accountId = accountId;
  }

  list(
    params: ListTemplatesParams = {},
    options: RequestOptions = {},
  ): AhaSendPromise<PaginatedResponse<Template>> {
    return this.#operations.execute(
      "listTemplates",
      {
        path: { account_id: this.#accountId },
        query: params,
      },
      forwardOptions(options),
    );
  }

  iterate(
    params: ListTemplatesParams = {},
    options: RequestOptions = {},
  ): AsyncGenerator<Template, void, undefined> {
    return paginate<Template, ListTemplatesParams>((page) => this.list(page, options), params);
  }

  create(
    body: CreateTemplateRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Template> {
    return this.#operations.execute(
      "createTemplate",
      { path: { account_id: this.#accountId }, body },
      forwardWithIdempotency(options),
    );
  }

  get(templateId: string, options: RequestOptions = {}): AhaSendPromise<Template> {
    return this.#operations.execute(
      "getTemplate",
      {
        path: { account_id: this.#accountId, template_id: templateId },
      },
      forwardOptions(options),
    );
  }

  getPublished(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<Template> {
    return this.#operations.execute(
      "getPublishedTemplate",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }

  update(
    templateId: UUID,
    body: UpdateTemplateRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Template> {
    return this.#operations.execute(
      "updateTemplate",
      { path: { account_id: this.#accountId, template_id: templateId }, body },
      forwardWithIdempotency(options),
    );
  }

  delete(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<SuccessResponse> {
    return this.#operations.execute(
      "deleteTemplate",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }

  discardDraft(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<Template> {
    return this.#operations.execute(
      "discardTemplateDraft",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }

  publish(templateId: UUID, options: IdempotencyRequestOptions = {}): AhaSendPromise<Template> {
    return this.#operations.execute(
      "publishTemplate",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardWithIdempotency(options),
    );
  }

  listVersions(
    templateId: UUID,
    options: RequestOptions = {},
  ): AhaSendPromise<ListTemplateVersionsResponse> {
    return this.#operations.execute(
      "listTemplateVersions",
      { path: { account_id: this.#accountId, template_id: templateId } },
      forwardOptions(options),
    );
  }

  getVersion(
    templateId: UUID,
    versionId: UUID,
    options: RequestOptions = {},
  ): AhaSendPromise<TemplateVersionDetail> {
    return this.#operations.execute(
      "getTemplateVersion",
      {
        path: { account_id: this.#accountId, template_id: templateId, version_id: versionId },
      },
      forwardOptions(options),
    );
  }

  restoreVersion(
    templateId: UUID,
    versionId: UUID,
    body?: RestoreTemplateVersionRequest,
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<Template> {
    return this.#operations.execute(
      "restoreTemplateVersion",
      {
        path: { account_id: this.#accountId, template_id: templateId, version_id: versionId },
        ...(body !== undefined ? { body } : {}),
      },
      forwardWithIdempotency(options),
    );
  }
}

/** @internal Construct the templates resource implementation for the root client. */
export function createTemplatesClient(
  operations: OperationExecutor,
  accountId: UUID,
): TemplatesClient {
  return new TemplatesClientImplementation(operations, accountId);
}
