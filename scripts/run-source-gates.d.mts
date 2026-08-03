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
  "documentation-workflows",
];

export const SOURCE_CONTRACT_PATHS: readonly [
  "contracts.lock.json",
  "openapi.yaml",
  "webhooks.yaml",
];

export const SOURCE_KEY_PATHS: readonly [
  "contracts/webhooks/captured/keys/configured-webhook.key",
  "contracts/webhooks/captured/keys/route.key",
];

export function requireSourceCommit(value: unknown, label: string): string;

export function parseSourceHashMap(
  value: unknown,
  paths: readonly string[],
  label: string,
): Record<string, string>;

export function requireSourceBinding(
  actual: unknown,
  expected: unknown,
  label: string,
  owner?: string,
): void;

export interface SourceArtifactBindings {
  readonly commit: string;
  readonly contractSha256: Readonly<Record<string, string>>;
  readonly profileSha256: string;
  readonly captureSha256: string;
  readonly keysSha256: Readonly<Record<string, string>>;
}

export function compareSourceArtifactBindings(
  actual: SourceArtifactBindings,
  expected: SourceArtifactBindings,
  owner?: string,
): void;

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
