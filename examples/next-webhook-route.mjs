// Next.js App Router route module (for example, app/api/ahasend/route.mjs).
// Copy ./next-webhook-route/create-webhook-route.mjs alongside this module.
// AhaSend webhook verification requires the Node.js runtime.

import { createWebhookRoute } from "./next-webhook-route/create-webhook-route.mjs";

export const runtime = "nodejs";

// Replace this stub with one database transaction that inserts a unique
// webhook-id and durable work/outbox row together. Return false only when the
// unique webhook-id was already committed. Other database failures must throw.
const defaultWebhookDeliveries = {
  async enqueueOnce(_webhookId, _event) {
    throw new Error("Connect webhookDeliveries.enqueueOnce() to a durable transaction.");
  },
};

const secret = process.env.AHASEND_WEBHOOK_SECRET;
if (!secret) throw new Error("AHASEND_WEBHOOK_SECRET is required.");

export const POST = createWebhookRoute({
  secret,
  enqueueOnce: defaultWebhookDeliveries.enqueueOnce.bind(defaultWebhookDeliveries),
});
