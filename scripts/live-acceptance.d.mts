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

export type MessageLiveFailure = DomainLiveFailure;
export type MessageLiveRun = DomainLiveRun;

export function runMessageLiveScenarios(registry: ScenarioRegistry): Promise<MessageLiveRun>;

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
