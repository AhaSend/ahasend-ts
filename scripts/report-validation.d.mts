/// <reference types="node" />

export function requireObject(value: unknown, label: string): Record<string, unknown>;

export function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void;

export function requireString(value: unknown, label: string): string;
export function requireHash(value: unknown, label: string): string;
export function sourceBytes(value: string | Uint8Array, label: string): Buffer;
export function decodeUtf8(source: string | Uint8Array, label: string): string;

export function parseCanonicalJson(
  source: string | Uint8Array,
  label: string,
): { readonly value: Record<string, unknown>; readonly bytes: Buffer };

export function parseSha256Sidecar(source: string | Uint8Array, label: string): string;

export interface ExactPassedGateResultLabels {
  readonly reportLabel: string;
  readonly resultLabel: string;
  readonly gateLabel: string;
  readonly gatesLabel: string;
}

export function requireExactPassedGateResults(
  value: unknown,
  requiredGates: readonly string[],
  labels: ExactPassedGateResultLabels,
): void;

export interface ValidateGateReportOptions {
  readonly report: unknown;
  readonly requiredGates: readonly string[];
  readonly expectedManifestSha256: string;
  readonly expectedTarballSha256: string;
}

export interface GateReportSummary {
  readonly commit: string;
  readonly manifestSha256: string;
  readonly tarballSha256: string;
  readonly liveReportSha256: string;
  readonly gates: number;
}

export function validateGateReport(options: ValidateGateReportOptions): GateReportSummary;
