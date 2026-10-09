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

/** One variable a template's design uses, and whether a send must supply it. */
export interface TemplateVariable {
  name: string;
  /**
   * False for a variable the design wraps in a fallback, and for `email`,
   * `unsubscribe_url` and `view_browser_url`, which the send supplies itself.
   */
  required: boolean;
}

/**
 * The editor a template is designed with. It never changes after the template is created.
 *
 * - `advanced`: designed in MJML.
 * - `simple`: designed with the dashboard's simple editor. Its HTML can be read but changed only
 *   in the dashboard.
 * - `html`: an HTML template.
 */
export type TemplateEditor = "advanced" | "simple" | "html";

/**
 * A template's content. A key that does not apply to the template's editor is left out, and so
 * are `mjml`, `html` and `text` when they are empty.
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
}

/** A transactional template: its published copy, which is what a send uses. */
export interface Template {
  object: "template";
  id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  /** The published subject. Empty until one is published; a send's own `subject` wins over it. */
  subject: string;
  /** The published preview text, injected into the delivered HTML when it is set. */
  preheader: string;
  variables: TemplateVariable[];
  /**
   * The default sender, used by a send that names no `from`. `null` when the
   * template has none, and then every send naming it must give a `from`.
   */
  from: Address | null;
  /**
   * The default reply-to address, used by a send that sets no reply-to, also one
   * that names its own `from`. `null` when the template has none. It has the
   * shape of a send's `reply_to`, and its `name` is always empty.
   */
  reply_to: Address | null;
  editor: TemplateEditor;
  /** Whether changes saved in the dashboard or through the API wait to be published. */
  has_draft: boolean;
  /**
   * The published content; `null` when the published copy has no body. Absent from the items of
   * `list()` and `iterate()`; every other method that returns a Template sets it.
   */
  content?: TemplateContent | null;
}

/** A template's draft: the changes saved in the dashboard or through the API, not yet published. */
export interface TemplateDraft {
  object: "template_draft";
  template_id: UUID;
  /** When the draft last changed. */
  updated_at: ISODateTime;
  subject: string;
  preheader: string;
  /** Every variable the draft uses, as a send would require them once the draft is published. */
  variables: TemplateVariable[];
  from: Address | null;
  /** The draft's default reply-to address. Its `name` is always empty. */
  reply_to: Address | null;
  /** The draft's content; `null` when the draft has no body. */
  content: TemplateContent | null;
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
 * The content of a template write. It holds at most one of `mjml` and `html`, and at least one
 * of `mjml`, `html` and `text`. For an `advanced` or `html` template, the `content` a TemplateDraft
 * returns, or a Template with no draft, can be sent back as it is. While a draft exists, a Template's `content` is the published
 * one, and sending it back replaces the draft's design. For a `simple` template, send back only
 * `text`.
 */
export interface TemplateContentInput {
  /**
   * The MJML source; only for `advanced` templates. It is compiled in strict mode. Images and
   * stylesheets must use `https://` URLs; a URL that starts with a `{{ variable }}` is accepted.
   */
  mjml?: string | undefined;
  /**
   * The HTML; only for `html` templates. Images and stylesheets must use `https://` URLs; a URL
   * that starts with a `{{ variable }}` is accepted.
   */
  html?: string | undefined;
  /**
   * The plain text version. `null` makes the text from the HTML. Left out beside a new `mjml` or
   * `html`, it keeps the draft's text when that text is custom, and that text must still render;
   * otherwise, and on a create, the text is made from the new HTML.
   */
  text?: string | null | undefined;
  /** Accepted so a read `content` can be sent back, and ignored. */
  text_is_custom?: boolean | undefined;
}

/**
 * A new template. Its fields go to its draft, as a dashboard save does; `publish: true`
 * publishes the draft in the same request, so sends use it.
 */
export interface CreateTemplateRequest {
  /** 1–255 characters after trimming. */
  name: string;
  /**
   * Required when `content` holds neither `mjml` nor `html`. `content.mjml` means `advanced` and
   * `content.html` means `html`; an `editor` that disagrees with the content is refused.
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
 * publish publishes the whole draft, including changes made in the dashboard.
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
   * `https://` URLs. Authorization requires `templates:write`.
   */
  create(
    body: CreateTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Template>;

  /**
   * Retrieve one template's published copy by UUID, with its content and the variables a send
   * must supply. Authorization requires `templates:read`.
   */
  get(templateId: string, options?: RequestOptions): AhaSendPromise<Template>;

  /**
   * Change a template and return its published copy; `has_draft` says whether a draft is left.
   * Sending the same request again changes nothing more, and a retry with the same idempotency
   * key replays the first answer. A 503 means the template kept changing while the request wrote
   * it; the request can be sent again. Authorization requires `templates:write`.
   */
  update(
    templateId: UUID,
    body: UpdateTemplateRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<Template>;

  /** Delete a template; sends of it fail from then on. Authorization requires `templates:delete`. */
  delete(templateId: UUID, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /**
   * Retrieve a template's draft. A template with no draft answers 404.
   * Authorization requires `templates:read`.
   */
  getDraft(templateId: UUID, options?: RequestOptions): AhaSendPromise<TemplateDraft>;

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

  getDraft(templateId: UUID, options: RequestOptions = {}): AhaSendPromise<TemplateDraft> {
    return this.#operations.execute(
      "getTemplateDraft",
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
