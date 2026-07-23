# Changelog

All notable changes to this package are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — Unreleased

Initial release.

### Added

- Full coverage of the AhaSend API v2: Messages (send, conversation
  send, list, get, cancel), Domains (CRUD + DNS check), API Keys,
  Webhooks, Statistics (deliverability / bounce / delivery-time),
  Suppressions, Routes, Accounts (incl. members), SMTP Credentials,
  and ping.
- Automatic idempotency: UUID `Idempotency-Key` on every create
  operation, reused across retries; explicit `idempotencyKey` option;
  `IdempotencyKeyBuilder` for related operations.
- Retries with exponential / linear / constant backoff and jitter on
  408/429/5xx/network/timeout and eligible idempotency-in-progress 409
  responses. Valid `Retry-After` seconds and HTTP-date forms are
  authoritative up to the configured retry maximum (30 seconds by
  default).
- Opt-in two-bucket rate limiter for the documented standard and
  statistics tiers, with timeout-bounded, cancellable local pacing
  independent of undocumented remaining headers.
- Typed telemetry hooks (`onRequest`, `onResponse`, `onRetry`,
  `onError`) carrying the server `x-request-id`;
  successful response envelopes carry `requestId` / `idempotentReplayed`.
- Async pagination: `iterate()` on every list endpoint plus generic
  `paginate()` / `collect()` helpers.
- `@ahasend/sdk/webhooks` subpath: Standard-Webhooks HMAC-SHA256
  verifier (raw-string secrets, byte-compatible with the Go SDK),
  typed events for all 11 event types with a forward-compatible
  `UnknownWebhookEvent` branch, and adapters for Express, Fastify,
  and Next.js.
- Typed error hierarchy mapping every HTTP status the API uses,
  including idempotency-specific 409/422 variants and a
  transport-level `AhaSendResponseParseError` for non-JSON 2xx bodies.
- Security guards: HTTPS-only base URL (localhost exempt) and a
  browser-environment check, both with explicit opt-outs.
- Spec-conformance test suite validating every SDK method's verb +
  path against the repository's `openapi.yaml`.
- Dual ESM + CJS build with full type declarations; zero runtime
  dependencies; Node.js ≥ 22.
