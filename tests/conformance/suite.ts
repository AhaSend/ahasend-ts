import {
  AhaSendBadRequestError,
  AhaSendClient,
  AhaSendConfigurationError,
  AhaSendServerError,
} from "../../src/index.js";
import {
  AhaSendWebhookVerificationError,
  MAX_WEBHOOK_BODY_BYTES,
  WebhookVerifier,
  nextRouteHandler,
} from "../../src/webhooks/index.js";

const API_KEY = "aha-sk-conformance-key";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const WEBHOOK_SECRET = "aha-whsec-conformance-secret";
const WEBHOOK_ID = "conformance-webhook-message";
const IDEMPOTENCY_KEY = "conformance-idempotency-key";
const encoder = new TextEncoder();

const validWebhookEvent = {
  type: "message.delivered",
  webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
  timestamp: "2026-07-14T15:03:21.987654321Z",
  data: {
    account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
    event: "on_delivered",
    from: "sender@example.com",
    recipient: "receiver@example.com",
    subject: "Conformance",
    message_id_header: "<conformance@example.com>",
    id: "message-1",
  },
};

export interface ConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export type ConformanceOutcome =
  | { readonly name: string; readonly status: "passed" }
  | {
      readonly name: string;
      readonly status: "failed";
      readonly error: { readonly name: string; readonly message: string };
    };

type ConformanceGlobals = Partial<
  Record<
    | "window"
    | "document"
    | "ServiceWorkerGlobalScope"
    | "navigator"
    | "EdgeRuntime"
    | "Deno"
    | "Bun"
    | "process",
    unknown
  >
>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(
    Object.is(actual, expected),
    `${message}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

async function rejectedBy(run: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

function createFetch(
  handler: (input: RequestInfo | URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input, init ?? {})) as typeof fetch;
}

function createClient(
  fetchImpl: typeof fetch = createFetch(() => new Response("{}", { status: 200 })),
  options: Partial<ConstructorParameters<typeof AhaSendClient>[0]> = {},
): AhaSendClient {
  return new AhaSendClient({
    apiKey: API_KEY,
    accountId: ACCOUNT_ID,
    fetch: fetchImpl,
    ...options,
  });
}

async function withGlobals<T>(globals: ConformanceGlobals, run: () => T | Promise<T>): Promise<T> {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const [name, value] of Object.entries(globals)) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      descriptors.set(name, descriptor);
      if (descriptor !== undefined && !descriptor.configurable) {
        assert(descriptor.writable === true, `${name} global cannot be temporarily replaced`);
        assert(Reflect.set(globalThis, name, value), `${name} global could not be replaced`);
      } else {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          enumerable: false,
          value,
          writable: true,
        });
      }
    }
    return await run();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else if (!descriptor.configurable) {
        assert(
          Reflect.set(globalThis, name, descriptor.value),
          `${name} global could not be restored`,
        );
      } else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

async function signatureFor(id: string, timestamp: string, body: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${body}`)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

async function signedEnvelope(
  body: string,
  timestamp = String(Math.floor(Date.now() / 1_000)),
): Promise<{ readonly body: string; readonly headers: Record<string, string> }> {
  return {
    body,
    headers: {
      "webhook-id": WEBHOOK_ID,
      "webhook-timestamp": timestamp,
      "webhook-signature": await signatureFor(WEBHOOK_ID, timestamp, body),
    },
  };
}

async function expectWebhookReason(
  reason: AhaSendWebhookVerificationError["reason"],
  run: () => unknown | Promise<unknown>,
): Promise<void> {
  const error = await rejectedBy(run);
  assert(
    error instanceof AhaSendWebhookVerificationError,
    `expected AhaSendWebhookVerificationError, got ${errorName(error)}`,
  );
  assertEqual(error.reason, reason, "webhook rejection reason");
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function clientConstruction(): Promise<void> {
  const client = createClient();
  assertEqual(client.accountId, ACCOUNT_ID, "constructed client account ID");

  const error = await rejectedBy(
    () =>
      new AhaSendClient({
        apiKey: API_KEY,
        accountId: "not-an-account-id",
        fetch: createFetch(() => new Response()),
      }),
  );
  assert(error instanceof AhaSendConfigurationError, "invalid construction must be rejected");
}

async function browserGuardAccepts(): Promise<void> {
  const rows: ReadonlyArray<readonly [string, ConformanceGlobals, boolean]> = [
    ["explicit override", { window: {}, document: {}, ServiceWorkerGlobalScope: class {} }, true],
    [
      "Cloudflare Workers",
      { ServiceWorkerGlobalScope: class {}, navigator: { userAgent: "Cloudflare-Workers" } },
      false,
    ],
    ["EdgeRuntime", { ServiceWorkerGlobalScope: class {}, EdgeRuntime: "edge-runtime" }, false],
    ["Deno", { ServiceWorkerGlobalScope: class {}, Deno: {} }, false],
    ["Bun", { ServiceWorkerGlobalScope: class {}, Bun: {} }, false],
    [
      "Node.js",
      { ServiceWorkerGlobalScope: class {}, process: { versions: { node: "22.0.0" } } },
      false,
    ],
  ];

  for (const [label, globals, dangerouslyAllowBrowser] of rows) {
    await withGlobals(
      {
        window: undefined,
        document: undefined,
        ServiceWorkerGlobalScope: undefined,
        navigator: undefined,
        EdgeRuntime: undefined,
        Deno: undefined,
        Bun: undefined,
        process: undefined,
        ...globals,
      },
      () => {
        const client = createClient(undefined, { dangerouslyAllowBrowser });
        assertEqual(client.accountId, ACCOUNT_ID, `${label} construction`);
      },
    );
  }
}

async function browserGuardRefuses(): Promise<void> {
  const rows: ReadonlyArray<readonly [string, ConformanceGlobals]> = [
    ["window", { window: {}, EdgeRuntime: "edge-runtime" }],
    ["document", { document: {}, Deno: {} }],
    ["unidentified service worker", { ServiceWorkerGlobalScope: class {} }],
  ];

  for (const [label, globals] of rows) {
    await withGlobals(
      {
        window: undefined,
        document: undefined,
        ServiceWorkerGlobalScope: undefined,
        navigator: undefined,
        EdgeRuntime: undefined,
        Deno: undefined,
        Bun: undefined,
        process: undefined,
        ...globals,
      },
      async () => {
        const error = await rejectedBy(() => createClient());
        assert(
          error instanceof AhaSendConfigurationError && /browser/i.test(error.message),
          `${label} must be refused as a browser context`,
        );
      },
    );
  }
}

async function processLessFromEnv(): Promise<void> {
  await withGlobals({ process: undefined }, async () => {
    const error = await rejectedBy(() => AhaSendClient.fromEnv());
    assert(error instanceof AhaSendConfigurationError, "fromEnv must report a configuration error");
    assert(/missing API key/i.test(error.message), "fromEnv must report the missing API key");
  });
}

async function retryingInjectedFetch(): Promise<void> {
  let attempts = 0;
  const client = createClient(
    createFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("server error", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ message: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    { retry: { enabled: true, maxRetries: 1, jitter: false } },
  );

  const response = await client.ping();
  assertEqual(attempts, 2, "injected fetch attempt count");
  assertEqual(response.message, "pong", "retried response body");
}

async function idempotency(): Promise<void> {
  let seenKey: string | null = null;
  const client = createClient(
    createFetch((_input, init) => {
      seenKey = new Headers(init.headers).get("idempotency-key");
      return new Response(JSON.stringify({ object: "list", data: [] }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }),
  );

  await client.messages.send(
    {
      from: { email: "sender@example.com" },
      recipients: [{ email: "recipient@example.com" }],
      subject: "Conformance",
      text_content: "Conformance",
    },
    { idempotencyKey: IDEMPOTENCY_KEY },
  );
  assertEqual(seenKey, IDEMPOTENCY_KEY, "idempotency header");
}

async function representativeErrors(): Promise<void> {
  const rows: ReadonlyArray<
    readonly [number, typeof AhaSendBadRequestError | typeof AhaSendServerError]
  > = [
    [400, AhaSendBadRequestError],
    [500, AhaSendServerError],
  ];

  for (const [status, ErrorClass] of rows) {
    const client = createClient(
      createFetch(
        () =>
          new Response(JSON.stringify({ message: `status ${String(status)}` }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
      { retry: { enabled: false } },
    );
    const error = await rejectedBy(() => client.ping());
    assert(error instanceof ErrorClass, `HTTP ${String(status)} must map to ${ErrorClass.name}`);
    assertEqual(error.status, status, `HTTP ${String(status)} error status`);
  }
}

async function webhookAcceptance(): Promise<void> {
  const envelope = await signedEnvelope(JSON.stringify(validWebhookEvent));
  const event = await new WebhookVerifier(WEBHOOK_SECRET).parse(envelope.headers, envelope.body);
  assertEqual(event.type, "message.delivered", "accepted webhook event type");
}

async function webhookBadSignature(): Promise<void> {
  const envelope = await signedEnvelope(JSON.stringify(validWebhookEvent));
  await expectWebhookReason("signature_mismatch", () =>
    new WebhookVerifier(WEBHOOK_SECRET).parse(
      envelope.headers,
      envelope.body.replace("Conformance", "Tampered"),
    ),
  );
}

async function webhookStaleTimestamp(): Promise<void> {
  const staleTimestamp = String(Math.floor(Date.now() / 1_000) - 1_000);
  const envelope = await signedEnvelope(JSON.stringify(validWebhookEvent), staleTimestamp);
  await expectWebhookReason("timestamp_outside_tolerance", () =>
    new WebhookVerifier(WEBHOOK_SECRET, { toleranceSeconds: 300 }).parse(
      envelope.headers,
      envelope.body,
    ),
  );
}

async function webhookOversizedBody(): Promise<void> {
  await expectWebhookReason("body_too_large", () =>
    new WebhookVerifier(WEBHOOK_SECRET).verify({}, new Uint8Array(MAX_WEBHOOK_BODY_BYTES + 1)),
  );
}

async function webhookMalformedPayload(): Promise<void> {
  const envelope = await signedEnvelope(JSON.stringify({ unexpected: true }));
  await expectWebhookReason("invalid_payload", () =>
    new WebhookVerifier(WEBHOOK_SECRET).parse(envelope.headers, envelope.body),
  );
}

async function requestAdapter(): Promise<void> {
  const envelope = await signedEnvelope(JSON.stringify(validWebhookEvent));
  let handledType: string | undefined;
  const route = nextRouteHandler(new WebhookVerifier(WEBHOOK_SECRET), (event) => {
    handledType = event.type;
    return new Response("accepted", { status: 202 });
  });
  const response = await route(
    new Request("https://example.test/webhooks", {
      method: "POST",
      headers: envelope.headers,
      body: envelope.body,
    }),
  );

  assertEqual(handledType, "message.delivered", "Request adapter event type");
  assertEqual(response.status, 202, "Request adapter response status");
  assertEqual(await response.text(), "accepted", "Request adapter response body");
}

async function pacedBurst(): Promise<void> {
  const startedAt: number[] = [];
  const client = createClient(
    createFetch(() => {
      startedAt.push(performance.now());
      return new Response(JSON.stringify({ message: "pong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
    {
      rateLimit: {
        enabled: true,
        standard: { requestsPerSecond: 10, burst: 2 },
      },
      retry: { enabled: false },
    },
  );

  await Promise.all([client.ping(), client.ping(), client.ping()]);
  assertEqual(startedAt.length, 3, "paced fetch count");
  const first = startedAt[0];
  const second = startedAt[1];
  const third = startedAt[2];
  assert(first !== undefined && second !== undefined && third !== undefined, "paced timestamps");
  assert(second - first < 75, "the configured burst must admit its first two calls together");
  const refillDelay = third - second;
  assert(refillDelay >= 25, `the third call was not paced (${String(refillDelay)}ms)`);
  assert(
    refillDelay < 2_500,
    `the paced call exceeded its bounded delay (${String(refillDelay)}ms)`,
  );
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = Object.freeze([
  { name: "client construction and rejection", run: clientConstruction },
  { name: "browser guard acceptance", run: browserGuardAccepts },
  { name: "browser guard refusal", run: browserGuardRefuses },
  { name: "process-less fromEnv", run: processLessFromEnv },
  { name: "retrying injected fetch", run: retryingInjectedFetch },
  { name: "idempotency", run: idempotency },
  { name: "representative 4xx and 5xx errors", run: representativeErrors },
  { name: "acceptance", run: webhookAcceptance },
  { name: "bad signature", run: webhookBadSignature },
  { name: "stale timestamp", run: webhookStaleTimestamp },
  { name: "oversized body", run: webhookOversizedBody },
  { name: "malformed payload", run: webhookMalformedPayload },
  { name: "Request adapter", run: requestAdapter },
  { name: "paced burst", run: pacedBurst },
]);

export async function runConformanceCase(testCase: ConformanceCase): Promise<ConformanceOutcome> {
  try {
    await testCase.run();
    return { name: testCase.name, status: "passed" };
  } catch (error) {
    return {
      name: testCase.name,
      status: "failed",
      error: {
        name: errorName(error),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runConformanceSuite(): Promise<readonly ConformanceOutcome[]> {
  const outcomes: ConformanceOutcome[] = [];
  for (const testCase of CONFORMANCE_CASES) outcomes.push(await runConformanceCase(testCase));
  return outcomes;
}
