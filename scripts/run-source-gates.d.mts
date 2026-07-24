/// <reference types="node" />

export const REQUIRED_SOURCE_GATES: readonly [
  "generation",
  "typecheck",
  "typed-lint",
  "unit-tests",
  "state-tests",
  "webhook-tests",
  "framework-tests",
  "coverage",
  "format",
  "test-policy",
  "repository-secret-scan",
  "audit",
];

export interface SourceBindings {
  readonly commit: string;
  readonly contractSha256: Readonly<Record<string, string>>;
  readonly profileSha256: string;
  readonly captureSha256: string;
  readonly keysSha256: Readonly<Record<string, string>>;
  readonly lockfileSha256: string;
  readonly auditPolicySha256: string;
}

export interface ValidateSourceGateReportOptions {
  readonly reportSource: string | Uint8Array;
  readonly reportSidecar: string | Uint8Array;
  readonly expectedBindings: SourceBindings;
}

export interface SourceGateReportSummary {
  readonly commit: string;
  readonly reportDigest: string;
  readonly gates: number;
}

export function validateSourceGateReport(
  options: ValidateSourceGateReportOptions,
): SourceGateReportSummary;

export function readRepositorySourceBindings(): Promise<SourceBindings>;
