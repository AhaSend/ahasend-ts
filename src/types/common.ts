import type { RetryConfig } from "../retry.js";

export type UUID = string;
export type ISODateTime = string;
export type NonEmptyArray<T> = readonly [T, ...T[]];

export interface AhaSendResponse<T> {
  data: T;
  response: Response;
  requestId?: string;
  idempotentReplayed?: boolean;
}

export interface AhaSendPromise<T> extends Promise<T> {
  withResponse(): Promise<AhaSendResponse<T>>;
}

export type PaginationParams = Readonly<
  { limit?: number } & ({ after?: string; before?: never } | { after?: never; before?: string })
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

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
  /** Timeout for each network attempt, including response-body reading. */
  timeoutMs?: number;
  /** Restrict the client's retry policy for this call, or disable retries. */
  retry?: false | Partial<RetryConfig>;
}

export interface IdempotencyRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export interface Address {
  email: string;
  name?: string;
}
