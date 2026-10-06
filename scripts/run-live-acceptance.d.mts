import type {
  CleanupResult,
  LiveCandidate,
  LiveReportSummary,
  LiveResult,
} from "./live-acceptance.mjs";

export interface LiveAcceptanceFailure {
  readonly phase?: string;
  readonly operationId?: string;
  readonly serialized?: { readonly name: string; readonly message: string };
  readonly error?: unknown;
}

export interface LiveAcceptanceResults {
  readonly operationResults?: readonly LiveResult[];
  readonly iteratorResults?: readonly LiveResult[];
  readonly cleanupResults?: readonly CleanupResult[];
  readonly failure?: LiveAcceptanceFailure | null;
}

export interface PersistLiveAcceptanceEvidenceOptions {
  readonly candidate: LiveCandidate;
  readonly results?: LiveAcceptanceResults;
  readonly failure?: LiveAcceptanceFailure | unknown | null;
  readonly reportPath: string;
  readonly reportSidecarPath: string;
  readonly secrets?: readonly string[];
}

export function persistLiveAcceptanceEvidence(
  options: PersistLiveAcceptanceEvidenceOptions,
): Promise<LiveReportSummary>;

export interface LiveConfig {
  readonly verifiedDomain: string;
  readonly replacementVerifiedDomain: string;
  readonly neverRegisteredDomain: string;
  readonly dnslessDomain: string;
  readonly lifecycleDomain: string;
  readonly suppressionDomain: string;
  readonly disposableMailbox: string;
  readonly templateId: string;
  readonly webhookUrl: string;
}

/** Parse and validate `AHASEND_LIVE_CONFIG_JSON`. */
export function parseLiveConfig(source: string): LiveConfig;

export function main(): Promise<void>;
