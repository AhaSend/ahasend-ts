# Changelog

All notable changes to this package are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-07-25

Initial release.

### Added

- Full coverage of the AhaSend API v2: Messages (send, conversation
  send, list, get, cancel), Domains (CRUD + DNS check), API Keys,
  Webhooks, Statistics (deliverability / bounce / delivery-time),
  Suppressions, Routes, Accounts (incl. members), SMTP Credentials,
  parent-managed Subaccounts (lifecycle, pooled usage, and child API
  keys), and ping.
- Automatic idempotency: UUID `Idempotency-Key` on every create
  operation, reused across retries; explicit `idempotencyKey` option;
  `IdempotencyKeyBuilder` for related operations.
- Retries with exponential / linear / constant backoff and jitter on
  408/429/5xx/network/timeout and eligible idempotency-in-progress 409
  responses. Valid `Retry-After` seconds and HTTP-date forms are
  authoritative up to the configured retry maximum (30 seconds by
  default).
- Opt-in two-bucket rate limiter for the documented standard and
  statistics tiers, with cancellable local pacing independent of
  undocumented remaining headers. The queue wait is bounded by the
  caller's `AbortSignal`, not by `timeoutMs` — that budget starts once a
  token is granted. Each bucket holds `maxQueue` waiters (1,000 by
  default) and refuses beyond that with `AhaSendRateLimitQueueFullError`,
  so a fan-out wider than `burst + maxQueue` needs the limit raised.
  `client.rateLimiter` reads and adjusts rates, per-bucket enablement, and
  queue size at runtime, validating exactly as construction does. A queue
  refusal is per call, so an overflowing batch is partially applied — see
  `docs/rate-pacing.md` before re-dispatching one.
- Typed telemetry hooks (`onRequest`, `onResponse`, `onRetry`,
  `onError`) carrying the server `x-request-id`;
  successful response envelopes carry `requestId` / `idempotentReplayed`.
- Async pagination via `iterate()` on every list endpoint.
- `@ahasend/sdk/webhooks` subpath: Standard-Webhooks HMAC-SHA256
  verifier (raw-string secrets, byte-compatible with the Go SDK),
  typed events for all 11 event types with a forward-compatible
  `UnknownWebhookEvent` branch, and adapters for Express, Fastify,
  and Next.js. `verify()` and `parse()` take a plain header record or
  anything with a `Headers`-style `get`, detected structurally, so a
  `Headers` that is not the realm's global class — a separately
  installed `undici` or `node-fetch`, an edge runtime's — works too.
  Inbound route attachments carry `content_id` and `disposition`. Use
  `content_id` — not `disposition` — to tell an inline `cid:` part from a
  real attachment: the embedded images Gmail and Outlook send carry no
  `Content-Disposition` header at all and arrive as `disposition: ""`.
  Webhook payload fields the server always sends are typed as required, so
  a delivery missing one is rejected as `invalid_event` rather than
  surfacing as `undefined` inside your handler.
  Adapters buffer at most 30,000,000 bytes by default
  (override per adapter with `maxBodyBytes`, and cap it at your proxy
  too — the body is buffered before the signature is checked), and give
  opaque 400/413 outcomes, observation-only error hooks, and Express 5
  native error propagation.
- Typed error hierarchy mapping every HTTP status the API uses,
  including idempotency-specific 409/422 variants and a
  transport-level `AhaSendResponseParseError` for non-JSON 2xx bodies.
  `error.message` derived from a response body is whitespace-collapsed and
  capped at 200 characters with the full text left on `error.body`, so a
  proxy's HTML error page cannot become the message; match on `error.code`
  rather than message text. Response bodies are bounded at 30,000,000 bytes
  counted after decompression, raising a non-retryable
  `AhaSendResponseTooLargeError` rather than buffering a body that inflates.
- Local validation of request-body arrays the API requires to be
  non-empty (`recipients`, `to`/`cc`/`bcc`, API-key `scopes`, and
  scoped webhook / SMTP-credential `domains`). These throw
  `AhaSendConfigurationError` synchronously, before the request is
  dispatched, so the failure is local rather than a server 422.
- Construction validates `accountId` as a UUID (the format every
  account-scoped path parameter declares) and stores it trimmed, so a
  dashboard slug or a secret with a trailing newline fails at boot with
  `AhaSendConfigurationError` instead of a bare `TypeError` on the
  first account-scoped call. The message does not echo the value.
- Security guards: HTTPS-only base URL (localhost exempt) and a
  browser-environment check, both with explicit opt-outs.
- Spec-conformance test suite validating every SDK method's verb +
  path against the repository's `openapi.yaml`.
- Dual ESM + CJS build with full type declarations; zero runtime
  dependencies; Node.js ≥ 22.
- The published declarations require no `@types/node`, matching the fact
  that the package declares no dependency or peer dependency on it: they
  name no `Buffer`, no `NodeJS.*` namespace, and import no `node:`
  module, so they compile under `"types": []` with `skipLibCheck: false`.
  Raw webhook bodies (`WebhookRawBody`, `NodeStyleRequest.rawBody`,
  `NodeStyleResponse.end`) are typed `Uint8Array` rather than `Buffer`,
  and the environment entry points (`AhaSendClient.fromEnv`,
  `optionsFromEnv`) take the exported `ProcessEnvLike` rather than
  `NodeJS.ProcessEnv`. Both are widenings — a `Buffer` and the real
  `process.env` still satisfy them in a supplying position. The
  declarations do name four WHATWG globals a fetch client exposes
  (`fetch`, `Request`, `Response`, `AbortSignal`), so consumers still
  need `"lib": ["DOM"]` or `@types/node` for those; `Headers` is not one
  of them, since webhook headers are accepted structurally.
  `NodeStyleRequest.rawBody` is the one of these that a handler also
  _receives_ rather than only supplies, so inside an adapter handler
  `req.rawBody` now arrives as `Uint8Array` and no longer passes directly
  into a parameter declared `Buffer`. Narrow it with
  `Buffer.isBuffer(req.rawBody)`, or wrap the bytes without copying:
  `Buffer.from(b.buffer, b.byteOffset, b.byteLength)`.
- Generated API reference plus operational guides for retries,
  idempotency, cancellation, local rate pacing, safe logging,
  subaccounts, IP allow lists, webhook replay deduplication, and
  supported runtime/package boundaries.
