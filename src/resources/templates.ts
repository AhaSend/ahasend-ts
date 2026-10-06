import type { OperationExecutor } from "../operations.js";
import { paginate } from "../pagination.js";
import type {
  Address,
  AhaSendPromise,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  UUID,
} from "../types/common.js";
import { forwardOptions } from "./_helpers.js";

/** One variable a template's design uses, and whether a send must supply it. */
export interface TemplateVariable {
  name: string;
  /**
   * False for a variable the design wraps in a fallback, and for `email`,
   * `unsubscribe_url` and `view_browser_url`, which the send supplies itself.
   */
  required: boolean;
}

/** A transactional template and the variables a send naming it has to satisfy. */
export interface Template {
  object: "template";
  id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  name: string;
  /** Empty unless the design carries one; a send's own `subject` wins over it. */
  subject: string;
  /** The stored preview text, injected into the delivered HTML when it is set. */
  preheader: string;
  variables: TemplateVariable[];
  /**
   * The default sender, used by a send that names no `from`. `null` when the
   * template has none, and then every send naming it must give a `from`.
   */
  from: Address | null;
  /** The default reply-to address, used by a send that sets no reply-to. Empty when unset. */
  reply_to: string;
}

/** Cursor controls accepted by the template list operation, which takes no filters. */
export type ListTemplatesParams = PaginationParams;

/** Read the account's transactional templates. */
export interface TemplatesClient {
  /** Fetch one newest-first page of templates using mutually exclusive cursors. */
  list(
    params?: ListTemplatesParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Template>>;

  /** Iterate through every template, fetching cursor pages lazily. */
  iterate(
    params?: ListTemplatesParams,
    options?: RequestOptions,
  ): AsyncGenerator<Template, void, undefined>;

  /** Retrieve one template by UUID, including the variables a send must supply. */
  get(templateId: string, options?: RequestOptions): AhaSendPromise<Template>;
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

  get(templateId: string, options: RequestOptions = {}): AhaSendPromise<Template> {
    return this.#operations.execute(
      "getTemplate",
      {
        path: { account_id: this.#accountId, template_id: templateId },
      },
      forwardOptions(options),
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
