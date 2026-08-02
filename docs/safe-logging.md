# Safe logging and diagnostics

Use a strict output allowlist: aggregate counts, appropriate opaque object IDs that do not embed
customer data, HTTP status, SDK error code, and request ID. These are the only AhaSend values that
belong in logs, metrics labels, traces, or exception tags.

Forbid message content, subjects, recipients and other addresses, attachments, API keys, webhook
secrets, SMTP passwords, one-time `secret_key` values, authorization and signature headers,
idempotency keys, request bodies, and other secrets. Never serialize a whole client, request,
response, event, or error object; any whole objects are forbidden. Never output `err.message`:
server and local error messages can repeat sensitive values. Do not put forbidden values in URLs
either.

`AhaSendClient#toJSON()` and Node's inspection hook redact the API key, but this is a narrow
safeguard rather than a general-purpose sanitizer. The representation still includes the account
ID, objects you create around the client are not inspected or redacted by the SDK, and the client
must not be logged as a whole object.

Telemetry events expose the HTTP method, unexpanded OpenAPI route template, operation ID, attempt,
duration, status, retry delay, and `x-request-id` when available. They do not expose the expanded
URL, query string, request headers, or request body. Select only allowlisted output:

```ts
import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = new AhaSendClient({
  apiKey,
  accountId,
  hooks: {
    onResponse(event) {
      logger.info({
        status: event.status,
        requestId: event.requestId,
      });
    },
    onError(event) {
      logger.error({
        status: event.status,
        requestId: event.requestId,
        errorCode: isAhaSendError(event.error) ? event.error.code : "unknown",
      });
    },
  },
});
```

`onError` and `onRetry` also carry the original error. API errors can contain server-provided
messages, response bodies, and response headers, so do not serialize the whole error blindly.
Select status, SDK error code, and request ID explicitly. The built-in `debug: true` logger includes
error names and messages, so it does not satisfy this allowlist; leave it disabled wherever this
safe-logging policy applies.

Telemetry hooks are observation-only. They run asynchronously, are not awaited by requests, and
their throws or rejected promises are swallowed. Do not put correctness, persistence, or retry
decisions in a hook.

Webhook adapter `onError` callbacks receive only the original local error and a frozen
`{ adapter, stage }` context. The context intentionally excludes URLs, headers, bodies, and
signatures. The error itself is application-controlled and may still be sensitive, so log an
allowlisted SDK error code when one exists, without the message. Never log a webhook secret or the
raw signed body while diagnosing a verification failure.
