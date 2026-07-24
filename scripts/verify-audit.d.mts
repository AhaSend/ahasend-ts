/// <reference types="node" />

export interface AuditValidationInput {
  readonly fullReport: unknown;
  readonly productionReport: unknown;
  readonly policy: unknown;
  readonly exceptions: unknown;
  readonly today?: string;
}

export interface AuditValidationSummary {
  readonly productionAdvisories: number;
  readonly directDevelopmentAdvisories: number;
  readonly transitiveDevelopmentAdvisories: number;
  readonly exceptions: number;
}

export function validateAuditReports(input: AuditValidationInput): AuditValidationSummary;
