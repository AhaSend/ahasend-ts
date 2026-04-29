export type UUID = string;
export type ISODateTime = string;

export interface PaginationParams {
  limit?: number;
  after?: string;
  before?: string;
}

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

export interface Address {
  email: string;
  name?: string;
}
