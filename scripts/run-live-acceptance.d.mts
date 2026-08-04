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

export function main(): Promise<void>;
