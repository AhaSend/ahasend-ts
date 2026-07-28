# Safe logging and diagnostics

Treat API keys, webhook secrets, SMTP passwords, one-time `secret_key` values, authorization and
signature headers, idempotency keys, request bodies, message content, attachments, and recipient
addresses as sensitive. Do not put them in logs, metrics labels, traces, exception tags, or URLs.

`AhaSendClient#toJSON()` and Node's inspection hook redact the API key:

```ts
logger.info({ client }); // apiKey is "[REDACTED]"
```

This is a narrow safeguard, not a general-purpose sanitizer. The representation still includes
the account ID, and objects you create around the client are not inspected or redacted by the SDK.

Telemetry events expose the HTTP method, unexpanded OpenAPI route template, operation ID, attempt,
duration, status, retry delay, and `x-request-id` when available. They do not expose the expanded
URL, query string, request headers, or request body. Prefer an allow-list:

```ts
const client = new AhaSendClient({
  apiKey,
  accountId,
  hooks: {
    onResponse(event) {
      logger.info({
        operationId: event.operationId,
        route: event.routeTemplate,
        status: event.status,
        durationMs: event.durationMs,
        requestId: event.requestId,
      });
    },
  },
});
```

`onError` and `onRetry` also carry the original error. API errors can contain server-provided
messages, response bodies, and response headers, so do not serialize the whole error blindly.
Select status, error code, request ID, and operation ID explicitly. The built-in `debug: true`
logger includes error names and messages; review those messages and avoid debug logging in
production unless the destination and retention policy are appropriate.

Telemetry hooks are observation-only. They run asynchronously, are not awaited by requests, and
their throws or rejected promises are swallowed. Do not put correctness, persistence, or retry
decisions in a hook.

Webhook adapter `onError` callbacks receive only the original local error and a frozen
`{ adapter, stage }` context. The context intentionally excludes URLs, headers, bodies, and
signatures. The error itself is application-controlled and may still be sensitive, so log an
allow-listed summary. Never log a webhook secret or the raw signed body while diagnosing a
verification failure.
