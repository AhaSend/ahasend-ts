/// <reference types="node" />

import type { RendererReportSummary } from "./verify-renderer-report.mjs";

export interface ValidateExternalAttestationsOptions {
  readonly rendererHandoffSource: string | Uint8Array;
  readonly rendererHandoffSidecar: string | Uint8Array;
  readonly rendererReportSource: string | Uint8Array;
}

export interface ExternalAttestationSummary {
  readonly renderer: RendererReportSummary;
}

export function validateExternalAttestations(
  options: ValidateExternalAttestationsOptions,
): ExternalAttestationSummary;
