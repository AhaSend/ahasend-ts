/// <reference types="node" />

export interface VerifyRegistryProvenanceOptions {
  readonly candidateTarballSource: string | Uint8Array;
  readonly candidateManifestSource: string | Uint8Array;
  readonly candidateManifestSidecar: string | Uint8Array;
  readonly candidatePackageManifestSource: string | Uint8Array;
  readonly registryTarballSource: string | Uint8Array;
  readonly registryMetadataSource: string | Uint8Array;
  readonly auditReportSource: string | Uint8Array;
}

export interface RegistryProvenanceSummary {
  readonly commit: string;
  readonly integrity: string;
  readonly manifestSha256: string;
  readonly name: "@ahasend/sdk";
  readonly tarballSha256: string;
  readonly version: string;
}

export function verifyRegistryProvenance(
  options: VerifyRegistryProvenanceOptions,
): RegistryProvenanceSummary;
