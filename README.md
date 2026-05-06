# AhaSend Node.js SDK

The official Node.js TypeScript SDK for the [AhaSend](https://ahasend.com) transactional email API.

> **Status:** Phase 2 complete — all nine resource groups, automatic
> idempotency, retries with backoff, rate limiting, and Standard-Webhooks
> compliant signature verification. Comprehensive documentation, expanded
> integration tests, and final npm-publication polish land in Phase 3.

## Requirements

- **Node.js** 18 or later
- An [AhaSend account](https://dashboard.ahasend.com), an API key (`aha-sk-…`),
  and an account ID

## Installation

> The package is not yet on npm; install directly from the repository while
> Phase 1 is under review.

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

// Send an email
const res = await client.messages.send({
  from: { email: "sender@yourdomain.com", name: "Your App" },
  recipients: [{ email: "to@example.com" }],
  subject: "Hello",
  html_content: "<h1>Hi there</h1>",
  text_content: "Hi there",
});

console.log(res.data[0]?.id, res.data[0]?.status);
```

### Configuration via environment variables

`AhaSendClient.fromEnv()` reads every variable supported by the official Go
SDK (`AHASEND_API_KEY`, `AHASEND_TOKEN`, `AHASEND_ACCOUNT_ID`,
`AHASEND_BASE_URL`, `AHASEND_HOST`, `AHASEND_SCHEME`, `AHASEND_USER_AGENT`,
`AHASEND_DEBUG`, `AHASEND_TIMEOUT`).

```ts
const client = AhaSendClient.fromEnv();
```

## Resources

| Resource                  | Methods                                                                          |
| ------------------------- | -------------------------------------------------------------------------------- |
| `client.messages`         | `send`, `sendConversation`, `list`, `get`, `cancel`                              |
| `client.domains`          | `list`, `create`, `get`, `update`, `delete`, `checkDns`                          |
| `client.apiKeys`          | `list`, `create`, `get`, `update`, `delete`                                      |
| `client.webhooks`         | `list`, `create`, `get`, `update`, `delete` (domain-scoped subscriptions)        |
| `client.statistics`       | `deliverability`, `bounces`, `deliveryTimes`                                     |
| `client.suppressions`     | `list`, `create`, `delete`, `wipe`                                               |
| `client.routes`           | `list`, `create`, `get`, `update`, `delete` (inbound routing)                    |
| `client.accounts`         | `get`, `update`, `listMembers`, `addMember`, `updateMember`, `removeMember`      |
| `client.smtpCredentials`  | `list`, `create`, `get`, `delete`                                                |
| `client.ping()`           | Utility health-check (`GET /v2/ping`)                                            |

### Cross-cutting features

- **Automatic idempotency** — the SDK generates a UUID `Idempotency-Key`
  header for every `POST` (configurable via `idempotency.autoGenerate` and
  `idempotency.prefix`, or env vars `AHASEND_IDEMPOTENCY_AUTO_GENERATE` and
  `AHASEND_IDEMPOTENCY_PREFIX`). Helpers `generateIdempotencyKey()` and
  `IdempotencyKeyBuilder` are also exported.
- **Retries with backoff** — automatic on `429`, `5xx`, network failures,
  and timeouts. Exponential / linear / constant strategies with jitter.
  Honours `Retry-After`. Reuses the same idempotency key across retries
  to prevent duplicate operations. Configurable via `retry` option or
  `AHASEND_MAX_RETRIES` env var.
- **Intelligent rate limiting** — three-category token bucket matching the
  Go SDK: `sendMessage` (100rps / 200 burst), `statistics` (1rps / 1 burst),
  `general` (100rps / 200 burst). Auto-detected by HTTP method and path.
  Reads `X-RateLimit-Remaining` (or `RateLimit-Remaining`) on every response
  and reconciles the bucket to match the server's reported quota.
  Toggleable via `rateLimit.enabled` or `AHASEND_ENABLE_RATE_LIMIT`.
- **Telemetry hooks** — pluggable `onRequest`, `onResponse`, `onRetry`, and
  `onError` callbacks for logging, metrics, and tracing. `debug: true`
  attaches a console-based hookset on top of any user hooks. Hooks that
  throw never break the request pipeline.
- **Async pagination iterators** — every paginating resource exposes
  `iterate(params)` that yields one item at a time and walks all pages
  automatically: `for await (const msg of client.messages.iterate({ status: "queued" })) { ... }`.
  A `collect(fetchPage, params, limit?)` helper drains pages into an array.

### Webhook verification

`@ahasend/sdk/webhooks` is a separate import path that bundles the
Standard-Webhooks compliant HMAC-SHA256 verifier, typed event parsers
for all 11 AhaSend event types, and ready-made adapters for Express,
Fastify, and Next.js. It does not pull in the API client.

```ts
import { WebhookVerifier } from "@ahasend/sdk/webhooks";

const verifier = new WebhookVerifier(process.env.AHASEND_WEBHOOK_SECRET!);

export async function handler(req, res) {
  const rawBody = await readRawBody(req);
  try {
    const event = verifier.parse(req.headers, rawBody);
    if (event.type === "message.delivered") {
      // typed payload — event.data.recipient, .subject, etc.
    }
    res.status(200).end();
  } catch (err) {
    res.status(400).end();
  }
}
```

#### Framework adapters

```ts
// Express
import { expressWebhookHandler } from "@ahasend/sdk/webhooks";
app.post("/webhooks/ahasend", expressWebhookHandler(verifier, async (event) => {
  // event is fully typed and discriminated
}));

// Fastify (route must have rawBody enabled)
import { fastifyWebhookHandler } from "@ahasend/sdk/webhooks";
fastify.post("/webhooks/ahasend", fastifyWebhookHandler(verifier, async (event) => {}));

// Next.js (app router)
import { nextRouteHandler } from "@ahasend/sdk/webhooks";
export const POST = nextRouteHandler(verifier, async (event) => {
  return new Response(null, { status: 200 });
});
```

## Error handling

Every non-2xx response is thrown as a typed error.

```ts
import { AhaSendAuthenticationError, AhaSendNotFoundError } from "@ahasend/sdk";

try {
  await client.messages.get("does-not-exist");
} catch (err) {
  if (err instanceof AhaSendNotFoundError) {
    // 404 - handle missing resource
  } else if (err instanceof AhaSendAuthenticationError) {
    // 401 - invalid or missing API key
  } else {
    throw err;
  }
}
```

The full hierarchy: `AhaSendError` → `AhaSendAPIError` →
{`AhaSendAuthenticationError`, `AhaSendPermissionError`,
`AhaSendNotFoundError`, `AhaSendBadRequestError`, `AhaSendRateLimitError`,
`AhaSendServerError`} and `AhaSendError` → `AhaSendConnectionError` →
`AhaSendTimeoutError`.

## Verifying the SDK locally

The repository ships with three independent ways to verify Phase 1.

### 1. Static checks

```bash
git clone https://github.com/AhaSend/ahasend-ts.git
cd ahasend-ts
npm install

npm run typecheck   # strict TypeScript, clean
npm test            # 48 unit tests
npm run build       # produces dist/ (ESM + CJS + .d.ts)
```

### 2. Against a Prism mock — no credentials needed

Drives the SDK against a Prism mock server backed by the public AhaSend
OpenAPI specification.

In one terminal:

```bash
npx -y @stoplight/prism-cli@5 mock \
  https://raw.githubusercontent.com/AhaSend/ahasend-go/main/openapi/openapi.yaml \
  -p 4010
```

In another:

```bash
npm run build

export AHASEND_API_KEY="anything"
export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"
export AHASEND_BASE_URL="http://127.0.0.1:4010"

node examples/ping.mjs
node examples/list-domains.mjs
node examples/list-api-keys.mjs
node examples/send-sandbox.mjs
node examples/list-suppressions.mjs
node examples/list-routes.mjs
node examples/get-account.mjs
node examples/statistics.mjs
node examples/verify-webhook.mjs
```

Each script prints a `✓` line with a parsed, typed response — proving URL
construction, the bearer header, query and body serialization, and JSON
response parsing all match the spec. `verify-webhook.mjs` runs without a
mock server: it signs a payload locally and confirms the verifier accepts
the valid signature and rejects a tampered body.

### 3. Against the live AhaSend API

Uses your real credentials. The first three are read-only; the fourth uses
sandbox mode so no email is actually delivered.

```bash
export AHASEND_API_KEY="aha-sk-your-real-key"
export AHASEND_ACCOUNT_ID="your-real-account-uuid"
unset AHASEND_BASE_URL

node examples/ping.mjs               # auth check
node examples/list-domains.mjs       # read-only
node examples/list-api-keys.mjs      # read-only
node examples/send-sandbox.mjs       # sandbox send (no real email leaves)
```

## Build, test, and develop

```bash
npm install
npm run dev               # tsup in watch mode
npm run typecheck         # tsc --noEmit
npm test                  # vitest run — unit + integration
npm run test:unit         # unit tests only (no Prism spawn)
npm run test:integration  # programmatic Prism mock + SDK end-to-end
npm run test:watch        # vitest watch
npm run test:coverage     # coverage report (thresholds enforced)
npm run build             # one-shot ESM + CJS + types build
```

The integration suite spawns a Prism mock server, drives the SDK through
all nine resource groups, and tears the server back down — so a fresh
clone with `npm install && npm test` exercises the entire surface end-to-end.

## License

MIT
