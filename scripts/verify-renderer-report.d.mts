/// <reference types="node" />

export interface ValidateRendererReportOptions {
  readonly handoffSource: string | Uint8Array;
  readonly handoffSidecar: string | Uint8Array;
  readonly reportSource: string | Uint8Array;
}

export interface RendererReportSummary {
  readonly handoffDigest: string;
  readonly operations: number;
  readonly tabs: number;
}

export function validateRendererReport(
  options: ValidateRendererReportOptions,
): RendererReportSummary;
