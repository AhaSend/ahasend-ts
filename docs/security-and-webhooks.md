# Security and webhooks

Import webhook verification from `@ahasend/sdk/webhooks`. This subpath is separate from the API
client and does not pull client transport code into a webhook-only process.

## Verify before processing

Use the exact raw request bytes. A JSON parser that runs before verification changes the signed
payload and makes verification impossible. Pass the dashboard secret literally, including its
`aha-whsec-` prefix; it is used as UTF-8 HMAC key material and is not base64-decoded.

`WebhookVerifier` validates the Standard-Webhooks HMAC-SHA256 signature, requires
`webhook-id`, `webhook-timestamp`, and `webhook-signature`, and defaults to a 5-minute timestamp
tolerance. Verification and the framework adapters reject bodies above 1,048,576 bytes by
default.

Timestamp-window verification is not replay deduplication. It only rejects deliveries whose
timestamp is outside the accepted window; the same correctly signed delivery can be presented
again inside that window. Applications must deduplicate the `webhook-id` value. Keep IDs at least
as long as your delivery/retry horizon.

## Record and reject duplicate deliveries

Record the ID atomically after signature verification and before performing side effects, in the
same transaction as durable processing work. A unique ID insert alone is unsafe: if the process
fails after that insert but before processing, a retry can look like a completed duplicate and the
event is lost. Duplicate delivery: acknowledge it but do not enqueue or run the application
handler again. A 2xx acknowledgement prevents an accepted delivery from being retried
indefinitely.

This Express 5 pattern mounts `expressWebhookHandler` directly so the adapter reads the bounded raw
stream and owns the empty 413 response. Do not put `express.raw()`, `express.json()`, or another body
parser in front of it: parser size and syntax errors happen before the adapter and may produce a
framework-generated response.

The store's `enqueueOnce()` transaction must commit both the unique `webhook-id` record and a
durable work/outbox record, returning `false` when that ID was already committed. Any other
database error must roll back and throw so Express does not acknowledge the delivery:

```ts
import express from "express";
import { WebhookVerifier, expressWebhookHandler } from "@ahasend/sdk/webhooks";

const app = express();
const verifier = new WebhookVerifier(process.env.AHASEND_WEBHOOK_SECRET!);

app.post(
  "/webhooks/ahasend",
  expressWebhookHandler(verifier, async (event, req, res) => {
    const value = req.headers["webhook-id"];
    const webhookId = Array.isArray(value) ? value[0] : value;

    // Verification already required a non-empty webhook-id.
    if (!webhookId) throw new Error("verified webhook-id missing");

    const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);
    if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }

    res.statusCode = 202;
    res.end();
  }),
);
```

Process the durable work with retries and idempotent side effects outside the request. A worker
failure then leaves retryable work instead of turning the sender's next delivery into a false
success. Do not include the webhook secret, signature, raw body, or event data in the deduplication
key or diagnostic logs.

## Adapter boundaries

The Express 5.x, Fastify, and Next.js factories share trailing
`WebhookAdapterOptions`:

```ts
const options = {
  maxBodyBytes: 1_048_576,
  onError(error, context) {
    reportLocalFailure({
      name: error instanceof Error ? error.name : "unknown",
      adapter: context.adapter,
      stage: context.stage,
    });
  },
};
```

Invalid signatures and schemas receive an opaque 400 response. Oversized bodies receive an opaque 413. These expected verification outcomes do not expose details to the sender.

`onError` is observation-only: it is used for unexpected setup, stream, or application failures,
is never awaited, and cannot mark an error handled. Observer throws and rejected promises are
consumed without replacing the original error. Express 5 native error propagation is preserved:
the adapter calls `next(originalError)` exactly once, including after the response was already
ended. Fastify throws and Next.js rejects the original error through their native paths.

The callback context contains only `adapter` and `stage`; it never contains the request URL,
headers, body, or signature. Follow [Safe logging and diagnostics](safe-logging.md) because the
original application error can still carry sensitive information.

## Deployment checklist

- Load API keys and webhook secrets from a secret manager; never ship them to a browser or edge
  bundle.
- Serve webhook endpoints over HTTPS and preserve the raw body.
- Apply a bounded request-body limit at the proxy and adapter; configure proxy failures to avoid
  exposing diagnostics.
- Verify before any parsing-dependent or business side effect.
- Atomically commit `webhook-id` and durable work, then process that work idempotently.
- Return opaque failures and log only allow-listed metadata.
- Rotate a suspected secret in the dashboard and deploy the replacement promptly.
