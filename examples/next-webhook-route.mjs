// Next.js App Router route module (for example, app/api/ahasend/route.mjs).
// AhaSend webhook verification requires the Node.js runtime.

import { WebhookVerifier, nextRouteHandler } from "../dist/webhooks/index.js";

export const runtime = "nodejs";

const secret = process.env.AHASEND_WEBHOOK_SECRET;
if (!secret) throw new Error("AHASEND_WEBHOOK_SECRET is required.");

// Replace this stub with one database transaction that inserts a unique
// webhook-id and durable work/outbox row together.
const webhookDeliveries = {
  async enqueueOnce(_webhookId, _event) {
    throw new Error("Connect webhookDeliveries.enqueueOnce() to a durable transaction.");
  },
};

const verifier = new WebhookVerifier(secret);

export const POST = nextRouteHandler(verifier, async (event, request) => {
  const webhookId = request.headers.get("webhook-id");
  if (!webhookId) throw new Error("verified webhook-id missing");

  // Timestamp-window verification is not replay deduplication.
  const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);
  if (!accepted) return new Response(null, { status: 200 });

  return new Response(null, { status: 202 });
});
