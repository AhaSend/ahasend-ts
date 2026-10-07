# AhaSend TypeScript SDK

The official TypeScript SDK for the [AhaSend](https://ahasend.com) transactional email API.

> **v0.x** — the public API may change before 1.0. Pin an exact version in
> production and read the
> [CHANGELOG](https://github.com/AhaSend/ahasend-ts/blob/main/CHANGELOG.md) before upgrading.

> ⚠️ **This is a server-side SDK.** The AhaSend API key must not be embedded in a browser
> bundle — anyone with the key can send mail on your account's behalf. `AhaSendClient` refuses to
> construct in a browser-like environment (`window`, `document`, or a browser Service Worker scope)
> by default.

## Supported runtimes

The maintained, blocking CI gates define the supported runtime inventory exactly:

- Node.js 22, 24, and 26.
- Deno latest 2.x.
- Bun latest.
- Cloudflare workerd without `nodejs_compat`.
- Vercel Edge through `@edge-runtime/vm`.

Newer runtime versions may be exercised experimentally before they join this maintained inventory.
Browser and browser Service Worker use is refused by default. The unchanged
`dangerouslyAllowBrowser: true` escape hatch exists for browser-shaped server test environments such
as JSDOM; it disables the construction check, not the risk of exposing a bearer key. Never use it to
put an API key in client-side code.

## Requirements

- An [AhaSend account](https://dash.ahasend.com), an API key
  (`aha-sk-…`), and an account ID.

## Installation

```bash
npm install @ahasend/sdk
```

The package exposes the same runtime API to JavaScript and TypeScript. TypeScript declarations are
included; there is no separate typings package.

ES modules:

```js
import { AhaSendClient } from "@ahasend/sdk";
```

CommonJS:

```js
const { AhaSendClient } = require("@ahasend/sdk");
```

The export map supports TypeScript's `Bundler`, `Node16`, and `NodeNext` module-resolution modes
for both the package root and `@ahasend/sdk/webhooks`. Use these public entry points rather than
deep-importing `dist` files. Legacy `moduleResolution: "node"` and runtimes that ignore package
export maps are not supported.

### What the declarations need from your tsconfig

The published declarations do **not** require `@types/node`, and the package declares no dependency
on it. They name no `Buffer`, no `NodeJS.*` namespace, and import no `node:` module, so they compile
under `"types": []` and with `skipLibCheck: false`.

They do name four WHATWG globals a fetch client cannot avoid exposing — `fetch`, `Request`,
`Response`, and `AbortSignal` — which reach your project through either `"lib": ["DOM"]` or
`@types/node`. One of those two is the requirement. (`Headers` is not among them: webhook headers
are accepted structurally as `WebhookHeadersLike`, so a `Headers` from any realm works without the
type being named.)

Raw webhook bodies are typed `Uint8Array` rather than `Buffer` for the same reason. A `Buffer` is a
`Uint8Array`, so supplying one still works everywhere. The one place this is visible in the other
direction is inside an adapter handler, where `req.rawBody` now arrives as `Uint8Array` and no
longer passes straight into a parameter declared `Buffer` — narrow it with
`Buffer.isBuffer(req.rawBody)`, or wrap it without copying:
`Buffer.from(b.buffer, b.byteOffset, b.byteLength)`.

## Quick start

```ts
import { AhaSendClient } from "@ahasend/sdk";

const client = new AhaSendClient({
  apiKey: process.env.AHASEND_API_KEY!,
  accountId: process.env.AHASEND_ACCOUNT_ID!,
});

const res = await client.messages.send({
  from: { email: "sender@yourdomain.com", name: "Your App" },
  recipients: [{ email: "to@example.com" }],
  subject: "Hello",
  html_content: "<h1>Hi there</h1>",
  text_content: "Hi there",
});

// A 202 is multi-status: one result per recipient. Inspect every entry —
// an individual recipient can come back `status: "error"` with a null `id`
// (a suppressed address, for example) while the promise still resolves.
const queued = res.data.filter((r) => r.status !== "error");
const rejected = res.data.filter((r) => r.status === "error");
console.log({ queued: queued.length, rejected: rejected.length });
```

### Configuration

Every option, with its default:

```ts
const client = new AhaSendClient({
  apiKey: "aha-sk-…", // required
  accountId: "uuid", // required, must be a UUID — one client per account
  baseUrl: "https://api.ahasend.com", // HTTPS enforced (localhost exempt)
  dangerouslyAllowInsecureBaseUrl: false, // dangerous: permits bearer keys over HTTP
  dangerouslyAllowBrowser: false, // dangerous: bypasses browser-like environment refusal
  timeoutMs: 30_000, // default per-attempt timeout in MILLISECONDS
  userAgent: "ahasend-node/x.y.z",
  debug: false, // built-in diagnostics; may include error messages
  fetch: globalThis.fetch, // inject your own fetch if needed
  defaultHeaders: {},
  idempotency: { autoGenerate: true, prefix: "" },
  retry: {
    enabled: true,
    maxRetries: 3, // 3 retries = up to 4 total attempts
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    strategy: "exponential", // "exponential" | "linear" | "constant"
    jitter: true,
  },
  rateLimit: {
    enabled: false, // opt in to local request pacing
    standard: { requestsPerSecond: 100, burst: 200, maxQueue: 1000 },
    statistics: { requestsPerSecond: 1, burst: 1, maxQueue: 1000 },
  },
  hooks: {}, // telemetry — see below
});
```

### Environment variables

`AhaSendClient.fromEnv()` builds a client from the same variables the
official Go SDK reads:

| Variable                                                           | Meaning                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `AHASEND_API_KEY` / `AHASEND_TOKEN`                                | API key (either name works)                                                                      |
| `AHASEND_ACCOUNT_ID`                                               | Account UUID                                                                                     |
| `AHASEND_BASE_URL` (or `AHASEND_SCHEME` + `AHASEND_HOST`)          | API endpoint                                                                                     |
| `AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL`                      | Explicit opt-in for an HTTP environment endpoint                                                 |
| `AHASEND_TIMEOUT`                                                  | Request timeout in **seconds** (note: the constructor option `timeoutMs` is in **milliseconds**) |
| `AHASEND_MAX_RETRIES`                                              | Retry attempts                                                                                   |
| `AHASEND_ENABLE_RATE_LIMIT`                                        | Master rate-limit switch                                                                         |
| `AHASEND_IDEMPOTENCY_AUTO_GENERATE` / `AHASEND_IDEMPOTENCY_PREFIX` | Idempotency behaviour                                                                            |
| `AHASEND_DEBUG`                                                    | Console diagnostics                                                                              |
| `AHASEND_USER_AGENT`                                               | Override the User-Agent header                                                                   |

```ts
const client = AhaSendClient.fromEnv();
```

Cloudflare Workers expose environment bindings as the handler's `env` argument instead of
`process.env`. Pass that object explicitly; no `nodejs_compat` flag is needed:

```ts
interface Env {
  readonly [name: string]: string | undefined;
  AHASEND_API_KEY: string;
  AHASEND_ACCOUNT_ID: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const client = AhaSendClient.fromEnv(env);
    const result = await client.ping();
    return Response.json(result);
  },
};
```

`AHASEND_BASE_URL` takes precedence when it is set; `AHASEND_SCHEME` and
`AHASEND_HOST` are used only when it is absent. Environment-derived HTTP
endpoints are rejected unless `AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL`
parses as true. Leave this opt-in unset or false in production: it permits the
SDK to send the bearer API key over plaintext HTTP. All supported runtimes provide a built-in
`fetch`; inject another compatible implementation only when your deployment requires it.

`optionsFromEnv()` is also exported if you want the env-derived options
to compose with your own overrides (see `examples/telemetry.mjs`).

## Resources

| Resource                 | Methods                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `client.messages`        | `send`, `sendTemplate`, `sendConversation`, `list`, `iterate`, `get`, `cancel`                                                  |
| `client.templates`       | `list`, `iterate`, `get` (read-only transactional templates)                                                                    |
| `client.domains`         | `list`, `iterate`, `create`, `get`, `update`, `delete`, `checkDns`                                                              |
| `client.apiKeys`         | `list`, `iterate`, `create`, `get`, `update`, `delete`                                                                          |
| `client.webhooks`        | `list`, `iterate`, `create`, `get`, `update`, `delete` (account-scoped; limit to domains via `scope: "scoped"`)                 |
| `client.statistics`      | `deliverability`, `bounces`, `deliveryTimes`                                                                                    |
| `client.contacts`        | `list`, `iterate`, `create`, `batchUpsert`, `get`, `update`, `delete`, plus nested `lists`                                      |
| `client.contacts.lists`  | `list`, `iterate` (the lists one contact is on)                                                                                 |
| `client.lists`           | `list`, `iterate`, `create`, `get`, `update`, `delete`, plus nested `contacts`                                                  |
| `client.lists.contacts`  | `list`, `iterate`, `upsert`, `delete`, `batchAdd` (a list's members)                                                            |
| `client.suppressions`    | `list`, `iterate`, `create`, `delete`, `wipe`                                                                                   |
| `client.routes`          | `list`, `iterate`, `create`, `get`, `update`, `delete` (inbound routing)                                                        |
| `client.accounts`        | `get`, `update`, `listMembers`, `addMember`, `removeMember`                                                                     |
| `client.smtpCredentials` | `list`, `iterate`, `create`, `get`, `delete`                                                                                    |
| `client.subAccounts`     | `list`, `iterate`, `create`, `usage`, `get`, `update`, `delete`, `suspend`, `unsuspend`, `unpauseDomain`, plus nested `apiKeys` |
| `client.ping()`          | Health check (`GET /v2/ping`)                                                                                                   |

Every method carries JSDoc — hover in your editor for parameter
constraints, required scopes, and behavioural notes.
The generated
[API reference](https://github.com/AhaSend/ahasend-ts/blob/main/docs/api-reference.md) lists every
signature, scope, pagination contract, and resource-aware authorization rule.

## Request options

Every method accepts a trailing options object:

```ts
await client.messages.send(body, {
  signal: AbortSignal.timeout(5_000), // cancel/abort the request
  timeoutMs: 2_000, // override the timeout for each attempt in this call
  retry: { maxRetries: 1 }, // restrict this call's retry policy (or use false)
  headers: { "x-trace-id": traceId }, // extra headers for this call
  idempotencyKey: `receipt-${orderId}`, // create and batch operations only
});
```

| Field            | Applies to                  | Effect                                                        |
| ---------------- | --------------------------- | ------------------------------------------------------------- |
| `signal`         | all methods                 | `AbortSignal` — cancels the request (and any retry sleep)     |
| `timeoutMs`      | all methods                 | Per-attempt timeout override for fetch and response-body read |
| `retry`          | all methods                 | Disable or restrict the client retry policy for this call     |
| `headers`        | all methods                 | Additional request headers                                    |
| `idempotencyKey` | create and batch operations | Explicit idempotency key; otherwise one is auto-generated     |

## Cross-cutting behaviour

### Automatic idempotency

The SDK attaches a UUID `Idempotency-Key` to every **create and batch** operation
(all 15 endpoints whose generated operation profile marks them idempotent,
including message sends, resource creations, and the contact and list batches). The key is generated once per
call and reused across the SDK's internal retries. Stored outcomes — 2xx and
deterministic 4xx — are replayed for 24 hours, so a retry cannot duplicate them.
Server errors (5xx), handler failures, and panics are **not** stored: the API
releases the key and a retry re-executes the request, so a 5xx retry can still
result in a second send. See the
[retries and idempotency guide](https://github.com/AhaSend/ahasend-ts/blob/main/docs/retries-and-idempotency.md)
for the recovery guidance. Pass `options.idempotencyKey` to drive the key from your own
stable identifier — see `examples/idempotency.mjs`.

`generateIdempotencyKey(prefix?)` and `IdempotencyKeyBuilder` are exported for advanced key
management. `generateIdempotencyKey()` prepends its prefix literally, so include your own separator
(`"myapp-"`, not `"myapp"`). `IdempotencyKeyBuilder` instead inserts a hyphen between its base key
and each generated remainder or explicit suffix. See
[Retries and idempotency](https://github.com/AhaSend/ahasend-ts/blob/main/docs/retries-and-idempotency.md)
for retention windows, replay classification, and recovery after an uncertain result.

### Retries

When an operation's generated retry profile permits another attempt, the SDK
retries `408`, `429`, `5xx`, network failures, timeouts, and eligible keyed
`409` responses while an idempotent operation is still in progress — never
other 4xx. Key-protected create and batch operations require an idempotency key to be
retryable; the SDK supplies one unless automatic key generation is disabled.
A valid server `Retry-After` on 429 (seconds or HTTP-date) or an eligible keyed
409 (positive integer seconds) is authoritative and capped at the configured
`maxDelayMs` (30 seconds by default). Configure via the `retry` option;
`maxRetries: 3` means up to 4 total attempts for an eligible operation.
Per-call `options.retry` may be `false`, set `enabled: false`, or lower the configured numeric
limits. It cannot enable client-disabled retries, increase a numeric setting, or change the
configured strategy or jitter. Generated operation safety remains the final retry gate.

Caller aborts are terminal. Read
[Cancellation and timeouts](https://github.com/AhaSend/ahasend-ts/blob/main/docs/cancellation.md)
before combining local pacing, retries, and end-to-end deadlines.

### Rate limiting

An opt-in two-bucket token limiter (standard / statistics) paces requests
to the API's documented limits. Statistics calls are paced to 1 req/s, so
fan-out dashboards queue rather than 429. Waiting for a local token is
cancellable but happens before the per-network-attempt `timeoutMs` budget;
use a caller signal to impose an end-to-end deadline. Each configured burst
must be at least one token. Local bucket state does not rely on undocumented
remaining headers returned by the server. See
[Local rate pacing](https://github.com/AhaSend/ahasend-ts/blob/main/docs/rate-pacing.md).

### Telemetry

```ts
import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = new AhaSendClient({
  apiKey,
  accountId,
  hooks: {
    onRequest: () => metrics.increment("ahasend.request.started"),
    // onResponse fires only for 2xx; non-2xx attempts fire onError instead,
    // so a total completion count has to come from both hooks.
    onResponse: (e) => metrics.increment("ahasend.request.completed", { status: e.status }),
    onRetry: () => metrics.increment("ahasend.request.retried"),
    onError: (e) => {
      metrics.increment("ahasend.request.completed", { status: e.status ?? 0 });
      log.error("AhaSend request failed", {
        status: e.status,
        requestId: e.requestId,
        errorCode: isAhaSendError(e.error) ? e.error.code : "unknown",
      });
    },
  },
});
```

Events carry the generated `operationId` when known, method, unexpanded
`routeTemplate`, attempt number, duration, status, and the server's
`x-request-id` where applicable. They omit request URLs and expanded path
parameters, so query strings and caller identifiers are not exposed by default.
Hooks run asynchronously without delaying the request; synchronous throws and
returned-promise rejections are swallowed. `debug: true` adds a console hookset
on top of yours, but its error diagnostics can include error messages and do not
meet the strict output allowlist below.

Keep logs and diagnostics to aggregate counts, appropriate opaque object IDs,
HTTP status, SDK error code, request ID, and a webhook delivery attempt's
status codes, `classification`, and `command`. Never output message content,
subjects, recipients or other addresses, attachments, secrets, any whole objects
(including client, request, response, event, and error objects), or `err.message`.
Telemetry does not include expanded URLs, headers, or request bodies, but error
objects can contain server bodies and headers. Follow
[Safe logging and diagnostics](https://github.com/AhaSend/ahasend-ts/blob/main/docs/safe-logging.md)
instead of serializing errors wholesale.

### Pagination

```ts
// One page at a time
const page = await client.messages.list({ status: "Delivered", limit: 50 });
console.log({ deliveredPageCount: page.data.length });

// Or process everything — pages are fetched lazily
for await (const _message of client.messages.iterate({ status: "Delivered" })) {
  // Process each message without logging content, addresses, or whole objects.
}
```

## Webhook verification

`@ahasend/sdk/webhooks` is a separate import path bundling the
Standard-Webhooks compliant HMAC-SHA256 verifier, typed event parsers
for all 11 AhaSend event types, and adapters for Express, Fastify, and
Next.js. It does not pull in the API client.

> **Secret format:** AhaSend webhook secrets are raw strings. Pass the
> secret **exactly as the dashboard shows it** — including any
> `aha-whsec-` prefix. The SDK uses the literal UTF-8 bytes as the HMAC
> key; nothing is base64-decoded or stripped.

The verifier needs the **raw request body** — the exact bytes AhaSend
sent. If a JSON body parser runs first, signature verification is
impossible. The adapters treat an already-parsed body as a setup error:
Express passes it to `next`, Fastify returns an opaque 400 response, and
Next.js rejects it.

```ts
// Express 5.x — mount directly so the adapter reads and bounds the raw stream
import express from "express";
import { WebhookVerifier, expressWebhookHandler, isKnownWebhookEvent } from "@ahasend/sdk/webhooks";

const app = express();
const verifier = new WebhookVerifier(process.env.AHASEND_WEBHOOK_SECRET!);

app.post(
  "/webhooks/ahasend",
  expressWebhookHandler(verifier, async (event) => {
    if (!isKnownWebhookEvent(event)) return; // future event type — acknowledge & ignore
    switch (event.type) {
      case "message.delivered":
        metrics.increment("ahasend.webhook.delivered");
        break;
      case "message.bounced": {
        // Optional and often absent — see the replay-safety rule below before
        // performing side effects from a redeliverable event.
        const attempt = event.data.delivery_attempt;
        await suppress(event.data.recipient, attempt?.classification);
        break;
      }
    }
  }),
);
```

```ts
// Fastify (route must have rawBody enabled, e.g. fastify-raw-body)
import { fastifyWebhookHandler } from "@ahasend/sdk/webhooks";
fastify.post(
  "/webhooks/ahasend",
  fastifyWebhookHandler(verifier, async (event) => {}),
);

// Web-standard Request adapter (including Next.js app router and Vercel Edge)
import { nextRouteHandler } from "@ahasend/sdk/webhooks";
export const POST = nextRouteHandler(verifier, async (event) => {
  return new Response(null, { status: 200 });
});
```

Using the verifier directly (any framework):

```ts
await verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);
// Resolves only after the signature and timestamp have been verified.
```

To verify and parse the event in one awaited call:

```ts
const event = await verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
// rejects with AhaSendWebhookVerificationError on bad signature / stale timestamp / malformed payload
```

Use one of these direct forms for a request; `parse()` already performs verification. The existing
`nextRouteHandler` export is the web-standard `Request` adapter for Request/Response runtimes; it is
not a Node-only adapter.

Headers may be a plain record (`req.headers`) or anything with a case-insensitive
`Headers`-style `get`, matched structurally rather than by class — so a `Headers`
from a separately installed `undici`/`node-fetch`, an edge runtime, or another
realm works, as do express's `req` and Koa's `ctx.request`.

`parse()` returns a `Promise` that resolves to `AnyWebhookEvent`: the strict `WebhookEvent` union for
known types, plus an `UnknownWebhookEvent` branch so a new event type
added by the server doesn't crash your exhaustive `switch`. Narrow with
`isKnownWebhookEvent(event)`.

Timestamp checking does not deduplicate a valid delivery replayed inside the
accepted window. Your application must atomically commit each `webhook-id`
with durable processing work, then perform side effects idempotently from that
work. The
[security and webhooks guide](https://github.com/AhaSend/ahasend-ts/blob/main/docs/security-and-webhooks.md)
includes an Express 5.x integration pattern, body limits, adapter failure behavior, safe replay
handling, and how to read delivery diagnostics off a bounce.

Direct verification and every adapter enforce a fixed 30,000,000-byte webhook body ceiling.
Adapter option `maxBodyBytes` is only a lower deployment cap; it cannot raise that fixed ceiling.

## Operational guides

- [Retries and idempotency](https://github.com/AhaSend/ahasend-ts/blob/main/docs/retries-and-idempotency.md)
- [Cancellation and timeouts](https://github.com/AhaSend/ahasend-ts/blob/main/docs/cancellation.md)
- [Local rate pacing](https://github.com/AhaSend/ahasend-ts/blob/main/docs/rate-pacing.md)
- [Safe logging and diagnostics](https://github.com/AhaSend/ahasend-ts/blob/main/docs/safe-logging.md)
- [Security and webhooks](https://github.com/AhaSend/ahasend-ts/blob/main/docs/security-and-webhooks.md)
- [Subaccounts and child API keys](https://github.com/AhaSend/ahasend-ts/blob/main/docs/subaccounts.md)

## Error handling

Every non-2xx response throws a typed error:

```ts
import {
  AhaSendNotFoundError,
  AhaSendRateLimitError,
  AhaSendConnectionError,
  AhaSendAPIError,
} from "@ahasend/sdk";

try {
  await client.messages.get(messageId);
} catch (err) {
  if (err instanceof AhaSendNotFoundError) {
    // 404 — resource missing
  } else if (err instanceof AhaSendRateLimitError) {
    // 429 after retries exhausted; err.retryAfterSeconds has the server hint
  } else if (err instanceof AhaSendConnectionError) {
    // network failure / timeout (AhaSendTimeoutError subclass)
  } else if (err instanceof AhaSendAPIError) {
    // any other API error; err.status, err.body, err.requestId
  } else {
    throw err;
  }
}
```

Hierarchy:

```
AhaSendError
├── AhaSendAPIError                      (any non-2xx; .status .body .requestId .headers)
│   ├── AhaSendBadRequestError           400
│   ├── AhaSendAuthenticationError       401
│   ├── AhaSendPermissionError           403 (missing scope)
│   ├── AhaSendNotFoundError             404
│   ├── AhaSendConflictError             409
│   │   └── AhaSendIdempotencyConflictError    (replay in progress)
│   ├── AhaSendUnprocessableEntityError  422 (not a BadRequest subclass)
│   │   └── AhaSendIdempotencyMismatchError    (key reused with different body)
│   ├── AhaSendRateLimitError            429 (.retryAfterSeconds)
│   └── AhaSendServerError               5xx
├── AhaSendConnectionError               network failures
│   └── AhaSendTimeoutError              configured timeout elapsed
├── AhaSendAbortError                    caller aborted the operation
├── AhaSendConfigurationError            invalid options, environment, or body
├── AhaSendRateLimitQueueFullError       local pacing refused it (.category .maxQueue)
└── AhaSendResponseParseError            2xx with a non-JSON body
```

`AhaSendRateLimitQueueFullError` is local backpressure, not a server 429 — it is
raised only when `rateLimit.enabled` is set and the bucket already holds
`maxQueue` waiters. It is deliberately not retryable; see `docs/rate-pacing.md`.

`error.message` is derived, not verbatim. When it comes from a response body it
is whitespace-collapsed and capped at 200 characters, because a non-JSON body is
whatever sat in front of the API — an HTML error page would otherwise become the
whole message, repeated on every retry. The untruncated text stays on
`error.body`; match on `error.code` or `error.status` rather than on message
text. A response body larger than 30,000,000 bytes is abandoned mid-read with
`AhaSendResponseTooLargeError`, which is also not retryable — the bytes are
counted after decompression, so this bounds a compressed body that inflates.

`408/429/5xx/network/timeout` are retryable failures only when the operation's
generated profile permits retries. Operations classified as never retryable,
and key-protected operations called without a key, make one attempt even for
those failures. Other errors throw immediately.

## Examples

Example scripts and framework modules live in the
[`examples/` directory](https://github.com/AhaSend/ahasend-ts/tree/main/examples) — see its
[README](https://github.com/AhaSend/ahasend-ts/blob/main/examples/README.md) for setup and the
complete packed-verification inventory. Highlights: `send-sandbox.mjs` (send without delivering),
`iterate.mjs` (async pagination), `idempotency.mjs` (explicit keys),
`telemetry.mjs` (hooks), `error-handling.mjs` (typed errors),
`webhook-express.mjs` and `next-webhook-route.mjs` (framework endpoints with
application-owned webhook-id deduplication), `update-api-key-ip-list.mjs` and
`bootstrap-subaccount.mjs` (explicitly guarded mutations), and
`verify-webhook.mjs` (offline HMAC round-trip, no credentials needed).

## Verifying the SDK locally

```bash
git clone https://github.com/AhaSend/ahasend-ts.git
cd ahasend-ts
npm ci

npm run typecheck         # strict TS over src + tests
npm test                  # unit tests, fully offline
npm run test:coverage     # coverage with enforced thresholds
npm run test:integration:preflight  # builds, packs, and tests a disposable tarball with Prism
npm run build             # ESM + CJS + .d.ts/.d.cts
```

The spec-conformance suite (`tests/spec-conformance.test.ts`) parses the
repository's `openapi.yaml` and asserts every SDK method's HTTP verb and
path template exists in the spec — endpoint drift fails CI.

The integration preflight computes and verifies the disposable tarball's
SHA-256 checksum before installing it in a clean consumer. To test an existing
tarball directly, set `SDK_TARBALL` and `SDK_TARBALL_SHA256` and run
`npm run test:integration:tarball`. The default `npm run test:integration`
command runs the complete disposable-tarball preflight.

To exercise the examples without credentials, run a Prism mock from the
local spec:

```bash
npx --yes @stoplight/prism-cli@5.16.0 mock openapi.yaml -p 4010 --errors
# in another terminal:
export AHASEND_API_KEY="anything"
export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"
export AHASEND_BASE_URL="http://127.0.0.1:4010"
export AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL="true"
node examples/ping.mjs
```

## Development

```bash
npm run dev               # tsup in watch mode
npm run test:watch        # vitest watch
npm run lint              # eslint over src
npm run format            # prettier
```

### Changing a code sample

The Node samples embedded in `openapi.yaml` come from `scripts/node-code-samples.mjs`. After editing
one, run `npm run contracts:generate` to write it into `openapi.yaml`, then `npm run sdk:generate`
and `npm run docs:generate` to refresh `src/generated` and `docs/api-reference.md`, which both carry
the result.

## Support and security

Runtime support is defined by the maintained blocking inventory above. Browser-like environments
remain refused by default to keep bearer keys out of client-side bundles.

Use [GitHub issues](https://github.com/AhaSend/ahasend-ts/issues) for reproducible
SDK bugs and questions that do not contain secrets. Report vulnerabilities
privately according to the
[security policy](https://github.com/AhaSend/ahasend-ts/blob/main/SECURITY.md); do not include
credentials, message content, or webhook payloads in a public issue.

## Contact management contract

Contact operations require `contacts:read`, `contacts:write`, or `contacts:delete` as documented
for each operation. Writable attribute keys and their canonical types come from contact-attribute
definitions managed in the AhaSend dashboard; the API intentionally exposes no definition CRUD. A
contact created through the API is account-global and joins no list on its own, so a campaign
cannot reach it until it is added to a list (see below).

Pass a UUID or a raw email such as `User+Tag@Example.COM` to contact lookup, update, and delete
operations. The SDK percent-encodes that value exactly once as a URL path segment; do not pre-encode
it. Prefer setting `unsubscribed: true` over deleting a contact when the goal is to stop marketing
mail: unsubscribe is reversible and preserves history, while hard delete permanently removes the
contact, its unsubscribe record, memberships, campaign-recipient records, opens, and clicks.
Suppressions remain independent in either case.

Batch upsert accepts at most 1,000 contacts, but that cap is not a throughput target. Measure
end-to-end latency with representative data, wait for each synchronous batch response before
submitting the next, reduce batch size or pace requests when latency grows, and honor `429`
responses. The API makes no fixed throughput guarantee.

## List management contract

A list is a static, private, single opt-in container of contacts, and it is what a campaign
targets. List operations require `lists:read`, `lists:write`, or `lists:delete`. Adding, changing,
and removing a list's members all use `lists:write`, and reading members with
`include_contacts: true` also needs `contacts:read`; without it the call answers `403`.

```ts
const list = await client.lists.create({ name: "Product updates", tags: ["product"] });

const batch = await client.lists.contacts.batchAdd(list.id, {
  data: [{ email: "one@example.com" }, { id: "00000000-0000-4000-8000-000000000011" }],
});
// A 200 still carries per-entry failures: `batch.data` holds one result per entry, in order.
const failures = batch.data.filter(
  ({ outcome }) => outcome === "not_found" || outcome === "invalid",
);
console.log("List batch completed.", { failed: failures.length });

await client.lists.contacts.upsert(list.id, "User+Tag@Example.COM", {
  subscription_status: "unsubscribed",
});
```

- `contact_count` is the list's subscribers: the members a campaign to it would reach. A member
  counts when its membership is `confirmed` and the contact is enabled, not unsubscribed
  account-wide, and not found invalid by validation. The list embedded in a membership carries no
  `contact_count`.
- `batchAdd` takes 1–1,000 existing contacts, each named by exactly one of `email` or `id`, and
  answers `200` with one result per entry in input order: `added`, `already_member`, `not_found`,
  or `invalid` (the last two with a `reason`). It never creates a contact and never changes an
  existing membership, so it cannot undo an unsubscribe.
- Each membership carries its own `subscription_status` (`unconfirmed`, `confirmed`,
  `unsubscribed`, or `complained`), independent of the contact's account-wide `unsubscribed` flag.
  `upsert` with no body sends `{}`: a new membership is `confirmed`, and an existing one keeps the
  status it holds.
- To stop marketing mail on one list, upsert `subscription_status: "unsubscribed"`, which is
  reversible and keeps the record. `lists.contacts.delete` removes the membership and discards
  that record, so re-adding the contact later is silent. To stop mail everywhere, update the
  contact with `unsubscribed: true`.
- `complained` is the mailbox provider's verdict. It cannot be written, and a membership holding it
  is frozen: both `upsert` and `delete` on it answer `409` (`AhaSendConflictError`).
- Deleting a list keeps its memberships, so an unsubscribe survives it; a list that an unfinished
  campaign still needs answers `409`.
- Pass a UUID or a raw email wherever a contact is named; the SDK percent-encodes it exactly once.
  `client.contacts.lists.list(idOrEmail)` answers which lists one contact is on; it needs
  `lists:read`, not `contacts:read`.

## Send with a template

`client.messages.sendTemplate()` sends a transactional template. The template supplies the
subject, the preview text and both bodies, and its default sender and reply-to when it has them; a
`subject`, `from` or `reply_to` in the request replaces the template's. Values for the template's
variables come only from each recipient's `substitutions`.

```ts
const template = await client.templates.get("00000000-0000-4000-8000-000000000009");
const required = template.variables.filter((variable) => variable.required);
console.log("Template loaded.", { requiredCount: required.length });

const res = await client.messages.sendTemplate({
  template_id: template.id,
  from: { email: "sender@yourdomain.com", name: "Your App" },
  recipients: [
    { email: "ada@example.com", substitutions: { first_name: "Ada", product: "Example" } },
    { email: "grace@example.com", substitutions: { first_name: "Grace", product: "Example" } },
  ],
});
console.log("Template send accepted.", { count: res.data.length });
```

A template with a default sender can be sent without `from`:

```ts
const res = await client.messages.sendTemplate({
  template_id: "00000000-0000-4000-8000-000000000009",
  recipients: [{ email: "ada@example.com", substitutions: { first_name: "Ada" } }],
});
console.log("Template send accepted.", { count: res.data.length });
```

- `client.templates.list()` and `iterate()` page through the account's transactional templates,
  newest first; `get()` returns one with the `variables` its design uses, its default sender in
  `from` and its default `reply_to`, each an `Address` or `null` when it has none.
- `from` is required unless the template has a default sender. The template's sender is checked
  exactly like a `from` in the request: a domain that is not the account's, has invalid DNS records
  or is paused fails the send with the same error. A request without a sender from an API key that
  cannot send from any domain answers `403`.
- `subject` is required unless the template has a subject.
- Every variable marked `required` must have a value in every recipient's `substitutions`. A
  request that misses one is refused as a whole, and nothing is sent.
- The request takes no body and no request-level `substitutions`: the API answers `400` to
  `text_content`, `html_content`, `amp_content` or `substitutions`.
- `email` and `view_browser_url` are supplied by AhaSend for each recipient and cannot be
  overridden: `email` is that recipient's address, and `view_browser_url` is empty until a hosted
  view of a sent message exists.
- `unsubscribe_url` is supplied the same way, replacing a value of your own, only on a design that
  uses it; such a message also carries one-click `List-Unsubscribe` headers, and a
  `List-Unsubscribe` or `List-Unsubscribe-Post` in `headers` is dropped. On a design that does not
  use it, nothing is minted and your value passes through like any other name the template does
  not use.
- A `template_id` that does not name one of the account's transactional templates answers `404`
  (`AhaSendNotFoundError`). Reading templates needs `templates:read`; sending one needs only the
  usual send scope.

## Domain sending type and pauses

Every domain has a `sending_type`, `transactional` or `marketing`, which affects its
deliverability: marketing email sent from a transactional domain can get the account paused.
`domains.create()` makes a transactional domain unless you pass `sending_type`, and
`domains.update()` leaves the type unchanged unless you pass it; a change applies to new messages
within five minutes. `domains.list()` and `iterate()` filter on it:

```ts
const created = await client.domains.create({
  domain: "news.example.com",
  sending_type: "marketing",
});
console.log("Marketing domain created.", { id: created.id });

const page = await client.domains.list({ sending_type: "marketing" });
// pause_reason is an open set: bounce_rate today, possibly more later.
const paused = page.data.filter((domain) => domain.paused);
console.log("Marketing domains listed.", { pausedCount: paused.length });
```

- AhaSend can pause sending from one domain while the account's other domains keep sending.
  `paused` is then `true`, `paused_at` says when, and `pause_reason` says why. `bounce_rate` means
  too many recent emails from the domain bounced; treat any other value as a reason added after
  this release. While a domain is paused, a send from it answers `403` (`AhaSendPermissionError`;
  a sandbox send is still accepted), and so does deleting it.
- A parent account lifts the pause on a sub-account's domain with
  `client.subAccounts.unpauseDomain(subAccountId, domain)`, which needs `sub-accounts:suspend` and
  returns the domain. It is idempotent: a domain that is not paused is returned unchanged. The
  change can take some minutes to apply to new email, and the call is not retried automatically.
- `subAccounts.suspend()` and `unsuspend()` pause and resume a whole sub-account. A paused
  sub-account has `status: "suspended"`.

## License

[MIT](https://github.com/AhaSend/ahasend-ts/blob/main/LICENSE)
