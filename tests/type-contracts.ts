import type * as SDK from "../src/index.js";
import type { components } from "../src/generated/rest-types.js";

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
      ) => Promise<SDK.SendMessageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["sendConversation"],
      (
        body: SDK.CreateConversationMessageRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => Promise<SDK.SendMessageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["list"],
      (
        params?: SDK.ListMessagesParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.MessageSummary>>
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
      (messageId: string, options?: SDK.RequestOptions) => Promise<SDK.Message>
    >
  >,
  Expect<
    Equal<
      SDK.MessagesClient["cancel"],
      (messageId: string, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type DomainSignatures = [
  Expect<
    Equal<
      SDK.DomainsClient["list"],
      (
        params?: SDK.ListDomainsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.Domain>>
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
      ) => Promise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["get"],
      (domain: string, options?: SDK.RequestOptions) => Promise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["update"],
      (
        domain: string,
        body: SDK.UpdateDomainRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.Domain>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["delete"],
      (domain: string, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.DomainsClient["checkDns"],
      (domain: string, options?: SDK.RequestOptions) => Promise<SDK.Domain>
    >
  >,
];

type APIKeySignatures = [
  Expect<
    Equal<
      SDK.APIKeysClient["list"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.APIKey>>
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
      ) => Promise<SDK.CreatedAPIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["get"],
      (keyId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["update"],
      (
        keyId: SDK.UUID,
        body: SDK.UpdateAPIKeyRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.APIKeysClient["delete"],
      (keyId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type WebhookSignatures = [
  Expect<
    Equal<
      SDK.WebhooksClient["list"],
      (
        params?: SDK.ListWebhooksParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.Webhook>>
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
      ) => Promise<SDK.CreatedWebhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["get"],
      (webhookId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.Webhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["update"],
      (
        webhookId: SDK.UUID,
        body: SDK.UpdateWebhookRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.Webhook>
    >
  >,
  Expect<
    Equal<
      SDK.WebhooksClient["delete"],
      (webhookId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type StatisticsSignatures = [
  Expect<
    Equal<
      SDK.StatisticsClient["deliverability"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.DeliverabilityStatisticsResponse>
    >
  >,
  Expect<
    Equal<
      SDK.StatisticsClient["bounces"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.BounceStatisticsResponse>
    >
  >,
  Expect<
    Equal<
      SDK.StatisticsClient["deliveryTimes"],
      (
        params?: SDK.StatisticsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.DeliveryTimeStatisticsResponse>
    >
  >,
];

type SuppressionSignatures = [
  Expect<
    Equal<
      SDK.SuppressionsClient["list"],
      (
        params?: SDK.ListSuppressionsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.Suppression>>
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
      ) => Promise<SDK.CreateSuppressionResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["delete"],
      (
        params: SDK.DeleteSuppressionParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SuppressionsClient["wipe"],
      (
        params?: SDK.WipeSuppressionsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.SuccessResponse>
    >
  >,
];

type RouteSignatures = [
  Expect<
    Equal<
      SDK.RoutesClient["list"],
      (
        params?: SDK.ListRoutesParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.Route>>
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
      ) => Promise<SDK.CreatedRoute>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["get"],
      (routeId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.Route>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["update"],
      (
        routeId: SDK.UUID,
        body: SDK.UpdateRouteRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.Route>
    >
  >,
  Expect<
    Equal<
      SDK.RoutesClient["delete"],
      (routeId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type AccountSignatures = [
  Expect<Equal<SDK.AccountsClient["get"], (options?: SDK.RequestOptions) => Promise<SDK.Account>>>,
  Expect<
    Equal<
      SDK.AccountsClient["update"],
      (body: SDK.UpdateAccountRequest, options?: SDK.RequestOptions) => Promise<SDK.Account>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["listMembers"],
      (options?: SDK.RequestOptions) => Promise<SDK.ListAccountMembersResponse>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["addMember"],
      (
        body: SDK.AddAccountMemberRequest,
        options?: SDK.IdempotencyRequestOptions,
      ) => Promise<SDK.UserAccount>
    >
  >,
  Expect<
    Equal<
      SDK.AccountsClient["removeMember"],
      (userId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type SMTPCredentialSignatures = [
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["list"],
      (
        params?: SDK.PaginationParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.SMTPCredential>>
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
      ) => Promise<SDK.CreatedSMTPCredential>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["get"],
      (credentialId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SMTPCredential>
    >
  >,
  Expect<
    Equal<
      SDK.SMTPCredentialsClient["delete"],
      (credentialId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
];

type SubAccountSignatures = [
  Expect<
    Equal<
      SDK.SubAccountsClient["list"],
      (
        params?: SDK.ListSubAccountsParams,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.PaginatedResponse<SDK.SubAccount>>
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
      ) => Promise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["usage"],
      (options?: SDK.RequestOptions) => Promise<SDK.SubAccountUsageResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["get"],
      (subAccountId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["update"],
      (
        subAccountId: SDK.UUID,
        body: SDK.UpdateSubAccountRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["delete"],
      (subAccountId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SuccessResponse>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["suspend"],
      (
        subAccountId: SDK.UUID,
        body: SDK.SuspendSubAccountRequest,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.SubAccount>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountsClient["unsuspend"],
      (subAccountId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.SubAccount>
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
      ) => Promise<SDK.PaginatedResponse<SDK.APIKey>>
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
      ) => Promise<SDK.CreatedAPIKey>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["get"],
      (subAccountId: SDK.UUID, keyId: SDK.UUID, options?: SDK.RequestOptions) => Promise<SDK.APIKey>
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
      ) => Promise<SDK.APIKey>
    >
  >,
  Expect<
    Equal<
      SDK.SubAccountAPIKeysClient["delete"],
      (
        subAccountId: SDK.UUID,
        keyId: SDK.UUID,
        options?: SDK.RequestOptions,
      ) => Promise<SDK.SuccessResponse>
    >
  >,
];

type RefinementContracts = [
  Expect<Equal<SDK.CreateMessageRequest["recipients"], SDK.NonEmptyArray<SDK.Recipient>>>,
  Expect<Equal<SDK.CreateConversationMessageRequest["to"], SDK.NonEmptyArray<SDK.Address>>>,
  Expect<
    Equal<SDK.CreateConversationMessageRequest["cc"], SDK.NonEmptyArray<SDK.Address> | undefined>
  >,
  Expect<Equal<SDK.CreateMessageRequest["attachments"], readonly SDK.Attachment[] | undefined>>,
  Expect<Equal<SDK.CreateMessageRequest["tags"], readonly string[] | undefined>>,
  Expect<Equal<SDK.CreateAPIKeyRequest["scopes"], [string, ...string[]]>>,
  Expect<
    Equal<
      Extract<SDK.CreateWebhookRequest, { scope: "scoped" }>["domains"],
      SDK.NonEmptyArray<string>
    >
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
      SDK.NonEmptyArray<string>
    >
  >,
  Expect<
    Equal<
      Extract<SDK.CreateSMTPCredentialRequest, { scope: "global" }>["domains"],
      readonly string[] | null | undefined
    >
  >,
  Expect<Equal<readonly [] extends SDK.NonEmptyArray<unknown> ? true : false, false>>,
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
  StatisticsSignatures,
  SuppressionSignatures,
  RouteSignatures,
  AccountSignatures,
  SMTPCredentialSignatures,
  SubAccountSignatures,
  SubAccountAPIKeySignatures,
  RefinementContracts,
  DomainRequestOptions,
  APIKeyRequestOptions,
  ListMembersParams,
];
