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

Record the ID atomically after signature verification and before performing side effects. Back the
claim with a unique key or equivalent compare-and-set; a read followed by an insert is racy.
Duplicate delivery: acknowledge it but do not run the application handler again. A 2xx
acknowledgement prevents an already processed delivery from being retried indefinitely.

This Express 5 pattern relies on `expressWebhookHandler` to verify and parse first. The store's
`claim()` must atomically insert `webhook-id` and return `false` on its uniqueness conflict:

```ts
import express from "express";
import { WebhookVerifier, expressWebhookHandler } from "@ahasend/sdk/webhooks";

const verifier = new WebhookVerifier(process.env.AHASEND_WEBHOOK_SECRET!);

app.post(
  "/webhooks/ahasend",
  express.raw({ type: "*/*", limit: "1mb" }),
  expressWebhookHandler(verifier, async (event, req, res) => {
    const value = req.headers["webhook-id"];
    const webhookId = Array.isArray(value) ? value[0] : value;

    // Verification already required a non-empty webhook-id.
    if (!webhookId) throw new Error("verified webhook-id missing");

    const firstDelivery = await webhookDeliveries.claim(webhookId);
    if (!firstDelivery) {
      res.statusCode = 200;
      res.end();
      return;
    }

    await processWebhook(event);
  }),
);
```

Do not include the webhook secret, signature, raw body, or event data in the deduplication key or
diagnostic logs. For stronger crash recovery, make the ID claim and a durable work/outbox record
one transaction, then process the work idempotently. A process that records an ID and crashes
before recording work must not silently lose the event.

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
- Apply a bounded request-body limit at the proxy and adapter.
- Verify before any parsing-dependent or business side effect.
- Atomically deduplicate `webhook-id` and make downstream processing idempotent.
- Return opaque failures and log only allow-listed metadata.
- Rotate a suspected secret in the dashboard and deploy the replacement promptly.
