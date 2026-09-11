import type {
  AhaSendPromise,
  IdempotencyRequestOptions,
  ISODateTime,
  PaginatedResponse,
  PaginationParams,
  RequestOptions,
  SuccessResponse,
} from "../types/common.js";

/** A recursively nested JSON value returned from a legacy contact attribute. */
export type ContactJSONValue =
  | null
  | boolean
  | number
  | string
  | ContactJSONValue[]
  | { [key: string]: ContactJSONValue };

/** An account-global contact and its subscription, validation, and attribute state. */
export interface Contact {
  object: "contact";
  id: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
  email: string;
  first_name: string;
  last_name: string;
  status: "enabled" | "disabled" | "blocked";
  status_reason: string;
  unsubscribed: boolean;
  unsubscribed_at: ISODateTime | null;
  attributes: Record<string, ContactJSONValue>;
  validation_status: "unvalidated" | "valid" | "invalid" | "risky" | "unknown";
  last_validated_at: ISODateTime | null;
}

/** Fields accepted when creating one contact. Attribute members cannot be null. */
export interface CreateContactRequest {
  email: string;
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  status?: "enabled" | "disabled" | "blocked" | null | undefined;
  status_reason?: string | null | undefined;
  unsubscribed?: boolean | null | undefined;
  attributes?: Record<string, string | number | boolean> | null | undefined;
}

/** Partial contact changes. A null attribute member removes the stored attribute. */
export interface UpdateContactRequest {
  email?: string | null | undefined;
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  status?: "enabled" | "disabled" | "blocked" | null | undefined;
  status_reason?: string | null | undefined;
  unsubscribed?: boolean | null | undefined;
  attributes?: Record<string, string | number | boolean | null> | null | undefined;
}

/** One ordered create-or-update input in a synchronous contact batch. */
export interface BatchUpsertContactInput extends UpdateContactRequest {
  email: string;
}

/** A synchronous batch of one through 1,000 contact upserts. */
export interface BatchUpsertContactsRequest {
  data: ReadonlyArray<BatchUpsertContactInput>;
}

/** One position-preserving result from a contact batch upsert. */
export interface BatchContactResult {
  position: number;
  email: string;
  outcome: "created" | "updated" | "failed";
  contact?: Contact;
  reason?: string;
}

/** Counts and ordered outcomes returned from a synchronous contact batch upsert. */
export interface BatchUpsertContactsResponse {
  object: "list";
  created: number;
  updated: number;
  failed: number;
  data: BatchContactResult[];
}

/** Filters and cursor controls accepted by the contact list operation. */
export type ListContactsParams = PaginationParams & {
  email?: string | undefined;
  status?: "enabled" | "disabled" | "blocked" | undefined;
  subscribed?: boolean | undefined;
  from_time?: ISODateTime | undefined;
  to_time?: ISODateTime | undefined;
};

/**
 * Type contract for account-global contact management.
 *
 * The runtime `client.contacts` facade is delivered separately; this interface
 * pins its generated request and response contract without adding transport.
 */
export interface ContactsClient {
  /** Fetch one newest-first page of contacts using mutually exclusive cursors. */
  list(
    params?: ListContactsParams,
    options?: RequestOptions,
  ): AhaSendPromise<PaginatedResponse<Contact>>;

  /** Iterate through every matching contact, fetching cursor pages lazily. */
  iterate(
    params?: ListContactsParams,
    options?: RequestOptions,
  ): AsyncGenerator<Contact, void, undefined>;

  /** Retrieve one contact by UUID or raw email; the SDK encodes the path segment once. */
  get(idOrEmail: string, options?: RequestOptions): AhaSendPromise<Contact>;

  /** Create an account-global contact without list membership. */
  create(body: CreateContactRequest, options?: IdempotencyRequestOptions): AhaSendPromise<Contact>;

  /** Partially update one contact by UUID or raw email. */
  update(
    idOrEmail: string,
    body: UpdateContactRequest,
    options?: RequestOptions,
  ): AhaSendPromise<Contact>;

  /** Permanently delete one contact and its contact history. */
  delete(idOrEmail: string, options?: RequestOptions): AhaSendPromise<SuccessResponse>;

  /** Synchronously create or update one through 1,000 contacts in input order. */
  batchUpsert(
    body: BatchUpsertContactsRequest,
    options?: IdempotencyRequestOptions,
  ): AhaSendPromise<BatchUpsertContactsResponse>;
}
