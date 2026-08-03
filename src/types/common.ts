import type { RetryConfig } from "../retry.js";

export type UUID = string;
export type ISODateTime = string;

export interface AhaSendResponse<T> {
  data: T;
  response: Response;
  requestId?: string;
  idempotentReplayed?: boolean;
}

export interface AhaSendPromise<T> extends Promise<T> {
  withResponse(): Promise<AhaSendResponse<T>>;
}

/**
 * Cursor pagination inputs. `after` and `before` are mutually exclusive.
 *
 * The value-bearing members admit `undefined` so the documented loop — feeding
 * one page's `next_cursor` (`string | undefined`) into the next request —
 * compiles under `exactOptionalPropertyTypes`. The `never` members carry the
 * exclusivity and stay bare.
 */
export type PaginationParams = Readonly<
  { limit?: number | undefined } & (
    | { after?: string | undefined; before?: never }
    | { after?: never; before?: string | undefined }
  )
>;

export interface PaginationMeta {
  has_more: boolean;
  next_cursor?: string;
  previous_cursor?: string;
}

export interface PaginatedResponse<T> {
  object: "list";
  data: T[];
  pagination: PaginationMeta;
}

export interface SuccessResponse {
  message: string;
}

/** Controls applied to one API operation without changing the client defaults. */
export interface RequestOptions {
  signal?: AbortSignal | undefined;
  /** Additional request headers. SDK- and fetch-controlled headers are rejected. */
  headers?: Readonly<Record<string, string>> | undefined;
  /** Timeout for each network attempt, including response-body reading. */
  timeoutMs?: number | undefined;
  /** Restrict the client's retry policy for this call, or disable retries. */
  retry?: false | Partial<RetryConfig> | undefined;
}

export interface IdempotencyRequestOptions extends RequestOptions {
  idempotencyKey?: string | undefined;
}

export interface Address {
  email: string;
  name?: string | undefined;
}
