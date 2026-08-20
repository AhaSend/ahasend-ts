# Security and webhooks

Import webhook verification from `@ahasend/sdk/webhooks`. This subpath is separate from the API
client and does not pull client transport code into a webhook-only process.

## Verify before processing

Use the exact raw request bytes. A JSON parser that runs before verification changes the signed
payload and makes verification impossible. Pass the dashboard secret literally, including its
`aha-whsec-` prefix; it is used as UTF-8 HMAC key material and is not base64-decoded.

`WebhookVerifier` validates the Standard-Webhooks HMAC-SHA256 signature, requires
`webhook-id`, `webhook-timestamp`, and `webhook-signature`, and defaults to a 5-minute timestamp
tolerance. Verification and the framework adapters have a fixed 30,000,000-byte body ceiling.
Bodies above that ceiling receive an opaque 413 response from the adapters.

Direct verification is asynchronous. Await it before reading or processing the body as trusted:

```ts
await verifier.verify(headersRecordOrHeaders, rawBodyStringOrBuffer);
```

When you also need the validated event, use the awaited combined operation instead; `parse()`
already performs verification:

```ts
const event = await verifier.parse(headersRecordOrHeaders, rawBodyStringOrBuffer);
```

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

## Reading delivery diagnostics

`message.delivered`, `message.bounced`, and `message.transient_error` can carry a
`delivery_attempt` object: the SMTP status code, the response text, and on failures the bucket the
bounce classifier assigned. The response is usually the destination's own, but a failure raised
inside AhaSend carries AhaSend's description of it instead.

It is optional and frequently absent. The seven events that share the message data shape all
declare it, so read what arrives rather than asserting an attempt cannot appear; `message.clicked`
and `message.routing` have their own data shapes and never carry one.

Even the three that do carry it omit it when no SMTP attempt was recorded: an out-of-band bounce
that arrives after the destination already accepted the message, a message handled outside SMTP
(sandbox sends excepted — see below), or a response with neither a code nor any text. That first
case is what splits `message.bounced` in two: a destination rejecting the message outright normally
brings an attempt with it, while an out-of-band notification arriving later does not describe one
SMTP exchange and so brings none. An explicit `null` means the same as a missing field. Read it with
optional chaining, or narrow it once with an early return as the example below does, and never treat
its absence as an error.

`smtp_code` is always present when the object is, and `0` is a real value: AhaSend recorded response
text without an SMTP code. Do not test it for truthiness — `attempt.smtp_code || "none"` and
`if (attempt.smtp_code)` both misread an internal-error attempt as having no code.

Two consequences worth planning for:

- **`message.failed` never carries an attempt.** It reports that retries were exhausted, which is
  not a single SMTP attempt. The last thing the destination actually said arrives on the preceding
  `message.transient_error` for that message — but only if an attempt was recorded, and only if you
  subscribe to transient events. A message that expired without a single recorded attempt has
  nothing to correlate. Retry exhaustion reports this way for every message,
  campaign sends included; an immediate permanent rejection is not retry exhaustion and
  arrives as `message.bounced` instead.
- **`description` is display prose, not an identifier.** It is a human-readable translation of a
  complex error, present only when that translation differs from `response`, and its wording changes
  as the translations improve. Never compare it to a literal or parse it.

Branch on `classification`, and treat it as an open set. The set of buckets can grow, so a
delivery can carry one this release predates. The
SDK deliberately accepts those: rejecting one would return 400 to AhaSend, and 100 consecutive
errors disable the webhook. `isKnownDeliveryAttemptClassification` narrows to what the classifier
emits today, leaving you to decide what the rest means:

```ts
import {
  isKnownDeliveryAttemptClassification,
  type MessageBouncedEvent,
} from "@ahasend/sdk/webhooks";

async function onBounced(event: MessageBouncedEvent): Promise<void> {
  const attempt = event.data.delivery_attempt;
  if (attempt === undefined || attempt === null) {
    // No SMTP attempt was recorded. Normal — see the cases above.
    return;
  }
  if (attempt.classification === undefined) {
    // Status codes and `command` are allow-listed for logging. `response` and
    // `description` are not: they are free-form text that routinely embeds the
    // recipient. See Safe logging and diagnostics.
    log.info({
      smtp_code: attempt.smtp_code,
      enhanced: attempt.enhanced_status_code,
      command: attempt.command,
    });
  } else if (isKnownDeliveryAttemptClassification(attempt.classification)) {
    await route(attempt.classification);
  } else {
    // A bucket added after this release. Data, not an error.
    await routeUnrecognized(attempt.classification);
  }
}
```

Sandbox sends and dashboard test webhooks carry representative rather than observed codes and
response text, and a sandbox send does carry one even though it never reaches SMTP.
`classification` is synthesized along with the rest: a simulation can substitute the classification
of the outcome it was asked to simulate, which may then not agree with the representative
`smtp_code` and `response` beside it. Do not calibrate a `classification` branch against sandbox
traffic.

## Adapter boundaries

`nextRouteHandler` is the existing web-standard `Request` adapter. Use it in Request/Response
runtimes such as the Next.js app router and Vercel Edge; webhook verification does not add a
different edge adapter export.

The Express 5.x, Fastify, and Next.js factories share trailing
`WebhookAdapterOptions`:

```ts
const options = {
  maxBodyBytes: 1_000_000,
  onError(error, context) {
    reportLocalFailure({
      name: error instanceof Error ? error.name : "unknown",
      adapter: context.adapter,
      stage: context.stage,
    });
  },
};
```

`maxBodyBytes` defaults to 30,000,000. It accepts only integer byte counts from 1 through
30,000,000 and is only a lower deployment cap: it can narrow the fixed verifier ceiling but can
never raise it. Set the reverse proxy's request-body limit to the same value or lower and configure
its rejection response to be opaque as well.

Invalid signatures and schemas receive an opaque 400 response. Fastify also returns an opaque 400
when a parsed body is present without captured `rawBody` bytes. Oversized bodies receive an opaque
413 with no diagnostic body. These expected verification outcomes do not expose details to the
sender.

Every adapter buffers the complete raw request body before verification. JSON parsing can
temporarily retain both the encoded body and a decoded string or parsed object, with additional
framework and runtime overhead, so one maximum-sized request can consume materially more than
30 MB of memory. Concurrent requests multiply that cost. Configure both request-size and
concurrency limits at the reverse proxy, choose an application concurrency budget based on
available memory, and narrow `maxBodyBytes` when your webhook payloads do not need the full
ceiling.

`onError` is observation-only: it is used for unexpected setup, stream, or application failures,
is never awaited, and cannot mark an error handled. Observer throws and rejected promises are
consumed without replacing the original error. Express 5 native error propagation is preserved:
the adapter calls `next(originalError)` exactly once, including after the response was already
ended. Fastify throws and Next.js rejects the original error through their native paths.

The callback context contains only `adapter` and `stage`; it never contains the request URL,
headers, body, or signature. Follow [Safe logging and diagnostics](safe-logging.md) because the
original application error can still carry sensitive information.

## Deployment checklist

- Load API keys and webhook secrets from a secret manager; never ship them to a browser bundle or
  client-side code.
- Serve webhook endpoints over HTTPS and preserve the raw body.
- Apply request-body and concurrency limits at the reverse proxy, and narrow the adapter body
  limit where possible; configure proxy failures to avoid exposing diagnostics.
- Verify before any parsing-dependent or business side effect.
- Atomically commit `webhook-id` and durable work, then process that work idempotently.
- Return opaque failures and log only allow-listed metadata.
- Rotate a suspected secret in the dashboard and deploy the replacement promptly.
