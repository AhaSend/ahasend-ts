import { vi } from "vitest";
import { AhaSendClient } from "../../src/client.js";
import type { OperationId } from "../../src/generated/operations.js";
import { OPERATION_DESCRIPTORS } from "../../src/generated/operations.js";

type FetchImpl = typeof fetch;

export const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const API_KEY_ID = "22222222-2222-4222-8222-222222222222";
export const WEBHOOK_ID = "33333333-3333-4333-8333-333333333333";
export const ROUTE_ID = "44444444-4444-4444-8444-444444444444";
export const SUB_ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
export const USER_ID = "66666666-6666-4666-8666-666666666666";
export const SMTP_CREDENTIAL_ID = "77777777-7777-4777-8777-777777777777";
export const HOSTNAME = "mail.example.test";

export interface ResourceCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
  readonly headers: Record<string, string>;
  readonly operationId: OperationId;
}

export type ResponseFactory = (call: ResourceCall, index: number) => Response | Promise<Response>;

const DEFAULT_RESPONSE_FACTORY: ResponseFactory = () =>
  new Response(JSON.stringify({ object: "list", data: [], message: "ok", id: "msg_1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export function captureFetch(responseFactory: ResponseFactory = DEFAULT_RESPONSE_FACTORY): {
  fetch: FetchImpl;
  calls: ResourceCall[];
} {
  const calls: ResourceCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const call: ResourceCall = {
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: normalizeHeaders(init?.headers),
      operationId: resolveOperationId(method, new URL(url).pathname),
    };
    const index = calls.push(call) - 1;
    return responseFactory(call, index);
  }) as unknown as FetchImpl;

  return { fetch: fetchImpl, calls };
}

export function makeClient(fetchImpl: FetchImpl): AhaSendClient {
  return new AhaSendClient({
    apiKey: "aha-sk-test",
    accountId: ACCOUNT_ID,
    baseUrl: "https://api.test",
    fetch: fetchImpl,
    retry: { enabled: false },
  });
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    normalized[name.toLowerCase()] = value;
  });
  return normalized;
}

function resolveOperationId(method: string, pathname: string): OperationId {
  for (const [operationId, descriptor] of Object.entries(OPERATION_DESCRIPTORS) as Array<
    [OperationId, (typeof OPERATION_DESCRIPTORS)[OperationId]]
  >) {
    if (descriptor.method === method && pathPattern(descriptor.path).test(pathname)) {
      return operationId;
    }
  }
  throw new TypeError(`No generated operation matches ${method} ${pathname}`);
}

function pathPattern(template: string): RegExp {
  const source = template
    .split(/(\{[^{}]+\})/)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? "[^/]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}
