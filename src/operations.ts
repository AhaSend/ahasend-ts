import type { OperationId, RetryMode } from "./generated/operations.js";
import { OPERATION_DESCRIPTORS } from "./generated/operations.js";
import type { HttpClient } from "./http.js";
import type { AhaSendPromise, RequestOptions } from "./types/common.js";

export interface OperationParameters {
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

type OperationTransport = Pick<HttpClient, "request">;

const PATH_PARAMETER = /\{([^{}]+)\}/g;

/**
 * Internal bridge between generated operation facts and the HTTP transport.
 * It is intentionally not part of the package's public export surface.
 */
export class OperationExecutor {
  constructor(private readonly http: OperationTransport) {}

  execute<T>(
    operationId: OperationId,
    parameters: OperationParameters = {},
    options: RequestOptions = {},
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
    const retryMode: RetryMode = descriptor.retry;

    return this.http.request<T>({
      method: descriptor.method,
      path,
      ...(query ? { query } : {}),
      ...(descriptor.body !== null && parameters.body !== undefined
        ? { body: parameters.body }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      operationId,
      retryMode,
      autoIdempotency: descriptor.idempotency,
    });
  }
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
