# Changelog

All notable changes to this package are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `client.segments` manages segments, saved rules over the account's contacts that AhaSend keeps
  up to date: `list`, `iterate`, `create`, `preview`, `get`, `update` and `delete`.
  `client.segments.contacts` lists a segment's members, and `client.contacts.segments` lists the
  segments one contact is a member of, by UUID or raw email. A `Segment` carries its `definition`,
  its `state` (`building`, `ready` or `failed`) and its `member_count`; `get()` returns a
  `SegmentDetail`, which adds `marketable_count`, the members a campaign to the segment alone would
  reach. `preview()` counts what a definition matches without saving it. `create()` sends an
  `Idempotency-Key`, and a 4xx answer releases it. `create()`, `preview()` and `update()` refuse an
  empty `conditions`, at the root or in a group, with `AhaSendConfigurationError`. The segment
  methods need `segments:read`, `segments:write` or `segments:delete`, and `preview()`, `segments.contacts` and
  `contacts.segments` also need `contacts:read`. The new types include `SegmentDefinition`,
  `SegmentGroup`, `SegmentCondition`, `SegmentConditionValue` and `SegmentCampaignCount`. See
  "Manage segments" in the README.
- `Campaign`, `CreateCampaignRequest` and `UpdateCampaignRequest` gain `segment_ids`,
  `exclude_list_ids` and `exclude_segment_ids`. On update, an audience field that is present
  replaces its set, and `[]` empties it.
- `CampaignRecipient` gains `segment_id` and `segment_name`, which name the segment a recipient was
  sent to from, and are `null` for a recipient sent to from a list.
- `DeliveryAttempt` gains `report_message_id`: on the delivery event of an out-of-band bounce, the
  `id` of the bounce report message, which `messages.get()` reads.
- `Webhook`, `CreateWebhookRequest`, `UpdateWebhookRequest` and `ListWebhooksParams` gain the
  settings of the new events: `on_unsubscribed`, `on_complained`, `on_suppression_deleted`, and
  `on_contact_created`, `on_contact_updated`, `on_contact_deleted`, `on_contact_added_to_list`,
  `on_contact_removed_from_list`, `on_contact_subscribed`, `on_contact_unsubscribed` and
  `on_contact_complained`. Each is off unless set, so an existing webhook gets nothing new. The
  contact events need the contact read scopes on the API key.
- `Webhook`, `CreateWebhookRequest` and `UpdateWebhookRequest` gain `origins` (`WebhookOrigin[] |
  null`): whose changes the contact and suppression events report, `recipient`, `api`,
  `dashboard` or `system`; `null` means every origin. An empty array is refused with `400`.

### Changed

- `Webhook` requires the new event settings and `origins`, which the API always returns. Code that
  builds a `Webhook` object by hand, as in a test double, needs them.
- `CampaignRecipient.list_name` is `string | null`: it is `null` for a recipient sent to from a
  segment. Code that reads it as a string needs a null check.
- `campaigns.create()` and `update()` no longer refuse an empty `list_ids` with
  `AhaSendConfigurationError` before they send, because `list_ids` can be `[]` when `segment_ids`
  names a segment. The API checks the audience, and answers `400` with `AhaSendBadRequestError`
  when the campaign has no list or segment to send to.
- Release tooling: live acceptance covers the segment operations. The segment scenarios create a
  contact and a segment whose rule matches only that contact, read, list, preview and rename the
  segment, read its members and the contact's segments, and delete both. The live API key needs
  `segments:read`, `segments:write` and `segments:delete`.

## [0.4.0] — 2026-10-19

### Added

- `CampaignIssueCode` gains `text_unchecked`: the API could not check the campaign's subject,
  preview text and design right now. It clears by itself, so a `send` or `test` refused with it
  can be called again in a moment; under load it can come and go between reads. Code that
  switches over every `CampaignIssueCode` needs a case for it.
- `messages.send()`, `sendTemplate()`, `sendConversation()` and `campaigns.test()` document the
  API's check of every message before it is sent: content that cannot be rendered is refused with
  `400` and sends nothing, and a check that cannot run right now answers `503` with `Retry-After`.
  The SDK already retries that `503` with the same idempotency key; the generated response types
  of these operations now include it.
- `TemplateVariable` gains `kind` (`TemplateVariableKind`: `value`, `condition` or `list`), which
  says what shape of value to send for the variable, and `item_fields`, set only on a `list`
  variable, which names the fields each element of its array needs. A version published before
  kinds were recorded shows every variable as `value`. `kind` is required in the type, so code
  that builds `TemplateVariable` objects by hand, such as test fixtures, needs to set it.

## [0.3.0] — 2026-10-12

### Added

- `client.contacts` manages account-global contacts: `list`, `iterate`, `create`, `batchUpsert` (up
  to 1,000 contacts, one result per entry), `get`, `update`, and `delete`. A contact is named by
  UUID or by raw email, which the SDK percent-encodes once as a path segment.
- `client.templates` manages the account's transactional templates. `list`, `iterate` and `get`
  read them, each with the `variables` a send must supply and its default sender and reply-to:
  `from`, an `Address` or `null` when the template has none, and `reply_to`, likewise an `Address`
  or `null`. A `Template` also carries its `editor`, `has_draft` and, outside `list` and `iterate`,
  its published `content`. `create`, `update` and `delete` write templates; a write changes the
  template's draft, the one the dashboard edits, and `publish: true` publishes it. `getDraft`,
  `discardDraft` and `publish` act on the draft, and `listVersions`, `getVersion` and
  `restoreVersion` read and restore published versions. `update` leaves out a field it is not
  given and clears one given as `null`. `create`, `update`, `publish` and `restoreVersion` send an
  `Idempotency-Key`. Writes need `templates:write`, and `delete` needs `templates:delete`. See
  "Manage templates" in the README.
- `client.campaignTemplates` manages campaign templates, the designs a campaign copies: `list`,
  `iterate`, `create`, `get`, `update` and `delete`. A campaign template has no draft, so a write
  applies at once. They need `templates:read`, `templates:write` or `templates:delete`.
- `client.campaigns` manages marketing campaigns: `list` and `iterate` (with a `status` filter),
  `create`, `get`, `update`, `delete`, `duplicate`, `send`, `unschedule`, `test` and `getStats`,
  and `client.campaigns.recipients` lists a campaign's recipients in one status or bounce
  classification. A `Campaign` carries its `issues` and `ready` while it is a draft; a `send` or
  `test` of a campaign with issues answers `400` with a `CampaignNotReady` body that lists them,
  and a change of a campaign that is not a draft answers `409` (`AhaSendConflictError`). `create`,
  `update`, `duplicate`, `send`, `unschedule` and `test` send an `Idempotency-Key`. They need
  `campaigns:read`, `campaigns:write` or `campaigns:delete`, and `send`, `unschedule` and `test`
  need `campaigns:send`. See "Manage campaigns" in the README.
- `messages.sendTemplate()` sends a transactional template, taking `CreateTemplateMessageRequest`:
  `template_id` and `recipients` are required, and the values for the template's variables go in
  each recipient's `substitutions`. `from` and `subject` are optional: a request that leaves `from`
  out sends from the template's default sender, which is authorized and checked like a `from` in
  the request, and one that leaves `subject` out uses the template's subject. A request `from`,
  `subject` or `reply_to` wins over the template's. A request that leaves out a sender or a subject
  the template does not have answers `400`, and so does one carrying `text_content`,
  `html_content`, `amp_content` or request-level `substitutions`. A request without a sender from
  an API key that cannot send from any domain answers `403`, and a `template_id` that is not one
  of the account's transactional templates answers `404`. See "Send with a template" in the README.
- `client.lists` manages contact lists (`list`, `iterate`, `create`, `get`, `update`, `delete`),
  `client.lists.contacts` manages a list's members (`list`, `iterate`, `upsert`, `delete`,
  `batchAdd`), and `client.contacts.lists` lists the memberships one contact holds. `Suppression`
  gains `protected`.
- A domain has a `sending_type`, `transactional` or `marketing`, and reports whether sending from it
  is paused: `paused`, `paused_at`, and `pause_reason`. `pause_reason` is typed as an open string
  (`DomainPauseReason`) whose known value is `bounce_rate`. `domains.create()` and
  `domains.update()` take `sending_type`, and `domains.list()` and `iterate()` filter on it. The
  new exported types are `DomainSendingType` and `DomainPauseReason`.
- `client.subAccounts.unpauseDomain(subAccountId, domain)` lifts the pause on a sub-account's domain
  and returns the domain. It needs `sub-accounts:suspend`, is idempotent, and is not retried
  automatically, like `suspend()` and `unsuspend()`.
- `MessageSummary` and `Message` carry `template_id`, the transactional template the message was
  sent from, or `null` for a message sent without one.

Additive at runtime for existing users. The SDK does not validate response bodies, so a domain or
message from a server that does not yet return the new fields still comes back as sent. At compile
time, code that builds `Domain` literals must add `sending_type`, `paused`, `paused_at`, and
`pause_reason`; code that builds `MessageSummary` or `Message` literals must add `template_id`; and
code that implements `SubAccountsClient` or `MessagesClient` structurally, such as a test mock,
must add `unpauseDomain` or `sendTemplate`.

### Changed

- The API HTML-escapes substitution values in the HTML and AMP bodies of `messages.send()` and
  `messages.sendTemplate()`, as it already did for campaigns. Write `{{ name|safe }}` in the design
  to insert a value as HTML. The subject, the headers and the text body get values as they are. The
  SDK sends values unchanged.
- The bundled `openapi.yaml` and `webhooks.yaml` follow the current API. Webhook `from` on campaign
  message events can carry the sender's name (`Name <address>`); a route's `reply_to` is the
  Reply-To header as received, and its `to` is the recipient address the route matched, or, on a
  route that groups by Message-ID, the To header as received; both headers can hold display names
  and several addresses; a route's
  `spam_score` can be below 0 or above 10. The SDK never validated these as addresses or a range,
  so no event that parsed before is refused now.
- `webhooks.yaml` no longer lists the legacy `route.message` event type. The SDK still accepts a
  `route.message` delivery, validates it against the routing schema, and returns it as
  `message.routing`; `DEPRECATED_WEBHOOK_EVENT_TYPES`, `DeprecatedWebhookEventType`, and the
  deprecated `RouteMessageEvent` alias are unchanged.
- `ListDomainsParams.dns_valid` accepts `null`, which sends no filter, matching the API.
- The documentation says "pause" and "resume" for `subAccounts.suspend()` and `unsuspend()`; the
  method names and paths are unchanged. The JSDoc of `messages.send()`, `sendConversation()`, and
  `domains.delete()` gives the `403` a paused domain answers. The webhook guide gives the retry horizons to keep
  `webhook-id` records for, and says that more than 100 failed attempts in a row disable a webhook
  or a route.
- `APIKeyScopeName` documents that the braces in a domain scope such as
  `messages:send:{example.com}` are part of the scope string.
- Release tooling: live acceptance covers every operation. The template scenarios create their own
  templates: one they list, read, and sandbox-send with `messages.sendTemplate()`, once with `from`
  and once from the template's default sender, and one they publish, draft, restore, and delete. The
  message scenarios check `template_id` on every message they read. The campaign scenarios make a
  campaign template, an empty list and campaigns of their own, check the test, the send and the
  unschedule through their refusals so no campaign mail is ever sent, and delete everything; the
  live API key needs `campaigns:read`, `campaigns:write`, `campaigns:delete` and `campaigns:send`.

## [0.2.1] — 2026-08-20

### Added

- Message webhooks can carry `delivery_attempt`, the diagnostics for the delivery attempt an event
  reports on: `smtp_code`, plus `classification`, `enhanced_status_code`, `response`, `description`,
  and `command`. It is optional and frequently absent, and an explicit `null` means the same as a
  missing field, so read it with optional chaining. When each field appears, which of them are safe
  to branch on, and which must never be logged are documented in `docs/security-and-webhooks.md`
  and `docs/safe-logging.md` — a release note is the wrong place for rules that have to stay in step
  with the spec.
- `WebhookDeliveryAttempt`, `KnownDeliveryAttemptClassification`, and
  `isKnownDeliveryAttemptClassification` are exported from `@ahasend/sdk/webhooks`. The type is
  prefixed because the package root already exports an unrelated `DeliveryAttempt` — the per-hop
  log on `Message.delivery_attempts`.
- `classification` is typed as a plain `string`, not an enum. The set of bounce buckets is open
  and can grow, so a delivery can carry one this release predates, and a published SDK that
  rejected one would return 400 to AhaSend until the webhook was disabled. Use
  `isKnownDeliveryAttemptClassification` to narrow to what it emits today and keep a branch for
  everything else.
- A delivery attempt's `smtp_code`, `enhanced_status_code`, `classification`, and `command` are
  allow-listed for logging; `response` and `description` are not, being free-form text that
  routinely embeds the recipient address. `command` is a normalized command name and excludes the
  command's arguments, so no envelope address rides along in it. See `docs/safe-logging.md`.
- Which event carries an attempt follows the outcome, not the send type. Retry exhaustion arrives as
  `message.failed` and never carries one — for every message, campaign sends included. An immediate
  permanent rejection arrives as `message.bounced` and normally does carry one, while an
  out-of-band bounce notification arriving later does not.

Additive for existing users: a 0.1.0 or 0.2.0 client ignores the new field.

### Changed

- `SECURITY.md` now scopes vulnerability reports to the same maintained runtime inventory the README
  and CI already agree on, instead of the narrower Node-22-and-24 boundary it still described after
  0.2.0 widened it. It defers to that one list rather than restating it, and the documentation gate
  now watches it for the obsolete claims it already watched for elsewhere.

## [0.2.0] — 2026-08-07

### BREAKING

- Direct `WebhookVerifier.verify()` and `WebhookVerifier.parse()` calls are now asynchronous because
  webhook signing uses native Web Crypto. Await either method before treating the request body as
  trusted. Existing Express, Fastify, and `nextRouteHandler` adapter callers need no migration
  because those adapters await verification internally.

Before:

```ts
verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);
const event = verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
```

After:

```ts
await verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);
const event = await verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
```

### Changed

- The maintained server-runtime inventory is Node.js 22, 24, and 26, Deno latest 2.x, Bun latest,
  Cloudflare workerd without `nodejs_compat`, and Vercel Edge through `@edge-runtime/vm`. Browser
  and browser Service Worker use remains refused by default; `dangerouslyAllowBrowser: true`
  remains the explicit escape hatch for browser-shaped server test environments.

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
  queue size at runtime. Every method validates its arguments and throws
  `AhaSendConfigurationError` on an unrecognized category, a non-boolean
  flag, a limit that is not an object, an unknown key on one, or a field
  value construction would refuse — including `null`, which only `undefined`
  may stand in for as keep-current — because this is a
  runtime boundary reachable from JavaScript, where these values often come
  from environment variables or parsed JSON and the declared types are not
  enforced. A queue
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
- `messages.get()` and `messages.cancel()` reduce the message ID to its
  bare UUID before building the request path. `send` returns ids in
  generated Message-ID form (`<uuid@domain>`), but the server reads path
  parameters undecoded, so the percent-encoded full form a correct client
  must produce was refused as `invalid message_id` — found by the first
  live acceptance run. All three spellings (`uuid`, `uuid@domain`,
  `<uuid@domain>`) are accepted; a value containing no UUID throws
  `AhaSendConfigurationError` locally, without echoing the value.
- Construction validates `accountId` as a UUID (the format every
  account-scoped path parameter declares) and stores it trimmed, so a
  dashboard slug or a secret with a trailing newline fails at boot with
  `AhaSendConfigurationError` instead of a bare `TypeError` on the
  first account-scoped call. The message does not echo the value.
- Security guards: HTTPS-only base URL (localhost exempt) and a
  browser-environment check, both with explicit opt-outs. Redirects are
  never followed — the Authorization header cannot be replayed to wherever
  a proxy points — and a 3xx response surfaces as a non-retryable
  `AhaSendAPIError` with the status and `location` header preserved,
  rather than being mistaken for a retryable network failure.
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
