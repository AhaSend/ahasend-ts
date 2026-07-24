/// <reference types="node" />

import type { RendererReportSummary } from "./verify-renderer-report.mjs";

export interface ValidateWebhookAttestationsOptions {
  readonly manifestSource: string | Uint8Array;
  readonly manifestSchemaSource: string | Uint8Array;
  readonly manifestSidecar: string | Uint8Array;
  readonly typescriptResultsSource: string | Uint8Array;
  readonly typescriptResultsSidecar: string | Uint8Array;
  readonly goResultsSource: string | Uint8Array;
  readonly fixtureSources: Readonly<Record<string, string | Uint8Array>>;
}

export interface WebhookAttestationSummary {
  readonly manifestDigest: string;
  readonly serverCommit: string;
  readonly fixtures: number;
}

export interface ValidateExternalAttestationsOptions {
  readonly rendererHandoffSource: string | Uint8Array;
  readonly rendererHandoffSidecar: string | Uint8Array;
  readonly rendererReportSource: string | Uint8Array;
  readonly webhook: ValidateWebhookAttestationsOptions;
}

export interface ExternalAttestationSummary {
  readonly renderer: RendererReportSummary;
  readonly webhooks: WebhookAttestationSummary;
}

export function validateWebhookAttestations(
  options: ValidateWebhookAttestationsOptions,
): WebhookAttestationSummary;

export function validateExternalAttestations(
  options: ValidateExternalAttestationsOptions,
): ExternalAttestationSummary;
