# Examples

Runnable smoke tests for the AhaSend Node SDK. Each script imports from `../dist/`, so build first:

```bash
npm run build
```

## Setup — environment variables

```bash
# Windows (PowerShell)
$env:AHASEND_API_KEY="aha-sk-your-64-char-key"
$env:AHASEND_ACCOUNT_ID="your-account-uuid"

# macOS / Linux
export AHASEND_API_KEY="aha-sk-your-64-char-key"
export AHASEND_ACCOUNT_ID="your-account-uuid"
```

Get these from the [AhaSend dashboard](https://dashboard.ahasend.com).

## Examples (in recommended order)

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
export AHASEND_FROM_EMAIL="sender@your-verified-domain.com"
node examples/send-sandbox.mjs
```

---

## Testing without real credentials — Prism mock server

The AhaSend OpenAPI spec is public. You can run a local mock server from it:

```bash
npm install -g @stoplight/prism-cli
prism mock https://raw.githubusercontent.com/AhaSend/ahasend-go/main/openapi/openapi.yaml -p 4010
```

Then point the SDK at the mock:

```bash
export AHASEND_API_KEY="aha-sk-mock-key-any-value"
export AHASEND_ACCOUNT_ID="00000000-0000-0000-0000-000000000000"
export AHASEND_BASE_URL="http://127.0.0.1:4010"
node examples/ping.mjs
```

Prism generates responses from the OpenAPI schemas — useful for verifying request shape and response parsing without needing AhaSend credentials.
