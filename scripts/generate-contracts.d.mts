import type { NodeCodeSample } from "./node-code-samples.mjs";

export type OpenApiRecord = Record<string, unknown>;

export interface ContractOperation {
  method: string;
  path: string;
  operationId: string;
  operation: OpenApiRecord;
}

export interface ContractInventory extends OpenApiRecord {
  operationIds: string[];
  schemaNames: string[];
  idempotencyOperationIds: string[];
  subAccountOperationIds: string[];
  subAccountSchemaNames: string[];
  roleAlternativeOperationIds: string[];
}

export function parseOpenApi(source: string): OpenApiRecord;
export function parseWebhookContract(source: string): OpenApiRecord;
export function validateWebhookContract(document: unknown): void;
export function validateCapturedManifestSchema(schema: unknown): OpenApiRecord;
export function validateCapturedManifest(manifest: unknown, schema: unknown): OpenApiRecord[];
export function validateSignedFixture(
  capture: unknown,
  rawBody: string | Uint8Array,
  keyFileBytes: Uint8Array,
  options:
    | { captured: true; headerRecordFormat: string }
    | { captured: false; headerRecordFormat?: never },
): void;
export function validateSecretScanAllowlist(
  policy: unknown,
  root: string,
): Promise<OpenApiRecord[]>;
export function validateWebhookEvidence(
  root: string,
  options?: { checkDigest?: boolean },
): Promise<{
  manifestDigest: string;
  schemaDigest: string;
  syntheticDigest: string;
  policyDigest: string;
  captureCount: number;
  syntheticCount: number;
}>;
export function collectOperations(document: unknown): ContractOperation[];
export function collectContractInventory(document: unknown): ContractInventory;
export function validateInternalReferences(document: unknown): void;
export function assertInventoryMatches(actual: unknown, expected: unknown): void;
export function validateCodeSamples(
  document: unknown,
  nodeSamples?: Readonly<Record<string, NodeCodeSample>>,
  options?: { allowMissingNodeSamples?: boolean; allowNodeSampleDrift?: boolean },
): void;
export function injectNodeSamples(
  source: string,
  document: unknown,
  nodeSamples?: Readonly<Record<string, NodeCodeSample>>,
): string;
