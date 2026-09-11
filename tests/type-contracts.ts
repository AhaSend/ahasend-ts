import type * as SDK from "../src/index.js";
import type { components } from "../src/generated/rest-types.js";
import type { OperationExecutor } from "../src/operations.js";
import type { paginate } from "../src/pagination.js";
import type * as WebhookSDK from "../src/webhooks/index.js";

// @ts-expect-error DomainRequestOptions was intentionally removed from the public API.
import type { DomainRequestOptions } from "../src/index.js";
// @ts-expect-error APIKeyRequestOptions was intentionally removed from the public API.
import type { APIKeyRequestOptions } from "../src/index.js";
// @ts-expect-error ListMembersParams was intentionally removed from the public API.
import type { ListMembersParams } from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type Extends<Actual, Expected> = [Actual] extends [Expected] ? true : false;
type Expect<Condition extends true> = Condition;
type WireSchemas = components["schemas"];

/**
 * Every OpenAPI schema has an intentional public declaration. Some wire names
 * differ from their consumer-facing equivalent, and paginated wire envelopes
 * share the SDK's generic PaginatedResponse declaration.
 */
interface PublicSchemaContracts {
  ErrorResponse: SDK.ApiErrorBody;
  SuccessResponse: SDK.SuccessResponse;
  PaginationInfo: SDK.PaginationMeta;
  APIKeyScope: SDK.APIKeyScope;
  APIKey: SDK.APIKey;
  CreateAPIKeyRequest: SDK.CreateAPIKeyRequest;
  UpdateAPIKeyRequest: SDK.UpdateAPIKeyRequest;
  PaginatedAPIKeysResponse: SDK.PaginatedResponse<SDK.APIKey>;
  DNSRecord: SDK.DNSRecord;
  Domain: SDK.Domain;
  CreateDomainRequest: SDK.CreateDomainRequest;
  UpdateDomainRequest: SDK.UpdateDomainRequest;
  PaginatedDomainsResponse: SDK.PaginatedResponse<SDK.Domain>;
  Address: SDK.Address;
  Recipient: SDK.Recipient;
  Attachment: SDK.Attachment;
  Tracking: SDK.Tracking;
  Retention: SDK.Retention;
  MessageSchedule: SDK.MessageSchedule;
  CreateMessageRequest: SDK.CreateMessageRequest;
  CreateConversationMessageRequest: SDK.CreateConversationMessageRequest;
  CreateSingleMessageResponse: SDK.SendMessageResult;
  CreateMessageResponse: SDK.SendMessageResponse;
  DeliveryEvent: SDK.DeliveryAttempt;
  MessageContentPart: SDK.MessageContentPart;
  MessageAttachment: SDK.MessageContentAttachment;
  MessageContentParsed: SDK.MessageContentParsed;
  MessageSummary: SDK.MessageSummary;
  Message: SDK.Message;
  PaginatedMessagesResponse: SDK.PaginatedResponse<SDK.MessageSummary>;
  Account: SDK.Account;
  SubAccount: SDK.SubAccount;
  CreateSubAccountRequest: SDK.CreateSubAccountRequest;
  UpdateSubAccountRequest: SDK.UpdateSubAccountRequest;
  SuspendSubAccountRequest: SDK.SuspendSubAccountRequest;
  SubAccountUsageBreakdown: SDK.SubAccountUsageBreakdown;
  SubAccountUsageResponse: SDK.SubAccountUsageResponse;
  PaginatedSubAccountsResponse: SDK.PaginatedResponse<SDK.SubAccount>;
  UpdateAccountRequest: SDK.UpdateAccountRequest;
  UserAccount: SDK.UserAccount;
  AccountMembersResponse: SDK.ListAccountMembersResponse;
  AddMemberRequest: SDK.AddAccountMemberRequest;
  JSONValue: SDK.ContactJSONValue;
  CreateContactRequest: SDK.CreateContactRequest;
  BatchUpsertContactInput: SDK.BatchUpsertContactInput;
  BatchUpsertContactsRequest: SDK.BatchUpsertContactsRequest;
  BatchContactResult: SDK.BatchContactResult;
  BatchUpsertContactsResponse: SDK.BatchUpsertContactsResponse;
  Contact: SDK.Contact;
  UpdateContactRequest: SDK.UpdateContactRequest;
  PaginatedContactsResponse: Awaited<ReturnType<SDK.ContactsClient["list"]>>;
  Suppression: SDK.Suppression;
  CreateSuppressionResponse: SDK.CreateSuppressionResponse;
  CreateSuppressionRequest: SDK.CreateSuppressionRequest;
  PaginatedSuppressionsResponse: SDK.PaginatedResponse<SDK.Suppression>;
  Route: SDK.Route;
  CreatedRoute: SDK.CreatedRoute;
  CreateRouteRequest: SDK.CreateRouteRequest;
  UpdateRouteRequest: SDK.UpdateRouteRequest;
  PaginatedRoutesResponse: SDK.PaginatedResponse<SDK.Route>;
  Webhook: SDK.Webhook;
  CreatedWebhook: SDK.CreatedWebhook;
  CreateWebhookRequest: SDK.CreateWebhookRequest;
  UpdateWebhookRequest: SDK.UpdateWebhookRequest;
  PaginatedWebhooksResponse: SDK.PaginatedResponse<SDK.Webhook>;
  SMTPCredential: SDK.SMTPCredential;
  CreatedSMTPCredential: SDK.CreatedSMTPCredential;
  CreateSMTPCredentialRequest: SDK.CreateSMTPCredentialRequest;
  PaginatedSMTPCredentialsResponse: SDK.PaginatedResponse<SDK.SMTPCredential>;
  DeliverabilityStatistics: SDK.DeliverabilityStatistics;
  DeliverabilityStatisticsResponse: SDK.DeliverabilityStatisticsResponse;
  Bounce: SDK.BounceClassificationCount;
  BounceStatistics: SDK.BounceStatistics;
  BounceStatisticsResponse: SDK.BounceStatisticsResponse;
  DeliveryTimeStatistics: SDK.DeliveryTimeStatistics;
  DeliveryTime: SDK.DeliveryTimeBreakdown;
  DeliveryTimeStatisticsResponse: SDK.DeliveryTimeStatisticsResponse;
}

type AllWireSchemasHavePublicContracts = Expect<
  Equal<keyof PublicSchemaContracts, keyof WireSchemas>
>;

/**
 * These request models deliberately accept readonly arrays so callers can pass
 * `as const` data without copying it. The generated wire models use mutable
 * arrays for these fields, but JSON serialization does not mutate them.
 */
interface ReadonlyPublicSchemaRefinements {
  CreateAPIKeyRequest: "ip_allow_list is readonly in the public request model";
  UpdateAPIKeyRequest: "ip_allow_list is readonly in the public request model";
  CreateMessageRequest: "attachments and tags are readonly in the public request model";
  CreateConversationMessageRequest: "attachments and tags are readonly in the public request model";
  CreateWebhookRequest: "global webhook domains are readonly in the public request model";
  UpdateWebhookRequest: "domains is readonly in the public request model";
  CreateSMTPCredentialRequest: "global credential domains are readonly in the public request model";
}

type ReadonlyArrays<Value> = Value extends readonly unknown[]
  ? number extends Value["length"]
    ? readonly ReadonlyArrays<Value[number]>[]
    : { readonly [Index in keyof Value]: ReadonlyArrays<Value[Index]> }
  : Value extends object
    ? { [Key in keyof Value]: ReadonlyArrays<Value[Key]> }
    : Value;

/**
 * The shared pagination envelope accepts both the optional cursors used by
 * PaginationInfo and the required nullable cursors used by contacts.
 */
type PaginationSchema = Extract<
  keyof PublicSchemaContracts,
  "PaginationInfo" | `Paginated${string}Response`
>;

type BidirectionalSchema = Exclude<
  keyof PublicSchemaContracts,
  keyof ReadonlyPublicSchemaRefinements | PaginationSchema
>;

type PublicSchemasAssignableToWire = Expect<
  Equal<
    {
      [Schema in BidirectionalSchema]: Extends<PublicSchemaContracts[Schema], WireSchemas[Schema]>;
    },
    { [Schema in BidirectionalSchema]: true }
  >
>;

type WireSchemasAssignableToPublic = Expect<
  Equal<
    {
      [Schema in keyof PublicSchemaContracts]: Extends<
        WireSchemas[Schema],
        PublicSchemaContracts[Schema]
      >;
    },
    { [Schema in keyof PublicSchemaContracts]: true }
  >
>;

type ContactPageFetcherAcceptedBySharedPaginator = Expect<
  Extends<
    (params: SDK.ListContactsParams) => ReturnType<SDK.ContactsClient["list"]>,
    Parameters<typeof paginate<SDK.Contact, SDK.ListContactsParams>>[0]
  >
>;

type RefinedPublicSchemasAssignableToWire = Expect<
  Equal<
    {
      [Schema in keyof ReadonlyPublicSchemaRefinements]: Extends<
        PublicSchemaContracts[Schema],
        ReadonlyArrays<WireSchemas[Schema]>
      >;
    },
    { [Schema in keyof ReadonlyPublicSchemaRefinements]: true }
  >
>;

type RefinedWireSchemasAssignableToPublic = Expect<
  Equal<
    {
      [Schema in keyof ReadonlyPublicSchemaRefinements]: Extends<
        WireSchemas[Schema],
        PublicSchemaContracts[Schema]
      >;
    },
    { [Schema in keyof ReadonlyPublicSchemaRefinements]: true }
  >
>;

type CommonSignatures = [
  Expect<Equal<SDK.UUID, string>>,
  Expect<Equal<SDK.ISODateTime, string>>,
  Expect<
    Equal<
      SDK.PaginationParams,
      Readonly<
        | { limit?: number; after?: string; before?: never }
        | { limit?: number; after?: never; before?: string }
      >
    >
  >,
  Expect<
    Equal<SDK.AhaSendPromise<string>["withResponse"], () => Promise<SDK.AhaSendResponse<string>>>
  >,
  Expect<Extends<SDK.AhaSendPromise<string>, Promise<string>>>,
];

type ClientSignatures = [
  Expect<
    Equal<ConstructorParameters<typeof SDK.AhaSendClient>, [options: SDK.AhaSendClientOptions]>
  >,
  Expect<
    Equal<
      SDK.AhaSendClient["ping"],
      (options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.PingResponse>
    >
  >,
  Expect<Equal<SDK.AhaSendClient["messages"], Readonly<SDK.MessagesClient>>>,
  Expect<Equal<SDK.AhaSendClient["domains"], Readonly<SDK.DomainsClient>>>,
  Expect<Equal<SDK.AhaSendClient["apiKeys"], Readonly<SDK.APIKeysClient>>>,
  Expect<Equal<SDK.AhaSendClient["webhooks"], Readonly<SDK.WebhooksClient>>>,
  Expect<Equal<SDK.AhaSendClient["statistics"], Readonly<SDK.StatisticsClient>>>,
  Expect<Equal<SDK.AhaSendClient["contacts"], Readonly<SDK.ContactsClient>>>,
  Expect<Equal<SDK.AhaSendClient["suppressions"], Readonly<SDK.SuppressionsClient>>>,
  Expect<Equal<SDK.AhaSendClient["routes"], Readonly<SDK.RoutesClient>>>,
  Expect<Equal<SDK.AhaSendClient["accounts"], Readonly<SDK.AccountsClient>>>,
  Expect<Equal<SDK.AhaSendClient["smtpCredentials"], Readonly<SDK.SMTPCredentialsClient>>>,
  Expect<Equal<SDK.AhaSendClient["subAccounts"], Readonly<SDK.SubAccountsClient>>>,
];

type MessageSignatures = [
  Expect<
    Equal<
      SDK.MessagesClient["send"],
      (
        body: SDK.CreateMessageRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.SendMessageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["sendConversation"],
      (
        body: SDK.CreateConversationMessageRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.SendMessageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["list"],
      (
        params?: SDK.ListMessagesParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.MessageSummary>>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["iterate"],
      (
        params?: SDK.ListMessagesParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.MessageSummary, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["get"],
      (messageId: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Message>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["cancel"],
      (messageId: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const messageListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.MessageSummary>>;
declare const messageIteratorResult: AsyncGenerator<SDK.MessageSummary, void, undefined>;
declare const sendMessageResult: SDK.AhaSendPromise<SDK.SendMessageResponse>;
declare const messageResult: SDK.AhaSendPromise<SDK.Message>;
declare const messageCancelResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralMessageMock: SDK.MessagesClient = {
  send: () => sendMessageResult,
  sendConversation: () => sendMessageResult,
  list: () => messageListResult,
  iterate: () => messageIteratorResult,
  get: () => messageResult,
  cancel: () => messageCancelResult,
};

type DomainSignatures = [
  Expect<
    Equal<
      SDK.DomainsClient["list"],
      (
        params?: SDK.ListDomainsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Domain>>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["iterate"],
      (
        params?: SDK.ListDomainsParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.Domain, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["create"],
      (
        body: SDK.CreateDomainRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["get"],
      (domain: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["update"],
      (
        domain: string,
        body: SDK.UpdateDomainRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["delete"],
      (domain: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["checkDns"],
      (domain: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Domain>
    >
  >,
];

declare const domainListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Domain>>;
declare const domainIteratorResult: AsyncGenerator<SDK.Domain, void, undefined>;
declare const domainResult: SDK.AhaSendPromise<SDK.Domain>;
declare const domainDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralDomainMock: SDK.DomainsClient = {
  list: () => domainListResult,
  iterate: () => domainIteratorResult,
  create: () => domainResult,
  get: () => domainResult,
  update: () => domainResult,
  delete: () => domainDeleteResult,
  checkDns: () => domainResult,
};

const createDomainWithDefaultSelector: SDK.CreateDomainRequest = {
  domain: "example.com",
  dkim_selector: null,
};
const createDomainWithCustomSelector: SDK.CreateDomainRequest = {
  domain: "example.net",
  dkim_selector: "selector-1",
};
const updateDomainWithoutSelectorChange: SDK.UpdateDomainRequest = { dkim_selector: null };
const updateDomainClearingSelector: SDK.UpdateDomainRequest = { dkim_selector: "" };
const updateDomainClearingWhitespaceSelector: SDK.UpdateDomainRequest = { dkim_selector: " \t " };

declare const domains: SDK.DomainsClient;
const createdDomainResponse: Promise<SDK.AhaSendResponse<SDK.Domain>> = domains
  .create(createDomainWithDefaultSelector)
  .withResponse();
domains.create(createDomainWithCustomSelector).withResponse();
domains.update("example.com", updateDomainWithoutSelectorChange).withResponse();
domains.update("example.com", updateDomainClearingSelector).withResponse();
const updatedDomainResponse: Promise<SDK.AhaSendResponse<SDK.Domain>> = domains
  .update("example.com", updateDomainClearingWhitespaceSelector)
  .withResponse();

type APIKeySignatures = [
  Expect<
    Equal<
      SDK.APIKeysClient["list"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.APIKey>>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["iterate"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.APIKey, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["create"],
      (
        body: SDK.CreateAPIKeyRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreatedAPIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["get"],
      (keyId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["update"],
      (
        keyId: SDK.UUID,
        body: SDK.UpdateAPIKeyRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["delete"],
      (keyId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const apiKeyListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.APIKey>>;
declare const apiKeyIteratorResult: AsyncGenerator<SDK.APIKey, void, undefined>;
declare const apiKeyResult: SDK.AhaSendPromise<SDK.APIKey>;
declare const createdAPIKeyResult: SDK.AhaSendPromise<SDK.CreatedAPIKey>;
declare const apiKeyDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralAPIKeyMock: SDK.APIKeysClient = {
  list: () => apiKeyListResult,
  iterate: () => apiKeyIteratorResult,
  create: () => createdAPIKeyResult,
  get: () => apiKeyResult,
  update: () => apiKeyResult,
  delete: () => apiKeyDeleteResult,
};

type WebhookSignatures = [
  Expect<
    Equal<
      SDK.WebhooksClient["list"],
      (
        params?: SDK.ListWebhooksParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Webhook>>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["iterate"],
      (
        params?: SDK.ListWebhooksParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.Webhook, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["create"],
      (
        body: SDK.CreateWebhookRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreatedWebhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["get"],
      (webhookId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Webhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["update"],
      (
        webhookId: SDK.UUID,
        body: SDK.UpdateWebhookRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.Webhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["delete"],
      (webhookId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const webhookListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Webhook>>;
declare const webhookIteratorResult: AsyncGenerator<SDK.Webhook, void, undefined>;
declare const createdWebhookResult: SDK.AhaSendPromise<SDK.CreatedWebhook>;
declare const webhookResult: SDK.AhaSendPromise<SDK.Webhook>;
declare const webhookDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralWebhookMock: SDK.WebhooksClient = {
  list: () => webhookListResult,
  iterate: () => webhookIteratorResult,
  create: () => createdWebhookResult,
  get: () => webhookResult,
  update: () => webhookResult,
  delete: () => webhookDeleteResult,
};

type WebhookHandlerSignatures = [
  Expect<Equal<Parameters<WebhookSDK.ExpressHandler>[0], WebhookSDK.AnyWebhookEvent>>,
  Expect<Equal<Parameters<WebhookSDK.FastifyHandler>[0], WebhookSDK.AnyWebhookEvent>>,
  Expect<Equal<Parameters<WebhookSDK.NextHandler>[0], WebhookSDK.AnyWebhookEvent>>,
];

type WebhookVerifierSignatures = [
  Expect<
    Equal<
      WebhookSDK.WebhookVerifier["verify"],
      (headers: WebhookSDK.WebhookHeadersInput, rawBody: WebhookSDK.WebhookRawBody) => Promise<void>
    >
  >,
  Expect<
    Equal<
      WebhookSDK.WebhookVerifier["parse"],
      (
        headers: WebhookSDK.WebhookHeadersInput,
        rawBody: WebhookSDK.WebhookRawBody,
      ) => Promise<WebhookSDK.AnyWebhookEvent>
    >
  >,
];

const expressHandler: WebhookSDK.ExpressHandler = (event, request, response) => {
  void [event, request, response];
};

const fastifyHandler: WebhookSDK.FastifyHandler = (event, request, reply) => {
  void [event, request, reply];
};

const nextHandler: WebhookSDK.NextHandler = (event, request) => {
  void [event, request];
  return new Response(null, { status: 204 });
};

type StatisticsSignatures = [
  Expect<
    Equal<
      SDK.StatisticsClient["deliverability"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.DeliverabilityStatisticsResponse>
    >
  >,
  Expect<
    Equal<
      SDK.StatisticsClient["bounces"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.BounceStatisticsResponse>
    >
  >,
  Expect<
    Equal<
      SDK.StatisticsClient["deliveryTimes"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.DeliveryTimeStatisticsResponse>
    >
  >,
];

declare const deliverabilityStatisticsResult: SDK.AhaSendPromise<SDK.DeliverabilityStatisticsResponse>;
declare const bounceStatisticsResult: SDK.AhaSendPromise<SDK.BounceStatisticsResponse>;
declare const deliveryTimeStatisticsResult: SDK.AhaSendPromise<SDK.DeliveryTimeStatisticsResponse>;

const structuralStatisticsMock: SDK.StatisticsClient = {
  deliverability: () => deliverabilityStatisticsResult,
  bounces: () => bounceStatisticsResult,
  deliveryTimes: () => deliveryTimeStatisticsResult,
};

type ContactSignatures = [
  Expect<
    Equal<
      SDK.ContactsClient["list"],
      (
        params?: SDK.ListContactsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Contact>>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["iterate"],
      (
        params?: SDK.ListContactsParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.Contact, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["get"],
      (idOrEmail: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Contact>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["create"],
      (
        body: SDK.CreateContactRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.Contact>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["update"],
      (
        idOrEmail: string,
        body: SDK.UpdateContactRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.Contact>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["delete"],
      (idOrEmail: string, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.ContactsClient["batchUpsert"],
      (
        body: SDK.BatchUpsertContactsRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.BatchUpsertContactsResponse>
    >
  >,
];

declare const contactListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Contact>>;
declare const contactIteratorResult: AsyncGenerator<SDK.Contact, void, undefined>;
declare const contactResult: SDK.AhaSendPromise<SDK.Contact>;
declare const contactDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;
declare const contactBatchResult: SDK.AhaSendPromise<SDK.BatchUpsertContactsResponse>;

const structuralContactMock: SDK.ContactsClient = {
  list: () => contactListResult,
  iterate: () => contactIteratorResult,
  get: () => contactResult,
  create: () => contactResult,
  update: () => contactResult,
  delete: () => contactDeleteResult,
  batchUpsert: () => contactBatchResult,
};

type SuppressionSignatures = [
  Expect<
    Equal<
      SDK.SuppressionsClient["list"],
      (
        params?: SDK.ListSuppressionsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Suppression>>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["iterate"],
      (
        params?: SDK.ListSuppressionsParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.Suppression, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["create"],
      (
        body: SDK.CreateSuppressionRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreateSuppressionResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["delete"],
      (
        params: SDK.DeleteSuppressionParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["wipe"],
      (
        params?: SDK.WipeSuppressionsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const suppressionListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Suppression>>;
declare const suppressionIteratorResult: AsyncGenerator<SDK.Suppression, void, undefined>;
declare const createSuppressionResult: SDK.AhaSendPromise<SDK.CreateSuppressionResponse>;
declare const suppressionDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralSuppressionMock: SDK.SuppressionsClient = {
  list: () => suppressionListResult,
  iterate: () => suppressionIteratorResult,
  create: () => createSuppressionResult,
  delete: () => suppressionDeleteResult,
  wipe: () => suppressionDeleteResult,
};

type RouteSignatures = [
  Expect<
    Equal<
      SDK.RoutesClient["list"],
      (
        params?: SDK.ListRoutesParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Route>>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["iterate"],
      (
        params?: SDK.ListRoutesParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.Route, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["create"],
      (
        body: SDK.CreateRouteRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreatedRoute>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["get"],
      (routeId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Route>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["update"],
      (
        routeId: SDK.UUID,
        body: SDK.UpdateRouteRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.Route>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["delete"],
      (routeId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const routeListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.Route>>;
declare const routeIteratorResult: AsyncGenerator<SDK.Route, void, undefined>;
declare const createdRouteResult: SDK.AhaSendPromise<SDK.CreatedRoute>;
declare const routeResult: SDK.AhaSendPromise<SDK.Route>;
declare const routeDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralRouteMock: SDK.RoutesClient = {
  list: () => routeListResult,
  iterate: () => routeIteratorResult,
  create: () => createdRouteResult,
  get: () => routeResult,
  update: () => routeResult,
  delete: () => routeDeleteResult,
};

type AccountSignatures = [
  Expect<
    Equal<
      SDK.AccountsClient["get"],
      (options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.Account>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["update"],
      (
        body: SDK.UpdateAccountRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.Account>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["listMembers"],
      (options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.ListAccountMembersResponse>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["addMember"],
      (
        body: SDK.AddAccountMemberRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.UserAccount>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["removeMember"],
      (userId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const accountResult: SDK.AhaSendPromise<SDK.Account>;
declare const accountMembersResult: SDK.AhaSendPromise<SDK.ListAccountMembersResponse>;
declare const accountMemberResult: SDK.AhaSendPromise<SDK.UserAccount>;
declare const successResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralAccountMock: SDK.AccountsClient = {
  get: () => accountResult,
  update: () => accountResult,
  listMembers: () => accountMembersResult,
  addMember: () => accountMemberResult,
  removeMember: () => successResult,
};

type SMTPCredentialSignatures = [
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["list"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.SMTPCredential>>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["iterate"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.SMTPCredential, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["create"],
      (
        body: SDK.CreateSMTPCredentialRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreatedSMTPCredential>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["get"],
      (
        credentialId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SMTPCredential>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["delete"],
      (
        credentialId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const smtpCredentialListResult: SDK.AhaSendPromise<
  SDK.PaginatedResponse<SDK.SMTPCredential>
>;
declare const smtpCredentialIteratorResult: AsyncGenerator<SDK.SMTPCredential, void, undefined>;
declare const createdSMTPCredentialResult: SDK.AhaSendPromise<SDK.CreatedSMTPCredential>;
declare const smtpCredentialResult: SDK.AhaSendPromise<SDK.SMTPCredential>;
declare const smtpCredentialDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralSMTPCredentialMock: SDK.SMTPCredentialsClient = {
  list: () => smtpCredentialListResult,
  iterate: () => smtpCredentialIteratorResult,
  create: () => createdSMTPCredentialResult,
  get: () => smtpCredentialResult,
  delete: () => smtpCredentialDeleteResult,
};

type SubAccountSignatures = [
  Expect<
    Equal<
      SDK.SubAccountsClient["list"],
      (
        params?: SDK.ListSubAccountsParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.SubAccount>>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["iterate"],
      (
        params?: SDK.ListSubAccountsParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.SubAccount, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["create"],
      (
        body: SDK.CreateSubAccountRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["usage"],
      (options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SubAccountUsageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["get"],
      (subAccountId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["update"],
      (
        subAccountId: SDK.UUID,
        body: SDK.UpdateSubAccountRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["delete"],
      (
        subAccountId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["suspend"],
      (
        subAccountId: SDK.UUID,
        body: SDK.SuspendSubAccountRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["unsuspend"],
      (subAccountId: SDK.UUID, options?: SDK.RequestOptions) => SDK.AhaSendPromise<SDK.SubAccount>
    >
  >,
  Expect<Equal<SDK.SubAccountsClient["apiKeys"], Readonly<SDK.SubAccountAPIKeysClient>>>,
];

type SubAccountAPIKeySignatures = [
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["list"],
      (
        subAccountId: SDK.UUID,
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.APIKey>>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["iterate"],
      (
        subAccountId: SDK.UUID,
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => AsyncGenerator<SDK.APIKey, void, undefined>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["create"],
      (
        subAccountId: SDK.UUID,
        body: SDK.CreateAPIKeyRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => SDK.AhaSendPromise<SDK.CreatedAPIKey>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["get"],
      (
        subAccountId: SDK.UUID,
        keyId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["update"],
      (
        subAccountId: SDK.UUID,
        keyId: SDK.UUID,
        body: SDK.UpdateAPIKeyRequest,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["delete"],
      (
        subAccountId: SDK.UUID,
        keyId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => SDK.AhaSendPromise<SDK.SuccessResponse>
    >
  >,
];

declare const subAccountListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.SubAccount>>;
declare const subAccountIteratorResult: AsyncGenerator<SDK.SubAccount, void, undefined>;
declare const subAccountResult: SDK.AhaSendPromise<SDK.SubAccount>;
declare const subAccountUsageResult: SDK.AhaSendPromise<SDK.SubAccountUsageResponse>;
declare const subAccountDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;
declare const subAccountAPIKeyListResult: SDK.AhaSendPromise<SDK.PaginatedResponse<SDK.APIKey>>;
declare const subAccountAPIKeyIteratorResult: AsyncGenerator<SDK.APIKey, void, undefined>;
declare const createdSubAccountAPIKeyResult: SDK.AhaSendPromise<SDK.CreatedAPIKey>;
declare const subAccountAPIKeyResult: SDK.AhaSendPromise<SDK.APIKey>;
declare const subAccountAPIKeyDeleteResult: SDK.AhaSendPromise<SDK.SuccessResponse>;

const structuralSubAccountAPIKeyMock: SDK.SubAccountAPIKeysClient = {
  list: () => subAccountAPIKeyListResult,
  iterate: () => subAccountAPIKeyIteratorResult,
  create: () => createdSubAccountAPIKeyResult,
  get: () => subAccountAPIKeyResult,
  update: () => subAccountAPIKeyResult,
  delete: () => subAccountAPIKeyDeleteResult,
};

const structuralSubAccountMock: SDK.SubAccountsClient = {
  list: () => subAccountListResult,
  iterate: () => subAccountIteratorResult,
  create: () => subAccountResult,
  usage: () => subAccountUsageResult,
  get: () => subAccountResult,
  update: () => subAccountResult,
  delete: () => subAccountDeleteResult,
  suspend: () => subAccountResult,
  unsuspend: () => subAccountResult,
  apiKeys: structuralSubAccountAPIKeyMock,
};

type ClientResourceSurface = Pick<
  SDK.AhaSendClient,
  | "messages"
  | "domains"
  | "apiKeys"
  | "webhooks"
  | "statistics"
  | "contacts"
  | "suppressions"
  | "routes"
  | "accounts"
  | "smtpCredentials"
  | "subAccounts"
>;

const structuralClientMock: ClientResourceSurface = {
  messages: structuralMessageMock,
  domains: structuralDomainMock,
  apiKeys: structuralAPIKeyMock,
  webhooks: structuralWebhookMock,
  statistics: structuralStatisticsMock,
  contacts: structuralContactMock,
  suppressions: structuralSuppressionMock,
  routes: structuralRouteMock,
  accounts: structuralAccountMock,
  smtpCredentials: structuralSMTPCredentialMock,
  subAccounts: structuralSubAccountMock,
};

type RefinementContracts = [
  Expect<Equal<SDK.CreateMessageRequest["recipients"], readonly SDK.Recipient[]>>,
  Expect<Equal<SDK.CreateConversationMessageRequest["to"], readonly SDK.Address[]>>,
  Expect<Equal<SDK.CreateConversationMessageRequest["cc"], readonly SDK.Address[] | undefined>>,
  Expect<Equal<SDK.CreateMessageRequest["attachments"], readonly SDK.Attachment[] | undefined>>,
  Expect<Equal<SDK.CreateMessageRequest["tags"], readonly string[] | undefined>>,
  Expect<Equal<SDK.CreateAPIKeyRequest["scopes"], readonly string[]>>,
  Expect<Equal<{} extends SDK.UpdateAPIKeyRequest ? true : false, false>>,
  Expect<
    Equal<
      {
        label: null;
        scopes: null;
        ip_allow_list: null;
      } extends SDK.UpdateAPIKeyRequest
        ? true
        : false,
      false
    >
  >,
  Expect<Extends<{ label: string }, SDK.UpdateAPIKeyRequest>>,
  Expect<Extends<{ scopes: readonly string[] }, SDK.UpdateAPIKeyRequest>>,
  Expect<Extends<{ ip_allow_list: readonly string[] }, SDK.UpdateAPIKeyRequest>>,
  Expect<
    Equal<Extract<SDK.CreateWebhookRequest, { scope: "scoped" }>["domains"], readonly string[]>
  >,
  Expect<
    Equal<
      Extract<SDK.CreateWebhookRequest, { scope: "global" }>["domains"],
      readonly string[] | null | undefined
    >
  >,
  Expect<
    Equal<
      Extract<SDK.CreateSMTPCredentialRequest, { scope: "scoped" }>["domains"],
      readonly string[]
    >
  >,
  Expect<
    Equal<
      Extract<SDK.CreateSMTPCredentialRequest, { scope: "global" }>["domains"],
      readonly string[] | null | undefined
    >
  >,
  Expect<Equal<{} extends SDK.UpdateSubAccountRequest ? true : false, false>>,
  Expect<Equal<{ name: null } extends SDK.UpdateSubAccountRequest ? true : false, false>>,
  Expect<Extends<{ name: string }, SDK.UpdateSubAccountRequest>>,
  Expect<
    Equal<
      SDK.SubAccountUsageResponse["allocation_method"],
      WireSchemas["SubAccountUsageResponse"]["allocation_method"]
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountUsageResponse["parent"],
      SDK.SubAccountUsageBreakdown & { account_id: SDK.UUID }
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountUsageResponse["sub_accounts"],
      Array<SDK.SubAccountUsageBreakdown & { account_id: SDK.UUID; name: string }>
    >
  >,
  Expect<Equal<Awaited<ReturnType<SDK.APIKeysClient["create"]>>, SDK.CreatedAPIKey>>,
  Expect<Equal<Awaited<ReturnType<SDK.SubAccountAPIKeysClient["create"]>>, SDK.CreatedAPIKey>>,
  Expect<Equal<Awaited<ReturnType<SDK.RoutesClient["create"]>>, SDK.CreatedRoute>>,
  Expect<Equal<Awaited<ReturnType<SDK.WebhooksClient["create"]>>, SDK.CreatedWebhook>>,
  Expect<
    Equal<Awaited<ReturnType<SDK.SMTPCredentialsClient["create"]>>, SDK.CreatedSMTPCredential>
  >,
  Expect<Equal<"secret_key" extends keyof SDK.APIKey ? true : false, false>>,
  Expect<Equal<"secret" extends keyof SDK.Route ? true : false, false>>,
  Expect<Equal<"secret" extends keyof SDK.Webhook ? true : false, false>>,
  Expect<Equal<"password" extends keyof SDK.SMTPCredential ? true : false, false>>,
];

declare const operations: OperationExecutor;

const readonlyAttachments: readonly SDK.Attachment[] = [
  { data: "hello", content_type: "text/plain", file_name: "hello.txt" },
];
const readonlyTags: readonly string[] = ["transactional"];
const readonlyRecipients: readonly SDK.Recipient[] = [{ email: "recipient@example.com" }];
const readonlyAddresses: readonly SDK.Address[] = [{ email: "recipient@example.com" }];
const messageBody: SDK.CreateMessageRequest = {
  from: { email: "sender@example.com" },
  recipients: readonlyRecipients,
  subject: "Readonly message",
  attachments: readonlyAttachments,
  tags: readonlyTags,
};
const conversationBody: SDK.CreateConversationMessageRequest = {
  from: { email: "sender@example.com" },
  to: readonlyAddresses,
  subject: "Readonly conversation",
  attachments: readonlyAttachments,
  tags: readonlyTags,
};
const readonlyWebhookDomains: readonly string[] = ["example.com"];
const createWebhookBody: SDK.CreateWebhookRequest = {
  name: "Readonly webhook",
  url: "https://hooks.example.com/ahasend",
  scope: "scoped",
  domains: readonlyWebhookDomains,
};
const updateWebhookDomains: readonly string[] = ["example.com", "example.net"];
const updateWebhookBody: SDK.UpdateWebhookRequest = { domains: updateWebhookDomains };
const readonlySMTPDomains: readonly string[] = ["example.com"];
const smtpBody: SDK.CreateSMTPCredentialRequest = {
  name: "Readonly SMTP credential",
  scope: "scoped",
  domains: readonlySMTPDomains,
};
const createAPIKeyBody: SDK.CreateAPIKeyRequest = {
  label: "Readonly API key",
  scopes: ["messages:send:all"],
  ip_allow_list: ["203.0.113.0/24"],
};
const updateAPIKeyBody: SDK.UpdateAPIKeyRequest = { ip_allow_list: [] };

const pingExecution: SDK.AhaSendPromise<SDK.SuccessResponse> = operations.execute("ping", {});
const messageExecution: SDK.AhaSendPromise<SDK.SendMessageResponse> = operations.execute(
  "createMessage",
  { path: { account_id: "22222222-2222-4222-8222-222222222222" }, body: messageBody },
);
operations.execute("createConversationMessage", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  body: conversationBody,
});
operations.execute("createWebhook", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  body: createWebhookBody,
});
operations.execute("updateWebhook", {
  path: { account_id: "22222222-2222-4222-8222-222222222222", webhook_id: "webhook-id" },
  body: updateWebhookBody,
});
operations.execute("createSMTPCredential", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  body: smtpBody,
});
operations.execute("createAPIKey", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  body: createAPIKeyBody,
});
operations.execute("updateAPIKey", {
  path: { account_id: "22222222-2222-4222-8222-222222222222", key_id: "key-id" },
  body: updateAPIKeyBody,
});

// @ts-expect-error Body-bearing operations require their generated request body.
operations.execute("createMessage", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
});
operations.execute("ping", {
  // @ts-expect-error Bodyless operations do not accept a request body.
  body: {},
});
operations.execute("createWebhook", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  // Scoped domains are typed as a plain array so runtime-built lists assign;
  // emptiness is rejected by assertNonEmptyArray at the resource boundary.
  body: {
    name: "Invalid empty scoped webhook",
    url: "https://hooks.example.com/ahasend",
    scope: "scoped",
    domains: [],
  },
});
operations.execute("createSMTPCredential", {
  path: { account_id: "22222222-2222-4222-8222-222222222222" },
  // Emptiness is rejected at runtime; see assertNonEmptyArray.
  body: {
    name: "Invalid empty scoped SMTP credential",
    scope: "scoped",
    domains: [],
  },
});

declare const client: SDK.AhaSendClient;
declare const dualCursor: { readonly limit: 10; readonly after: "next"; readonly before: "prev" };

// Every paginated list and iterator accepts limit with either cursor direction.
client.messages.list({ limit: 10, after: "next", status: "queued" });
client.messages.list({ limit: 10, before: "prev", sender: "sender@example.com" });
client.messages.iterate({ limit: 10, after: "next", recipient: "to@example.com" });
client.messages.iterate({ limit: 10, before: "prev", tags: "transactional" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.messages.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.messages.iterate(dualCursor);

client.domains.list({ limit: 10, after: "next", dns_valid: true });
client.domains.list({ limit: 10, before: "prev", dns_valid: false });
client.domains.iterate({ limit: 10, after: "next", dns_valid: true });
client.domains.iterate({ limit: 10, before: "prev", dns_valid: false });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.domains.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.domains.iterate(dualCursor);

client.apiKeys.list({ limit: 10, after: "next" });
client.apiKeys.list({ limit: 10, before: "prev" });
client.apiKeys.iterate({ limit: 10, after: "next" });
client.apiKeys.iterate({ limit: 10, before: "prev" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.apiKeys.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.apiKeys.iterate(dualCursor);

client.webhooks.list({ limit: 10, after: "next", enabled: true });
client.webhooks.list({ limit: 10, before: "prev", on_delivered: true });
client.webhooks.iterate({ limit: 10, after: "next", on_bounced: true });
client.webhooks.iterate({ limit: 10, before: "prev", on_clicked: true });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.webhooks.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.webhooks.iterate(dualCursor);

client.suppressions.list({ limit: 10, after: "next", domain: "example.com" });
client.suppressions.list({ limit: 10, before: "prev", email: "blocked@example.com" });
client.suppressions.iterate({ limit: 10, after: "next", from_time: "2026-01-01T00:00:00Z" });
client.suppressions.iterate({ limit: 10, before: "prev", to_time: "2026-02-01T00:00:00Z" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.suppressions.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.suppressions.iterate(dualCursor);

client.routes.list({ limit: 10, after: "next", domain: "example.com" });
client.routes.list({ limit: 10, before: "prev", domain: "example.net" });
client.routes.iterate({ limit: 10, after: "next", domain: "example.com" });
client.routes.iterate({ limit: 10, before: "prev", domain: "example.net" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.routes.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.routes.iterate(dualCursor);

client.smtpCredentials.list({ limit: 10, after: "next" });
client.smtpCredentials.list({ limit: 10, before: "prev" });
client.smtpCredentials.iterate({ limit: 10, after: "next" });
client.smtpCredentials.iterate({ limit: 10, before: "prev" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.smtpCredentials.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.smtpCredentials.iterate(dualCursor);

client.subAccounts.list({ limit: 10, after: "next" });
client.subAccounts.list({ limit: 10, before: "prev" });
client.subAccounts.iterate({ limit: 10, after: "next" });
client.subAccounts.iterate({ limit: 10, before: "prev" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.subAccounts.list(dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.subAccounts.iterate(dualCursor);

client.subAccounts.apiKeys.list("sub_account", { limit: 10, after: "next" });
client.subAccounts.apiKeys.list("sub_account", { limit: 10, before: "prev" });
client.subAccounts.apiKeys.iterate("sub_account", { limit: 10, after: "next" });
client.subAccounts.apiKeys.iterate("sub_account", { limit: 10, before: "prev" });
// @ts-expect-error Pagination cursors are mutually exclusive.
client.subAccounts.apiKeys.list("sub_account", dualCursor);
// @ts-expect-error Pagination cursors are mutually exclusive.
client.subAccounts.apiKeys.iterate("sub_account", dualCursor);

// Keep compile-only contracts referenced under noUnusedLocals configurations.
export type DeclarationContracts = [
  AllWireSchemasHavePublicContracts,
  CommonSignatures,
  ClientSignatures,
  MessageSignatures,
  DomainSignatures,
  APIKeySignatures,
  WebhookSignatures,
  WebhookHandlerSignatures,
  StatisticsSignatures,
  ContactSignatures,
  SuppressionSignatures,
  RouteSignatures,
  AccountSignatures,
  SMTPCredentialSignatures,
  SubAccountSignatures,
  SubAccountAPIKeySignatures,
  RefinementContracts,
  typeof structuralMessageMock,
  typeof structuralAPIKeyMock,
  typeof structuralWebhookMock,
  typeof structuralRouteMock,
  typeof structuralAccountMock,
  typeof structuralStatisticsMock,
  typeof structuralContactMock,
  typeof structuralSubAccountMock,
  typeof structuralSubAccountAPIKeyMock,
  typeof structuralClientMock,
  typeof expressHandler,
  typeof fastifyHandler,
  typeof nextHandler,
  typeof pingExecution,
  typeof messageExecution,
  DomainRequestOptions,
  APIKeyRequestOptions,
  ListMembersParams,
];

// Optional members admit `undefined` explicitly. JSON has no `undefined`, so
// "absent" and "present but undefined" are the same value on the wire — but
// under `exactOptionalPropertyTypes` (which this SDK and a growing number of
// consumers enable) a bare `?: T` rejects the ordinary case of forwarding a
// value that is already `T | undefined`. These pin the ergonomics so the
// generator cannot silently drop the suffix again.
declare const partialTemplate: { html: string | undefined; text: string | undefined };
declare const optionalCursor: string | undefined;

const optionalRequestFields: SDK.CreateMessageRequest = {
  from: { email: "sender@example.com" },
  recipients: [{ email: "recipient@example.com" }],
  subject: "Optional content forwarded straight through",
  html_content: partialTemplate.html,
  text_content: partialTemplate.text,
};

// The manual cursor loop exactly as the docs present it.
const documentedCursorPage: SDK.ListDomainsParams = { limit: 100, after: optionalCursor };
const documentedBackwardPage: SDK.ListMessagesParams = { limit: 100, before: optionalCursor };

// Real assignability checks, not `undefined extends T[K]` — indexed access on
// an optional property always includes `undefined`, so that form is a tautology
// and passes with or without the explicit suffix. Assigning a literal whose
// property IS `undefined` is what `exactOptionalPropertyTypes` actually governs.
const explicitlyUndefinedBody: SDK.CreateMessageRequest = {
  from: { email: "sender@example.com" },
  recipients: [{ email: "recipient@example.com" }],
  subject: "Explicit undefined optionals",
  html_content: undefined,
  text_content: undefined,
  attachments: undefined,
};

const explicitlyUndefinedOptions: SDK.ClientOptions = {
  apiKey: "aha-sk-test",
  baseUrl: undefined,
  timeoutMs: undefined,
  userAgent: undefined,
};

const explicitlyUndefinedRetry: SDK.RetryConfig = {
  maxRetries: undefined,
  baseDelayMs: undefined,
};

const explicitlyUndefinedListParams: SDK.ListMessagesParams = {
  limit: undefined,
  after: undefined,
  status: undefined,
};

type OptionalUndefinedContracts = [
  // Cursor exclusivity survives the widening.
  Expect<Equal<{ after: "a"; before: "b" } extends SDK.PaginationParams ? true : false, false>>,
  // Response types stay bare: widening them would break assigning an SDK
  // response into a consumer's own interface, `"k" in obj` narrowing, and
  // `Required<T>`.
  Expect<
    Equal<
      { has_more: true; next_cursor: undefined } extends SDK.PaginationMeta ? true : false,
      false
    >
  >,
];

export type TypeSurfaceContracts = [
  ContactPageFetcherAcceptedBySharedPaginator,
  OptionalUndefinedContracts,
  typeof explicitlyUndefinedBody,
  typeof explicitlyUndefinedOptions,
  typeof explicitlyUndefinedRetry,
  typeof explicitlyUndefinedListParams,
  typeof optionalRequestFields,
  typeof documentedCursorPage,
  typeof documentedBackwardPage,
];
