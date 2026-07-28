/// <reference types="node" />

export interface CandidateBindings {
  readonly commit: string;
  readonly sourceReportSha256: string;
  readonly contractSha256: Readonly<Record<string, string>>;
  readonly captureSha256: string;
  readonly keysSha256: Readonly<Record<string, string>>;
  readonly rendererReportSha256: string;
  readonly profileSha256: string;
  readonly tarballSha256: string;
}

export interface CandidateManifest extends CandidateBindings {
  readonly version: 1;
}

export function parseCandidateManifest(value: unknown, label?: string): CandidateManifest;

export interface ValidateCandidateManifestOptions {
  readonly manifestSource: string | Uint8Array;
  readonly manifestSidecar: string | Uint8Array;
  readonly expectedBindings: CandidateBindings;
}

export interface CandidateManifestSummary {
  readonly commit: string;
  readonly manifestDigest: string;
  readonly tarballDigest: string;
}

export interface ValidatePackagedOperationProfileOptions {
  readonly packagedProfileSource: string | Uint8Array;
  readonly packagedProfileSidecar: string | Uint8Array;
  readonly packagedOperationDescriptorsSource: string | Uint8Array;
  readonly sourceProfileSource: string | Uint8Array;
  readonly sourceProfileSidecar: string | Uint8Array;
  readonly openApiSource: string | Uint8Array;
}

export interface PackagedOperationProfileSummary {
  readonly profileDigest: string;
  readonly operations: number;
  readonly iterators: number;
  readonly resourceAuthorizationRules: number;
}

export interface ValidateCleanCommitOptions {
  readonly commit: string;
  readonly expectedCommit: string;
  readonly status: string;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly encoding?: BufferEncoding;
}

export type CandidateCommandRunner = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
) => string | Buffer;

export interface CreateCandidateOptions {
  readonly sourceReportPath: string;
  readonly sourceReportSidecarPath?: string;
  readonly rendererReportPath: string;
  readonly outputDirectory: string;
  readonly runCommand?: CandidateCommandRunner;
}

export interface CreatedCandidate {
  readonly commit: string;
  readonly manifestDigest: string;
  readonly manifestPath: string;
  readonly manifestSidecarPath: string;
  readonly tarballPath: string;
  readonly tarballDigest: string;
}

export function validateCandidateManifest(
  options: ValidateCandidateManifestOptions,
): CandidateManifestSummary;

export function validatePackagedOperationProfile(
  options: ValidatePackagedOperationProfileOptions,
): PackagedOperationProfileSummary;

export function validateCleanCommit(options: ValidateCleanCommitOptions): string;

export function createCandidate(options: CreateCandidateOptions): Promise<CreatedCandidate>;
