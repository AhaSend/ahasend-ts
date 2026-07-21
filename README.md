# AhaSend Node.js SDK

The official Node.js TypeScript SDK for the [AhaSend](https://ahasend.com) transactional email API.

> **v0.x** — the public API may change before 1.0. Pin an exact version in
> production and read the [CHANGELOG](CHANGELOG.md) before upgrading.

> ⚠️ **This is a server-side SDK for Node.js.** The AhaSend API key must
> not be embedded in a browser bundle — anyone with the key can send mail
> on your account's behalf. The constructor throws if it detects a
> browser-like environment (`window`, `document`, or a Service Worker
> scope).

## Requirements

- **Node.js 18 or later.** Browsers and edge runtimes (Cloudflare Workers,
  Vercel Edge, Deno without Node compatibility) are not supported — the SDK
  uses `node:crypto` and `node:buffer`.
- An [AhaSend account](https://dashboard.ahasend.com), an API key
  (`aha-sk-…`), and an account ID.

## Installation

```bash
npm install @ahasend/sdk
```

Until the package is published to npm, install from the repository:

```bash
npm install github:AhaSend/ahasend-ts
```

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

console.log(res.data[0]?.status); // "queued"
```

### Configuration

Every option, with its default:

```ts
const client = new AhaSendClient({
  apiKey: "aha-sk-…",                 // required
  accountId: "uuid",                  // required — one client per account
  baseUrl: "https://api.ahasend.com", // HTTPS enforced (localhost exempt)
  timeoutMs: 30_000,                  // per-request timeout in MILLISECONDS
  userAgent: "ahasend-node/x.y.z",
  debug: false,                       // true = log every request to stderr
  fetch: globalThis.fetch,            // inject your own fetch if needed
  defaultHeaders: {},
  idempotency: { autoGenerate: true, prefix: "" },
  retry: {
    enabled: true,
    maxRetries: 3,                    // 3 retries = up to 4 total attempts
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    strategy: "exponential",          // "exponential" | "linear" | "constant"
    jitter: true,
  },
  rateLimit: {
    enabled: true,
    general:     { requestsPerSecond: 100, burst: 200 },
    statistics:  { requestsPerSecond: 1,   burst: 1   },
    sendMessage: { requestsPerSecond: 100, burst: 200 },
  },
  hooks: {},                          // telemetry — see below
});
```

### Environment variables

`AhaSendClient.fromEnv()` builds a client from the same variables the
official Go SDK reads:

| Variable | Meaning |
| --- | --- |
| `AHASEND_API_KEY` / `AHASEND_TOKEN` | API key (either name works) |
| `AHASEND_ACCOUNT_ID` | Account UUID |
| `AHASEND_BASE_URL` (or `AHASEND_SCHEME` + `AHASEND_HOST`) | API endpoint |
| `AHASEND_TIMEOUT` | Request timeout in **seconds** (note: the constructor option `timeoutMs` is in **milliseconds**) |
| `AHASEND_MAX_RETRIES` | Retry attempts |
| `AHASEND_ENABLE_RATE_LIMIT` | Master rate-limit switch |
| `AHASEND_IDEMPOTENCY_AUTO_GENERATE` / `AHASEND_IDEMPOTENCY_PREFIX` | Idempotency behaviour |
| `AHASEND_DEBUG` | Console diagnostics |
| `AHASEND_USER_AGENT` | Override the User-Agent header |

```ts
const client = AhaSendClient.fromEnv();
```

`optionsFromEnv()` is also exported if you want the env-derived options
to compose with your own overrides (see `examples/telemetry.mjs`).

## Resources

| Resource | Methods |
| --- | --- |
| `client.messages` | `send`, `sendConversation`, `list`, `iterate`, `get`, `cancel` |
| `client.domains` | `list`, `iterate`, `create`, `get`, `update`, `delete`, `checkDns` |
| `client.apiKeys` | `list`, `iterate`, `create`, `get`, `update`, `delete` |
| `client.webhooks` | `list`, `iterate`, `create`, `get`, `update`, `delete` (account-scoped; limit to domains via `scope: "scoped"`) |
| `client.statistics` | `deliverability`, `bounces`, `deliveryTimes` |
| `client.suppressions` | `list`, `iterate`, `create`, `delete`, `wipe` |
| `client.routes` | `list`, `iterate`, `create`, `get`, `update`, `delete` (inbound routing) |
| `client.accounts` | `get`, `update`, `listMembers`, `addMember`, `removeMember` |
| `client.smtpCredentials` | `list`, `iterate`, `create`, `get`, `delete` |
| `client.ping()` | Health check (`GET /v2/ping`) |

Every method carries JSDoc — hover in your editor for parameter
constraints, required scopes, and behavioural notes.

## Request options

Every method accepts a trailing options object:

```ts
await client.messages.send(body, {
  signal: AbortSignal.timeout(5_000),   // cancel/abort the request
  headers: { "x-trace-id": traceId },   // extra headers for this call
  idempotencyKey: `receipt-${orderId}`, // create operations only
});
```

| Field | Applies to | Effect |
| --- | --- | --- |
| `signal` | all methods | `AbortSignal` — cancels the request (and any retry sleep) |
| `headers` | all methods | Additional request headers |
| `idempotencyKey` | create operations | Explicit idempotency key; otherwise one is auto-generated |

## Cross-cutting behaviour

### Automatic idempotency

The SDK attaches a UUID `Idempotency-Key` to every **create** operation
(the nine endpoints the API documents as idempotent: message sends and
all resource creations). The key is generated once per call and reused
across the SDK's internal retries, so transient failures can never
double-send. Pass `options.idempotencyKey` to drive the key from your
own stable identifier — see `examples/idempotency.mjs`.

`generateIdempotencyKey(prefix?)` and `IdempotencyKeyBuilder` are
exported for advanced key management. Note the prefix is prepended
literally — include your own separator (`"myapp-"`, not `"myapp"`).

### Retries

Automatic on `408`, `429`, `5xx`, network failures, and timeouts —
never on other 4xx. The server's `Retry-After` (seconds or HTTP-date)
is honoured in full, capped at one hour. Configure via the `retry`
option; `maxRetries: 3` means up to 4 total attempts.

### Rate limiting

A three-bucket token limiter (general / statistics / send-message)
paces requests to the API's documented limits, and reconciles each
bucket against the server's `X-RateLimit-Remaining` header on every
response. Statistics calls are paced to 1 req/s — fan-out dashboards
queue rather than 429.

### Telemetry

```ts
const client = new AhaSendClient({
  apiKey, accountId,
  hooks: {
    onRequest:  (e) => log.debug(`→ ${e.method} ${e.path}`),
    onResponse: (e) => metrics.timing("ahasend.request", e.durationMs, { status: e.status }),
    onRetry:    (e) => log.warn(`retrying ${e.path} in ${e.delayMs}ms`),
    onError:    (e) => sentry.captureException(e.error),
  },
});
```

Events carry the method, path, URL, attempt number, duration, status,
and the server's `x-request-id`. Hooks that throw are swallowed — they
can never break a request. `debug: true` adds a console hookset on top
of yours.

### Pagination

```ts
// One page at a time
const page = await client.messages.list({ status: "Delivered", limit: 50 });
console.log(page.data, page.pagination.has_more);

// Or iterate everything — pages are fetched lazily
for await (const msg of client.messages.iterate({ status: "Delivered" })) {
  console.log(msg.subject);
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
impossible (the adapters detect this and return 400 instead of hanging).

```ts
// Express — mount express.raw() on the webhook route
import express from "express";
import { WebhookVerifier, expressWebhookHandler, isKnownWebhookEvent } from "@ahasend/sdk/webhooks";

const verifier = new WebhookVerifier(process.env.AHASEND_WEBHOOK_SECRET!);

app.post(
  "/webhooks/ahasend",
  express.raw({ type: "*/*" }),
  expressWebhookHandler(verifier, async (event) => {
    if (!isKnownWebhookEvent(event)) return; // future event type — acknowledge & ignore
    switch (event.type) {
      case "message.delivered":
        console.log(`delivered → ${event.data.recipient}`);
        break;
      case "message.bounced":
        // ...
        break;
    }
  }),
);
```

```ts
// Fastify (route must have rawBody enabled, e.g. fastify-raw-body)
import { fastifyWebhookHandler } from "@ahasend/sdk/webhooks";
fastify.post("/webhooks/ahasend", fastifyWebhookHandler(verifier, async (event) => {}));

// Next.js (app router)
import { nextRouteHandler } from "@ahasend/sdk/webhooks";
export const POST = nextRouteHandler(verifier, async (event) => {
  return new Response(null, { status: 200 });
});
```

Using the verifier directly (any framework):

```ts
const event = verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
// throws AhaSendWebhookVerificationError on bad signature / replay / malformed payload
```

`parse()` returns `AnyWebhookEvent`: the strict `WebhookEvent` union for
known types, plus an `UnknownWebhookEvent` branch so a new event type
added by the server doesn't crash your exhaustive `switch`. Narrow with
`isKnownWebhookEvent(event)`.

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
│   ├── AhaSendIdempotencyPreconditionFailedError  412
│   ├── AhaSendUnprocessableEntityError  422 (not a BadRequest subclass)
│   │   └── AhaSendIdempotencyMismatchError    (key reused with different body)
│   ├── AhaSendRateLimitError            429 (.retryAfterSeconds)
│   └── AhaSendServerError               5xx
├── AhaSendConnectionError               network failures
│   └── AhaSendTimeoutError              configured timeout elapsed
└── AhaSendResponseParseError            2xx with a non-JSON body
```

`408/429/5xx/network/timeout` are retried automatically; everything else
throws immediately.

## Examples

Runnable scripts live in [`examples/`](examples/) — see its README for
setup. Highlights: `send-sandbox.mjs` (send without delivering),
`iterate.mjs` (async pagination), `idempotency.mjs` (explicit keys),
`telemetry.mjs` (hooks), `error-handling.mjs` (typed errors),
`webhook-express.mjs` (full Express endpoint), `verify-webhook.mjs`
(offline HMAC round-trip, no credentials needed).

## Verifying the SDK locally

```bash
git clone https://github.com/AhaSend/ahasend-ts.git
cd ahasend-ts
npm install

npm run typecheck         # strict TS over src + tests
npm test                  # unit tests, fully offline
npm run test:coverage     # coverage with enforced thresholds
RUN_INTEGRATION=1 npm run test:integration  # spawns a Prism mock from the local openapi.yaml
npm run build             # ESM + CJS + .d.ts/.d.cts
```

The spec-conformance suite (`tests/spec-conformance.test.ts`) parses the
repository's `openapi.yaml` and asserts every SDK method's HTTP verb and
path template exists in the spec — endpoint drift fails CI.

To exercise the examples without credentials, run a Prism mock from the
local spec:

```bash
npx -y @stoplight/prism-cli@5 mock openapi.yaml -p 4010
# in another terminal:
export AHASEND_API_KEY="anything"
export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"
export AHASEND_BASE_URL="http://127.0.0.1:4010"
node examples/ping.mjs
```

## Development

```bash
npm run dev               # tsup in watch mode
npm run test:watch        # vitest watch
npm run lint              # eslint over src
npm run format            # prettier
```

## License

[MIT](LICENSE)
