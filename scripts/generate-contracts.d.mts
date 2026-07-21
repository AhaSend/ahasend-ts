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
