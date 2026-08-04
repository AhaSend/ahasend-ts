# Examples

Example scripts and framework modules for the AhaSend Node SDK. Each file imports from `../dist/`,
so build first:

```bash
npm run build
```

## Setup — environment variables

```powershell
$env:AHASEND_API_KEY="aha-sk-your-64-char-key"
$env:AHASEND_ACCOUNT_ID="your-account-uuid"
```

```bash
export AHASEND_API_KEY="aha-sk-your-64-char-key"
export AHASEND_ACCOUNT_ID="your-account-uuid"
```

Get these from the [AhaSend dashboard](https://dashboard.ahasend.com).

## Examples (in recommended order)

The packed documentation runtime matrix installs the candidate SDK and syntax- and
declaration-checks all 17 top-level `examples/*.mjs` files plus the Next route's companion
construction module. It does not make live API calls or start framework servers. The inventory
contains 15 executable smoke-test scripts and two framework examples (`webhook-express.mjs` and
`next-webhook-route.mjs`), which require their host framework setup.

### 1. `ping.mjs` — safest first test

Hits `GET /v2/ping`. Only confirms auth works and the SDK can reach the API.

```bash
node examples/ping.mjs
```

### 2. `list-domains.mjs` — read-only

Lists your sending domains.

```bash
node examples/list-domains.mjs
```

### 3. `list-api-keys.mjs` — read-only

Lists API keys on the account.

```bash
node examples/list-api-keys.mjs
```

### 4. `send-sandbox.mjs` — exercise the send flow without delivering

Uses AhaSend's sandbox mode (`sandbox: true`). The API validates the request and returns a normal response, but no email is actually sent.

`AHASEND_FROM_EMAIL` is required and must be on a **verified sending domain** on your account — sandbox mode does not bypass domain validation.

```bash
export AHASEND_ALLOW_MUTATIONS="1"
export AHASEND_FROM_EMAIL="sender@your-verified-domain.com"
node examples/send-sandbox.mjs
```

### 5. Feature examples

| Script                       | Shows                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `iterate.mjs`                | Async pagination — `for await (const msg of client.messages.iterate(...))`                                        |
| `idempotency.mjs`            | Explicit stable idempotency key reuse (sandbox send, run twice with the same key)                                 |
| `telemetry.mjs`              | `onRequest` / `onResponse` / `onRetry` / `onError` hooks for logging and metrics                                  |
| `error-handling.mjs`         | Branching on the typed error classes (`AhaSendNotFoundError`, `AhaSendRateLimitError`, …)                         |
| `get-account.mjs`            | Read-only account lookup                                                                                          |
| `list-routes.mjs`            | Read-only inbound-route listing                                                                                   |
| `list-suppressions.mjs`      | Read-only suppression listing                                                                                     |
| `statistics.mjs`             | Read-only deliverability statistics                                                                               |
| `webhook-express.mjs`        | Express webhook endpoint with application-owned, durable `webhook-id` deduplication (needs `npm install express`) |
| `next-webhook-route.mjs`     | Next.js App Router webhook route with a companion factory, explicit Node.js runtime, and durable deduplication    |
| `verify-webhook.mjs`         | Offline HMAC sign + verify round-trip — runs without any credentials                                              |
| `update-api-key-ip-list.mjs` | Guarded replacement of an API key IP allow-list                                                                   |
| `bootstrap-subaccount.mjs`   | Guarded child-account and child-key bootstrap without printing the one-time secret                                |

---

## Guarded mutations

All four request examples that create or update state (`send-sandbox.mjs`,
`idempotency.mjs`, `update-api-key-ip-list.mjs`, and `bootstrap-subaccount.mjs`) refuse to run
unless `AHASEND_ALLOW_MUTATIONS=1` is set. This includes sandbox sends even though they do not
deliver email. Review the sender, target IDs, allow-list, scopes, and output file before opting in.
In particular, an IP-list change can remove access for other workloads even when the API's
self-lockout check allows it.

```bash
export AHASEND_ALLOW_MUTATIONS="1"
export AHASEND_API_KEY_ID="key-uuid"
export AHASEND_IP_ALLOW_LIST="203.0.113.0/24,198.51.100.7"
node examples/update-api-key-ip-list.mjs
```

The bootstrap example writes the one-time child key to a new mode-0600 file.
It fails instead of overwriting an existing file and never writes the secret
to stdout or stderr.

```bash
export AHASEND_ALLOW_MUTATIONS="1"
export AHASEND_SUBACCOUNT_NAME="Example subsidiary"
export AHASEND_SUBACCOUNT_WEBSITE="subsidiary.example.com"
export AHASEND_CHILD_SECRET_FILE="./child-api-key.secret"
node examples/bootstrap-subaccount.mjs
```

Move that file into your secret manager promptly and securely remove the local
copy. If key creation or file persistence fails after the child account is
created, inspect the child account before retrying; do not blindly repeat the
bootstrap.

---

## Testing without real credentials — Prism mock server

From the repository root after `npm ci`, use the lockfile-pinned local Prism executable and the
committed `openapi.yaml`:

```bash
./node_modules/.bin/prism mock openapi.yaml -p 4010 --errors
```

Then point the SDK at the mock:

```bash
export AHASEND_API_KEY="aha-sk-mock-key-any-value"
export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"
export AHASEND_BASE_URL="http://127.0.0.1:4010"
export AHASEND_DANGEROUSLY_ALLOW_INSECURE_BASE_URL="true"
node examples/ping.mjs
```

Prism generates responses from the OpenAPI schemas — useful for verifying request shape and response parsing without needing AhaSend credentials.
