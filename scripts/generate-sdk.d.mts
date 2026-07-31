export type OpenApiRecord = Record<string, unknown>;

export type OperationMapping = readonly [operationId: string, facade: string, method: string];

export const PRIMARY_OPERATION_MAPPINGS: readonly OperationMapping[];
export const ITERATOR_MAPPINGS: readonly OperationMapping[];
export const AUTHORIZATION_REGISTRY: Readonly<Record<string, OpenApiRecord>>;

export function dereferenceResponse(document: OpenApiRecord, value: unknown): OpenApiRecord;
export function resolveAllOfPropertySchema(
  schemaValues: unknown,
  name: string,
  componentSchemas?: OpenApiRecord,
): unknown;
export function schemaType(
  schemaValue: unknown,
  level?: number,
  enclosingSchemaValue?: unknown,
  componentSchemas?: OpenApiRecord,
): string;
export function validateOperationProfile(document: unknown, profile: unknown): void;
export function validateAuthorizationRegistry(
  document: unknown,
  registry?: Readonly<Record<string, OpenApiRecord>>,
): Readonly<Record<string, OpenApiRecord>>;
export function generateSdkArtifacts(
  openApiSource: string,
  webhookSource: string,
): Promise<Map<string, string>>;
