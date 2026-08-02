// Next.js App Router route module (for example, app/api/ahasend/route.mjs).
// AhaSend webhook verification requires the Node.js runtime.

import { WebhookVerifier, nextRouteHandler } from "@ahasend/sdk/webhooks";

export const runtime = "nodejs";

// Replace this stub with one database transaction that inserts a unique
// webhook-id and durable work/outbox row together. Return false only when the
// unique webhook-id was already committed. Other database failures must throw.
const defaultWebhookDeliveries = {
  async enqueueOnce(_webhookId, _event) {
    throw new Error("Connect webhookDeliveries.enqueueOnce() to a durable transaction.");
  },
};

export function createWebhookRoute({ secret, enqueueOnce }) {
  const verifier = new WebhookVerifier(secret);
  const webhookDeliveries = { enqueueOnce };

  return nextRouteHandler(verifier, async (event, request) => {
    const webhookId = request.headers.get("webhook-id");
    if (!webhookId) throw new Error("verified webhook-id missing");

    // Timestamp-window verification is not replay deduplication.
    const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);
    if (!accepted) return new Response(null, { status: 200 });

    return new Response(null, { status: 202 });
  });
}

const secret = process.env.AHASEND_WEBHOOK_SECRET;
if (!secret) throw new Error("AHASEND_WEBHOOK_SECRET is required.");

export const POST = createWebhookRoute({
  secret,
  enqueueOnce: defaultWebhookDeliveries.enqueueOnce.bind(defaultWebhookDeliveries),
});
