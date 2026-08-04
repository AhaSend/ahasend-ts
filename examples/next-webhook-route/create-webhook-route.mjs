import { WebhookVerifier, nextRouteHandler } from "@ahasend/sdk/webhooks";

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
