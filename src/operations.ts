import type {
  OperationId,
  OperationInputById,
  OperationSuccessById,
  RetryMode,
} from "./generated/operations.js";
import { OPERATION_DESCRIPTORS } from "./generated/operations.js";
import type { HttpClient } from "./http.js";
import type { IdempotencyOperationPolicy } from "./idempotency.js";
import { assertExclusiveCursors } from "./pagination.js";
import type { AhaSendPromise, IdempotencyRequestOptions } from "./types/common.js";

type OperationTransport = Pick<HttpClient, "request">;

export interface OperationExecutionRecord {
  readonly operationId: OperationId;
  readonly retryMode: RetryMode;
  readonly idempotency: IdempotencyOperationPolicy | null;
}

const PATH_PARAMETER = /\{([^{}]+)\}/g;
const MANUAL_SECRET_COMPLETION_OPERATIONS: ReadonlySet<OperationId> = new Set([
  "createAPIKey",
  "createSubAccountAPIKey",
]);

/**
 * Internal bridge between generated operation facts and the HTTP transport.
 * It is intentionally not part of the package's public export surface.
 */
export class OperationExecutor {
  constructor(private readonly http: OperationTransport) {}

  execute<K extends OperationId>(
    operationId: K,
    parameters: OperationInputById[K],
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<OperationSuccessById[K]> {
    const descriptor = OPERATION_DESCRIPTORS[operationId];
    const path = descriptor.path.replace(PATH_PARAMETER, (_placeholder, name: string) => {
      const value = readPathParameter(parameters.path, name);
      if (value === undefined) {
        throw new TypeError(`Missing path parameter ${JSON.stringify(name)} for ${operationId}`);
      }
      return encodeURIComponent(String(value));
    });

    const query = validateAndSelectDeclaredQuery(
      operationId,
      "query" in parameters ? parameters.query : undefined,
      descriptor.query,
    );
    const execution = createOperationExecutionRecord(operationId);
    return this.http.request<OperationSuccessById[K]>({
      method: descriptor.method,
      path,
      ...(query ? { query } : {}),
      ...(descriptor.body !== null && parameters.body !== undefined
        ? { body: parameters.body }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      execution,
    });
  }
}

function readPathParameter(values: object | undefined, name: string): string | number | undefined {
  if (values === undefined || !Object.hasOwn(values, name)) return undefined;
  const value: unknown = Reflect.get(values, name);
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function createOperationExecutionRecord(operationId: OperationId): OperationExecutionRecord {
  const descriptor = OPERATION_DESCRIPTORS[operationId];
  const idempotency = descriptor.idempotency
    ? Object.freeze<IdempotencyOperationPolicy>({
        completion: MANUAL_SECRET_COMPLETION_OPERATIONS.has(operationId)
          ? "manual_secret"
          : "automatic",
      })
    : null;

  return Object.freeze({
    operationId,
    retryMode: descriptor.retry,
    idempotency,
  });
}

function validateAndSelectDeclaredQuery(
  operationId: OperationId,
  values: Readonly<Record<string, unknown>> | undefined,
  declarations: readonly { readonly name: string; readonly required: boolean }[],
): Record<string, unknown> | undefined {
  const declaredNames = new Set(declarations.map(({ name }) => name));
  if (values !== undefined) {
    const undeclaredName = Object.keys(values).find((name) => !declaredNames.has(name));
    if (undeclaredName !== undefined) {
      throw new TypeError(
        `Unknown query parameter ${JSON.stringify(undeclaredName)} for ${operationId}`,
      );
    }
  }

  for (const { name, required } of declarations) {
    if (
      required &&
      (values === undefined ||
        !Object.hasOwn(values, name) ||
        values[name] === undefined ||
        values[name] === null)
    ) {
      throw new TypeError(
        `Missing required query parameter ${JSON.stringify(name)} for ${operationId}`,
      );
    }
  }

  if (values === undefined) return undefined;
  assertExclusiveCursors(values);

  const query: Record<string, unknown> = {};
  for (const { name } of declarations) {
    if (Object.hasOwn(values, name)) query[name] = values[name];
  }
  return Object.keys(query).length > 0 ? query : undefined;
}
