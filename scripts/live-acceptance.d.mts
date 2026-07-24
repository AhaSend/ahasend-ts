/// <reference types="node" />

export const EXPECTED_LIVE_OPERATION_COUNT: 56;
export const EXPECTED_LIVE_ITERATOR_COUNT: 9;

export interface LiveMapping {
  readonly operationId: string;
  readonly facade: string;
  readonly method: string;
}

export interface LiveProfile {
  readonly version: 1;
  readonly operations: readonly LiveMapping[];
  readonly iterators: readonly LiveMapping[];
  readonly profileSha256: string;
}

export interface LiveCandidateManifest {
  readonly version: 1;
  readonly commit: string;
  readonly sourceReportSha256: string;
  readonly contractSha256: Readonly<Record<string, string>>;
  readonly captureSha256: string;
  readonly keysSha256: Readonly<Record<string, string>>;
  readonly rendererReportSha256: string;
  readonly profileSha256: string;
  readonly tarballSha256: string;
}

export interface LiveCandidate {
  readonly manifest: LiveCandidateManifest;
  readonly manifestSha256: string;
  readonly tarballSha256: string;
  readonly package: { readonly name: "@ahasend/sdk"; readonly version: string };
  readonly profile: LiveProfile;
  readonly registry: ScenarioRegistry;
}

export interface ValidatePackagedLiveProfileOptions {
  readonly profileSource: string | Uint8Array;
  readonly profileSidecar: string | Uint8Array;
  readonly expectedProfileSha256: string;
}

export function validatePackagedLiveProfile(
  options: ValidatePackagedLiveProfileOptions,
): LiveProfile;

export interface InspectLiveCandidateOptions {
  readonly manifestSource: string | Uint8Array;
  readonly manifestSidecar: string | Uint8Array;
  readonly tarballSource: string | Uint8Array;
  readonly profileSource: string | Uint8Array;
  readonly profileSidecar: string | Uint8Array;
  readonly packageManifestSource: string | Uint8Array;
}

export function inspectLiveCandidate(options: InspectLiveCandidateOptions): LiveCandidate;

export type ArchiveExtractor = (
  tarballPath: string,
  archivePath: string,
  tarballSource: Uint8Array,
) => string | Uint8Array;

export interface LoadLiveCandidateOptions {
  readonly manifestPath: string;
  readonly manifestSidecarPath?: string;
  readonly tarballPath: string;
  readonly extractArchiveFile?: ArchiveExtractor;
}

export interface LoadedLiveCandidate extends LiveCandidate {
  readonly tarballPath: string;
  readonly tarballSource: Buffer;
  readonly profileSource: Buffer;
  readonly profileSidecar: Buffer;
}

export function loadLiveCandidate(options: LoadLiveCandidateOptions): Promise<LoadedLiveCandidate>;

export interface LiveCommandOptions {
  readonly cwd: string;
}

export type LiveCommandRunner = (
  command: string,
  args: readonly string[],
  options: LiveCommandOptions,
) => void;

export interface InstallLiveCandidateOptions extends LoadLiveCandidateOptions {
  readonly installDirectory: string;
  readonly runCommand?: LiveCommandRunner;
}

export interface InstalledLiveCandidate extends LoadedLiveCandidate {
  readonly installDirectory: string;
  readonly installedRoot: string;
}

export function installLiveCandidate(
  options: InstallLiveCandidateOptions,
): Promise<InstalledLiveCandidate>;

export interface ScenarioData {
  readonly operationId: string;
  readonly [key: string]: unknown;
}

export interface RegisteredScenario extends ScenarioData, LiveMapping {
  readonly iterator: LiveMapping | null;
}

export interface IteratorSubcase extends LiveMapping {
  readonly primary: RegisteredScenario;
}

export interface ScenarioRegistry {
  readonly primary: ReadonlyMap<string, RegisteredScenario>;
  readonly iterators: readonly IteratorSubcase[];
}

export function createScenarioRegistry(
  profile: LiveProfile,
  scenarioData?: readonly ScenarioData[],
): ScenarioRegistry;

export interface DomainLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly update: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
  readonly checkDns: (...args: never[]) => unknown;
}

export interface DomainLiveClient {
  readonly domains: DomainLiveFacade;
}

export interface DomainLiveCreateRequest {
  readonly domain: string;
  readonly dkim_private_key?: string;
  readonly tracking_subdomain?: string;
  readonly return_path_subdomain?: string;
  readonly subscription_subdomain?: string;
  readonly media_subdomain?: string;
  readonly dkim_rotation_interval_days?: number;
}

export interface DomainLiveUpdateRequest {
  readonly tracking_subdomain?: string;
  readonly return_path_subdomain?: string;
  readonly subscription_subdomain?: string;
  readonly media_subdomain?: string;
  readonly dkim_rotation_interval_days?: number;
}

export type DomainLivePagination =
  | { readonly limit: number; readonly after?: string; readonly before?: never }
  | { readonly limit: number; readonly before: string; readonly after?: never };

export interface CreateDomainScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: DomainLiveClient;
  readonly createRequest: DomainLiveCreateRequest;
  readonly updateRequest?: DomainLiveUpdateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createDomainScenarioRegistry(
  options: CreateDomainScenarioRegistryOptions,
): ScenarioRegistry;

export interface DomainLiveFailure {
  readonly phase: "operation" | "cleanup";
  readonly operationId?: string;
}

export interface DomainLiveRun {
  readonly operationResults: readonly LiveResult[];
  readonly iteratorResults: readonly LiveResult[];
  readonly cleanupResults: readonly CleanupResult[];
  readonly failure: DomainLiveFailure | null;
}

export function runDomainLiveScenarios(registry: ScenarioRegistry): Promise<DomainLiveRun>;

export interface MessageLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly send: (...args: never[]) => unknown;
  readonly sendConversation: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly cancel: (...args: never[]) => unknown;
}

export interface MessageDomainLiveFacade {
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
}

export interface MessageLiveClient {
  readonly ping: (...args: never[]) => unknown;
  readonly messages: MessageLiveFacade;
  readonly domains: MessageDomainLiveFacade;
}

export interface SandboxSender {
  readonly email: string;
  readonly name?: string;
}

export interface MessageLiveSandboxRequest {
  readonly from: SandboxSender;
  readonly sandbox: true;
  readonly [key: string]: unknown;
}

export interface MessageLiveVerifiedRequest extends MessageLiveSandboxRequest {
  readonly schedule: {
    readonly first_attempt: string;
    readonly expires?: string;
  };
}

export interface CreateMessageScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: MessageLiveClient;
  readonly verifiedRequest: MessageLiveVerifiedRequest;
  readonly conversationRequest: MessageLiveSandboxRequest;
  readonly neverRegisteredDomain: string;
  readonly dnslessCreateRequest: DomainLiveCreateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createMessageScenarioRegistry(
  options: CreateMessageScenarioRegistryOptions,
): ScenarioRegistry;

export type MessageLiveRun = DomainLiveRun;

export function runMessageLiveScenarios(registry: ScenarioRegistry): Promise<MessageLiveRun>;

export interface StatisticsLiveFacade {
  readonly deliverability: (...args: never[]) => unknown;
  readonly bounces: (...args: never[]) => unknown;
  readonly deliveryTimes: (...args: never[]) => unknown;
}

export interface StatisticsLiveClient {
  readonly statistics: StatisticsLiveFacade;
}

export interface StatisticsAuthorizationRule {
  readonly kind: "comma_separated_query_domains";
  readonly queryParameter: "sender_domain";
  readonly quantifier: "every";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface StatisticsAuthorizationRegistry {
  readonly getDeliverabilityStatistics: StatisticsAuthorizationRule;
  readonly getBounceStatistics: StatisticsAuthorizationRule;
  readonly getDeliveryTimeStatistics: StatisticsAuthorizationRule;
  readonly [operationId: string]: unknown;
}

export interface CreateStatisticsScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: StatisticsLiveClient;
  readonly authorization: StatisticsAuthorizationRegistry;
  readonly senderDomains: {
    readonly authorized: string;
    readonly unauthorized: string;
  };
}

export function createStatisticsScenarioRegistry(
  options: CreateStatisticsScenarioRegistryOptions,
): ScenarioRegistry;

export type StatisticsLiveRun = DomainLiveRun;

export function runStatisticsLiveScenarios(registry: ScenarioRegistry): Promise<StatisticsLiveRun>;

export interface APIKeyLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly update: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
}

export interface APIKeyLiveClient {
  readonly apiKeys: APIKeyLiveFacade;
}

export interface APIKeyLiveCreateRequest {
  readonly label: string;
  readonly scopes: readonly [string, ...string[]];
  readonly ip_allow_list?: readonly [];
}

export interface CreateAPIKeyScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: APIKeyLiveClient;
  readonly createSecondaryClient: (secretKey: string) => APIKeyLiveClient;
  readonly createRequest: APIKeyLiveCreateRequest;
  readonly secondaryCreateRequest: APIKeyLiveCreateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createAPIKeyScenarioRegistry(
  options: CreateAPIKeyScenarioRegistryOptions,
): ScenarioRegistry;

export type APIKeyLiveRun = DomainLiveRun;

export function runAPIKeyLiveScenarios(registry: ScenarioRegistry): Promise<APIKeyLiveRun>;

export interface RouteLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly update: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
}

export interface RouteLiveClient {
  readonly routes: RouteLiveFacade;
}

export interface RouteLiveCreateRequest {
  readonly name: string;
  readonly url: string;
  readonly recipient: string;
  readonly attachments?: boolean;
  readonly headers?: boolean;
  readonly group_by_message_id?: boolean;
  readonly strip_replies?: boolean;
  readonly enabled?: boolean;
}

export interface RouteLiveUpdateRequest {
  readonly name?: string;
  readonly url?: string;
  readonly recipient: string;
  readonly attachments?: boolean;
  readonly headers?: boolean;
  readonly group_by_message_id?: boolean;
  readonly strip_replies?: boolean;
  readonly enabled?: boolean;
}

export interface RouteListAuthorizationRule {
  readonly kind: "query_domain_required_for_scoped";
  readonly queryParameter: "domain";
  readonly condition: "scoped_role_requires_filter";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface RouteCreateAuthorizationRule {
  readonly kind: "body_domain";
  readonly bodyPath: "recipient";
  readonly quantifier: "one";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface RouteUpdateAuthorizationRule {
  readonly kind: "existing_and_replacement_domain";
  readonly resource: "route";
  readonly resourceIdParameter: "route_id";
  readonly existingPath: "recipient";
  readonly replacementBodyPath: "recipient";
  readonly quantifier: "every";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface RouteAuthorizationRegistry {
  readonly getRoutes: RouteListAuthorizationRule;
  readonly createRoute: RouteCreateAuthorizationRule;
  readonly updateRoute: RouteUpdateAuthorizationRule;
  readonly [operationId: string]: unknown;
}

export interface CreateRouteScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: RouteLiveClient;
  readonly authorization: RouteAuthorizationRegistry;
  readonly controlledDomains: {
    readonly existing: string;
    readonly replacement: string;
  };
  readonly createRequest: RouteLiveCreateRequest;
  readonly updateRequest: RouteLiveUpdateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createRouteScenarioRegistry(
  options: CreateRouteScenarioRegistryOptions,
): ScenarioRegistry;

export type RouteLiveRun = DomainLiveRun;

export function runRouteLiveScenarios(registry: ScenarioRegistry): Promise<RouteLiveRun>;

export interface WebhookLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly update: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
}

export interface WebhookLiveClient {
  readonly webhooks: WebhookLiveFacade;
}

export interface WebhookLiveCreateRequest {
  readonly name: string;
  readonly url: string;
  readonly scope: "scoped";
  readonly domains: readonly [string, ...string[]];
  readonly enabled?: boolean;
  readonly on_reception?: boolean;
  readonly on_delivered?: boolean;
  readonly on_transient_error?: boolean;
  readonly on_failed?: boolean;
  readonly on_bounced?: boolean;
  readonly on_suppressed?: boolean;
  readonly on_opened?: boolean;
  readonly on_clicked?: boolean;
  readonly on_suppression_created?: boolean;
  readonly on_dns_error?: boolean;
}

export interface WebhookLiveUpdateRequest {
  readonly name?: string | null;
  readonly url?: string | null;
  readonly enabled?: boolean | null;
  readonly on_reception?: boolean | null;
  readonly on_delivered?: boolean | null;
  readonly on_transient_error?: boolean | null;
  readonly on_failed?: boolean | null;
  readonly on_bounced?: boolean | null;
  readonly on_suppressed?: boolean | null;
  readonly on_opened?: boolean | null;
  readonly on_clicked?: boolean | null;
  readonly on_suppression_created?: boolean | null;
  readonly on_dns_error?: boolean | null;
  readonly scope: "scoped";
  readonly domains: readonly [string, ...string[]];
}

export interface WebhookCreateAuthorizationRule {
  readonly kind: "all_body_domains";
  readonly bodyPath: "domains";
  readonly scopeBodyPath: "scope";
  readonly globalValue: "global";
  readonly quantifier: "every";
  readonly condition: "global_scope_requires_global_role";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface WebhookUpdateAuthorizationRule {
  readonly kind: "existing_and_new_domains";
  readonly resource: "webhook";
  readonly resourceIdParameter: "webhook_id";
  readonly existingPath: "domains";
  readonly newBodyPath: "domains";
  readonly scopeBodyPath: "scope";
  readonly globalValue: "global";
  readonly quantifier: "every";
  readonly transition: "global_scope_requires_global_role";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface WebhookAuthorizationRegistry {
  readonly createWebhook: WebhookCreateAuthorizationRule;
  readonly updateWebhook: WebhookUpdateAuthorizationRule;
  readonly [operationId: string]: unknown;
}

export interface CreateWebhookScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: WebhookLiveClient;
  readonly authorization: WebhookAuthorizationRegistry;
  readonly controlledDomains: {
    readonly existing: readonly [string, ...string[]];
    readonly newlySupplied: readonly [string, ...string[]];
  };
  readonly createRequest: WebhookLiveCreateRequest;
  readonly updateRequest: WebhookLiveUpdateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createWebhookScenarioRegistry(
  options: CreateWebhookScenarioRegistryOptions,
): ScenarioRegistry;

export type WebhookLiveRun = DomainLiveRun;

export function runWebhookLiveScenarios(registry: ScenarioRegistry): Promise<WebhookLiveRun>;

export interface SMTPCredentialLiveFacade {
  readonly list: (...args: never[]) => unknown;
  readonly iterate: (...args: never[]) => unknown;
  readonly create: (...args: never[]) => unknown;
  readonly get: (...args: never[]) => unknown;
  readonly delete: (...args: never[]) => unknown;
}

export interface SMTPCredentialLiveClient {
  readonly smtpCredentials: SMTPCredentialLiveFacade;
}

export interface ScopedSMTPCredentialLiveCreateRequest {
  readonly name: string;
  readonly sandbox?: boolean;
  readonly scope: "scoped";
  readonly domains: readonly [string, ...string[]];
}

export interface GlobalSMTPCredentialLiveCreateRequest {
  readonly name: string;
  readonly sandbox?: boolean;
  readonly scope: "global";
  readonly domains: readonly [string, ...string[]];
}

export interface SMTPCredentialCreateAuthorizationRule {
  readonly kind: "all_body_domains";
  readonly bodyPath: "domains";
  readonly scopeBodyPath: "scope";
  readonly globalValue: "global";
  readonly quantifier: "every";
  readonly condition: "global_scope_requires_global_role";
  readonly roles: {
    readonly global: string;
    readonly domain: string;
  };
  readonly summary?: string;
}

export interface SMTPCredentialAuthorizationRegistry {
  readonly createSMTPCredential: SMTPCredentialCreateAuthorizationRule;
  readonly [operationId: string]: unknown;
}

export interface CreateSMTPCredentialScenarioRegistryOptions {
  readonly profile: LiveProfile;
  readonly client: SMTPCredentialLiveClient;
  readonly authorization: SMTPCredentialAuthorizationRegistry;
  readonly controlledDomains: readonly [string, ...string[]];
  readonly scopedCreateRequest: ScopedSMTPCredentialLiveCreateRequest;
  readonly globalCreateRequest: GlobalSMTPCredentialLiveCreateRequest;
  readonly pagination?: DomainLivePagination;
}

export function createSMTPCredentialScenarioRegistry(
  options: CreateSMTPCredentialScenarioRegistryOptions,
): ScenarioRegistry;

export type SMTPCredentialLiveRun = DomainLiveRun;

export function runSMTPCredentialLiveScenarios(
  registry: ScenarioRegistry,
): Promise<SMTPCredentialLiveRun>;

export interface CleanupResult {
  readonly label: string;
  readonly status: "passed" | "failed";
}

export interface CleanupRegistry {
  register(label: string, action: () => void | Promise<void>): void;
  readonly size: number;
  readonly results: readonly CleanupResult[];
  run(): Promise<readonly CleanupResult[]>;
}

export function createCleanupRegistry(): CleanupRegistry;

export function runWithCleanup<T>(
  callback: (cleanup: CleanupRegistry) => T | Promise<T>,
): Promise<T>;

export function redactLiveValue(value: unknown, secrets?: readonly string[]): unknown;

export interface LiveResult {
  readonly operationId: string;
  readonly status?: "failed" | "passed" | "pending" | "skipped";
  readonly [key: string]: unknown;
}

export interface CreateLiveReportOptions {
  readonly candidate: LiveCandidate;
  readonly operationResults?: readonly LiveResult[];
  readonly iteratorResults?: readonly LiveResult[];
  readonly cleanupResults?: readonly CleanupResult[];
  readonly secrets?: readonly string[];
}

export function createLiveReport(options: CreateLiveReportOptions): Record<string, unknown>;

export interface LiveReportArtifactOptions {
  readonly reportSource: string | Uint8Array;
  readonly reportSidecar: string | Uint8Array;
  readonly candidate: LiveCandidate;
}

export interface LiveReportSummary {
  readonly report: Record<string, unknown>;
  readonly reportSha256: string;
  readonly package: { readonly name: "@ahasend/sdk"; readonly version: string };
  readonly operations: number;
  readonly iterators: number;
}

export function validateLiveReportArtifacts(options: LiveReportArtifactOptions): LiveReportSummary;

export interface WriteLiveReportOptions {
  readonly report: unknown;
  readonly candidate: LiveCandidate;
  readonly reportPath: string;
  readonly reportSidecarPath?: string;
  readonly secrets?: readonly string[];
}

export interface WrittenLiveReport {
  readonly reportPath: string;
  readonly reportSidecarPath: string;
  readonly reportSha256: string;
}

export function writeLiveReport(options: WriteLiveReportOptions): Promise<WrittenLiveReport>;
