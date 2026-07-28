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
  next_cursor?: string | null;
  previous_cursor?: string | null;
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
  headers?: Record<string, string>;
}

export interface IdempotencyRequestOptions extends RequestOptions {
  idempotencyKey?: string;
}

export interface Address {
  email: string;
  name?: string;
}
