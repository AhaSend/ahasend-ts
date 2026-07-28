import type { OperationId, RetryMode } from "./generated/operations.js";
import { OPERATION_DESCRIPTORS } from "./generated/operations.js";
import type { HttpClient } from "./http.js";
import type { IdempotencyOperationPolicy } from "./idempotency.js";
import type { AhaSendPromise, IdempotencyRequestOptions } from "./types/common.js";

export interface OperationParameters {
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

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

  execute<T>(
    operationId: OperationId,
    parameters: OperationParameters = {},
    options: IdempotencyRequestOptions = {},
  ): AhaSendPromise<T> {
    const descriptor = OPERATION_DESCRIPTORS[operationId];
    const path = descriptor.path.replace(PATH_PARAMETER, (_placeholder, name: string) => {
      const value = parameters.path?.[name];
      if (!Object.hasOwn(parameters.path ?? {}, name) || value === undefined || value === null) {
        throw new TypeError(`Missing path parameter ${JSON.stringify(name)} for ${operationId}`);
      }
      return encodeURIComponent(String(value));
    });

    const query = selectDeclaredQuery(parameters.query, descriptor.query);
    const execution = createOperationExecutionRecord(operationId);
    return this.http.request<T>({
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

function selectDeclaredQuery(
  values: Readonly<Record<string, unknown>> | undefined,
  declarations: readonly { readonly name: string }[],
): Record<string, unknown> | undefined {
  if (values === undefined) return undefined;

  const query: Record<string, unknown> = {};
  for (const { name } of declarations) {
    if (Object.hasOwn(values, name)) query[name] = values[name];
  }
  return Object.keys(query).length > 0 ? query : undefined;
}
