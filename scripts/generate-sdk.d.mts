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
/**
 * Normalize a webhook schema into the runtime validation shape. Formats listed
 * in `UNENFORCED_WEBHOOK_FORMATS` (currently `email`) are dropped, so inbound
 * payloads are not rejected on address shape.
 */
export function validationSchema(schemaValue: unknown): OpenApiRecord;
export function validateOperationProfile(document: unknown, profile: unknown): void;
export function validateAuthorizationRegistry(
  document: unknown,
  registry?: Readonly<Record<string, OpenApiRecord>>,
): Readonly<Record<string, OpenApiRecord>>;
export function generateSdkArtifacts(
  openApiSource: string,
  webhookSource: string,
): Promise<Map<string, string>>;
