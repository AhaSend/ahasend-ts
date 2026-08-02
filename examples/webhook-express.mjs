// Express 5 webhook endpoint using the bundled adapter.
//
// The adapter reads the bounded raw stream itself. Do not mount express.raw()
// or express.json() in front of this route.
//
// Requires: AHASEND_WEBHOOK_SECRET and an application-owned durable store.
// Run:  npm install express && node examples/webhook-express.mjs

import express from "express";
import { WebhookVerifier, expressWebhookHandler } from "@ahasend/sdk/webhooks";
import { pathToFileURL } from "node:url";

// Replace this stub with one database transaction that inserts a unique
// webhook-id and durable work/outbox row together. Return false only when the
// unique webhook-id was already committed. Other database failures must throw.
const defaultWebhookDeliveries = {
  async enqueueOnce(_webhookId, _event) {
    throw new Error("Connect webhookDeliveries.enqueueOnce() to a durable transaction.");
  },
};

export function createWebhookApp({ secret, enqueueOnce }) {
  const verifier = new WebhookVerifier(secret);
  const app = express();
  const webhookDeliveries = { enqueueOnce };

  const handler = expressWebhookHandler(verifier, async (event, req, res) => {
    const value = req.headers["webhook-id"];
    const webhookId = Array.isArray(value) ? value[0] : value;
    if (!webhookId) throw new Error("verified webhook-id missing");

    // Timestamp verification has already happened, but it does not deduplicate
    // a correctly signed delivery. The application owns this durable ID check.
    const accepted = await webhookDeliveries.enqueueOnce(webhookId, event);
    if (!accepted) {
      res.statusCode = 200;
      res.end();
      return;
    }

    res.statusCode = 202;
    res.end();
  });
  app.post("/webhooks/ahasend", handler);

  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.AHASEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error("✗ AHASEND_WEBHOOK_SECRET is required.");
    process.exit(1);
  }

  const app = createWebhookApp({
    secret,
    enqueueOnce: defaultWebhookDeliveries.enqueueOnce.bind(defaultWebhookDeliveries),
  });
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const server = app.listen(port, () => {
    const address = server.address();
    const listeningPort = typeof address === "object" && address !== null ? address.port : port;
    console.log(`listening on :${listeningPort} — POST /webhooks/ahasend`);
  });
}
