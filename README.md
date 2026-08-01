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

- **Node.js 22 or later.** Browsers and edge runtimes (Cloudflare Workers,
  Vercel Edge, Deno without Node compatibility) are not supported — the SDK
  uses `node:crypto` and `node:buffer`.
- An [AhaSend account](https://dashboard.ahasend.com), an API key
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
  apiKey: "aha-sk-…", // required
  accountId: "uuid", // required — one client per account
  baseUrl: "https://api.ahasend.com", // HTTPS enforced (localhost exempt)
  timeoutMs: 30_000, // default per-attempt timeout in MILLISECONDS
  userAgent: "ahasend-node/x.y.z",
  debug: false, // true = log every request to stderr
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
    standard: { requestsPerSecond: 100, burst: 200 },
    statistics: { requestsPerSecond: 1, burst: 1 },
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
| `AHASEND_TIMEOUT`                                                  | Request timeout in **seconds** (note: the constructor option `timeoutMs` is in **milliseconds**) |
| `AHASEND_MAX_RETRIES`                                              | Retry attempts                                                                                   |
| `AHASEND_ENABLE_RATE_LIMIT`                                        | Master rate-limit switch                                                                         |
| `AHASEND_IDEMPOTENCY_AUTO_GENERATE` / `AHASEND_IDEMPOTENCY_PREFIX` | Idempotency behaviour                                                                            |
| `AHASEND_DEBUG`                                                    | Console diagnostics                                                                              |
| `AHASEND_USER_AGENT`                                               | Override the User-Agent header                                                                   |

```ts
const client = AhaSendClient.fromEnv();
```

`optionsFromEnv()` is also exported if you want the env-derived options
to compose with your own overrides (see `examples/telemetry.mjs`).

## Resources

| Resource                 | Methods                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `client.messages`        | `send`, `sendConversation`, `list`, `iterate`, `get`, `cancel`                                                  |
| `client.domains`         | `list`, `iterate`, `create`, `get`, `update`, `delete`, `checkDns`                                              |
| `client.apiKeys`         | `list`, `iterate`, `create`, `get`, `update`, `delete`                                                          |
| `client.webhooks`        | `list`, `iterate`, `create`, `get`, `update`, `delete` (account-scoped; limit to domains via `scope: "scoped"`) |
| `client.statistics`      | `deliverability`, `bounces`, `deliveryTimes`                                                                    |
| `client.suppressions`    | `list`, `iterate`, `create`, `delete`, `wipe`                                                                   |
| `client.routes`          | `list`, `iterate`, `create`, `get`, `update`, `delete` (inbound routing)                                        |
| `client.accounts`        | `get`, `update`, `listMembers`, `addMember`, `removeMember`                                                     |
| `client.smtpCredentials` | `list`, `iterate`, `create`, `get`, `delete`                                                                    |
| `client.subAccounts`     | `list`, `iterate`, `create`, `usage`, `get`, `update`, `delete`, `suspend`, `unsuspend`, plus nested `apiKeys`  |
| `client.ping()`          | Health check (`GET /v2/ping`)                                                                                   |

Every method carries JSDoc — hover in your editor for parameter
constraints, required scopes, and behavioural notes.
The generated [API reference](docs/api-reference.md) lists every signature, scope, pagination
contract, and resource-aware authorization rule.

## Request options

Every method accepts a trailing options object:

```ts
await client.messages.send(body, {
  signal: AbortSignal.timeout(5_000), // cancel/abort the request
  timeoutMs: 2_000, // override the timeout for each attempt in this call
  retry: { maxRetries: 1 }, // restrict this call's retry policy (or use false)
  headers: { "x-trace-id": traceId }, // extra headers for this call
  idempotencyKey: `receipt-${orderId}`, // create operations only
});
```

| Field            | Applies to        | Effect                                                        |
| ---------------- | ----------------- | ------------------------------------------------------------- |
| `signal`         | all methods       | `AbortSignal` — cancels the request (and any retry sleep)     |
| `timeoutMs`      | all methods       | Per-attempt timeout override for fetch and response-body read |
| `retry`          | all methods       | Disable or restrict the client retry policy for this call     |
| `headers`        | all methods       | Additional request headers                                    |
| `idempotencyKey` | create operations | Explicit idempotency key; otherwise one is auto-generated     |

## Cross-cutting behaviour

### Automatic idempotency

The SDK attaches a UUID `Idempotency-Key` to every **create** operation
(all 11 endpoints whose generated operation profile marks them idempotent,
including message sends and resource creations). The key is generated once per
call and reused across the SDK's internal retries, so transient failures can
never double-send. Pass `options.idempotencyKey` to drive the key from your own
stable identifier — see `examples/idempotency.mjs`.

`generateIdempotencyKey(prefix?)` and `IdempotencyKeyBuilder` are
exported for advanced key management. Note the prefix is prepended
literally — include your own separator (`"myapp-"`, not `"myapp"`).
See [Retries and idempotency](docs/retries-and-idempotency.md) for retention windows, replay
classification, and recovery after an uncertain result.

### Retries

When an operation's generated retry profile permits another attempt, the SDK
retries `408`, `429`, `5xx`, network failures, timeouts, and eligible keyed
`409` responses while an idempotent operation is still in progress — never
other 4xx. Key-protected create operations require an idempotency key to be
retryable; the SDK supplies one unless automatic key generation is disabled.
A valid server `Retry-After` on 429 (seconds or HTTP-date) or an eligible keyed
409 (positive integer seconds) is authoritative and capped at the configured
`maxDelayMs` (30 seconds by default). Configure via the `retry` option;
`maxRetries: 3` means up to 4 total attempts for an eligible operation.
Per-call `options.retry` may be `false`, set `enabled: false`, or lower the configured numeric
limits. It cannot enable client-disabled retries, increase a numeric setting, or change the
configured strategy or jitter. Generated operation safety remains the final retry gate.

Caller aborts are terminal. Read [Cancellation and timeouts](docs/cancellation.md) before
combining local pacing, retries, and end-to-end deadlines.

### Rate limiting

An opt-in two-bucket token limiter (standard / statistics) paces requests
to the API's documented limits. Statistics calls are paced to 1 req/s, so
fan-out dashboards queue rather than 429. Waiting for a local token is
cancellable but happens before the per-network-attempt `timeoutMs` budget;
use a caller signal to impose an end-to-end deadline. Each configured burst
must be at least one token. Local bucket state does not rely on undocumented
remaining headers returned by the server. See [Local rate pacing](docs/rate-pacing.md).

### Telemetry

```ts
import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = new AhaSendClient({
  apiKey,
  accountId,
  hooks: {
    onRequest: (e) => log.debug(`→ ${e.method} ${e.routeTemplate}`),
    onResponse: (e) => metrics.timing("ahasend.request", e.durationMs, { status: e.status }),
    onRetry: (e) => log.warn(`retrying ${e.routeTemplate} in ${e.delayMs}ms`),
    onError: (e) =>
      log.error("AhaSend request failed", {
        operationId: e.operationId,
        status: e.status,
        requestId: e.requestId,
        errorCode: isAhaSendError(e.error) ? e.error.code : "unknown",
      }),
  },
});
```

Events carry the generated `operationId` when known, method, unexpanded
`routeTemplate`, attempt number, duration, status, and the server's
`x-request-id` where applicable. They omit request URLs and expanded path
parameters, so query strings and caller identifiers are not exposed by default.
Hooks run asynchronously without delaying the request; synchronous throws and
returned-promise rejections are swallowed. `debug: true` adds a console hookset
on top of yours.

Telemetry does not include expanded URLs, headers, or request bodies, but error
objects can contain server bodies and headers. Follow [Safe logging and
diagnostics](docs/safe-logging.md) instead of serializing errors wholesale.

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
fastify.post(
  "/webhooks/ahasend",
  fastifyWebhookHandler(verifier, async (event) => {}),
);

// Next.js (app router)
import { nextRouteHandler } from "@ahasend/sdk/webhooks";
export const POST = nextRouteHandler(verifier, async (event) => {
  return new Response(null, { status: 200 });
});
```

Using the verifier directly (any framework):

```ts
const event = verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
// throws AhaSendWebhookVerificationError on bad signature / stale timestamp / malformed payload
```

`parse()` returns `AnyWebhookEvent`: the strict `WebhookEvent` union for
known types, plus an `UnknownWebhookEvent` branch so a new event type
added by the server doesn't crash your exhaustive `switch`. Narrow with
`isKnownWebhookEvent(event)`.

Timestamp checking does not deduplicate a valid delivery replayed inside the
accepted window. Your application must atomically commit each `webhook-id`
with durable processing work, then perform side effects idempotently from that
work. The [security and webhooks guide](docs/security-and-webhooks.md) includes
an Express 5.x integration pattern, body limits, adapter failure behavior, and
safe replay handling.

## Operational guides

- [Retries and idempotency](docs/retries-and-idempotency.md)
- [Cancellation and timeouts](docs/cancellation.md)
- [Local rate pacing](docs/rate-pacing.md)
- [Safe logging and diagnostics](docs/safe-logging.md)
- [Security and webhooks](docs/security-and-webhooks.md)
- [Subaccounts and child API keys](docs/subaccounts.md)

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
├── AhaSendConfigurationError            invalid SDK options or environment
└── AhaSendResponseParseError            2xx with a non-JSON body
```

`408/429/5xx/network/timeout` are retryable failures only when the operation's
generated profile permits retries. Operations classified as never retryable,
and key-protected operations called without a key, make one attempt even for
those failures. Other errors throw immediately.

## Examples

Runnable scripts live in [`examples/`](examples/) — see its README for
setup. Highlights: `send-sandbox.mjs` (send without delivering),
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
npm install

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

## Support and security

Node.js 22 and 24 are blocking CI targets. Newer Node releases may be tested on
a best-effort basis before they become a blocking support target. Browsers,
service workers, edge runtimes, and alternative JavaScript runtimes are not
supported.

Use [GitHub issues](https://github.com/AhaSend/ahasend-ts/issues) for reproducible
SDK bugs and questions that do not contain secrets. Report vulnerabilities
privately according to [SECURITY.md](SECURITY.md); do not include credentials,
message content, or webhook payloads in a public issue.

## License

[MIT](LICENSE)
