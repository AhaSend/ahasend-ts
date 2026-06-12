// Express webhook endpoint using the bundled adapter. The adapter
// captures the raw body, verifies the HMAC signature, parses the typed
// event, and returns generic 400/500 responses on failure — you only
// write the business logic.
//
// IMPORTANT: the webhook route must receive the RAW body. Mount
// express.raw() on the route (as below) — do NOT let express.json()
// run first, or signature verification becomes impossible.
//
// Requires: AHASEND_WEBHOOK_SECRET (from the AhaSend dashboard,
//           pasted exactly as shown — including any aha-whsec- prefix).
// Run:  npm install express && node examples/webhook-express.mjs
// Test: AhaSend dashboard → Webhooks → send test event to
//       http://<your-tunnel>/webhooks/ahasend

import express from "express";
import { WebhookVerifier, expressWebhookHandler, isKnownWebhookEvent } from "../dist/webhooks/index.js";

const secret = process.env.AHASEND_WEBHOOK_SECRET;
if (!secret) {
  console.error("✗ AHASEND_WEBHOOK_SECRET is required.");
  process.exit(1);
}

const verifier = new WebhookVerifier(secret);
const app = express();

app.post(
  "/webhooks/ahasend",
  express.raw({ type: "*/*" }), // raw body — required for HMAC verification
  expressWebhookHandler(verifier, async (event) => {
    if (!isKnownWebhookEvent(event)) {
      console.log(`unknown event type ${event.type} — acknowledge and ignore`);
      return;
    }
    switch (event.type) {
      case "message.delivered":
        console.log(`delivered → ${event.data.recipient} (${event.data.subject})`);
        break;
      case "message.bounced":
        console.log(`bounced → ${event.data.recipient}`);
        break;
      case "suppression.created":
        console.log(`suppressed → ${event.data.recipient} (${event.data.reason})`);
        break;
      default:
        console.log(`event: ${event.type}`);
    }
  }),
);

app.listen(3000, () => {
  console.log("listening on :3000 — POST /webhooks/ahasend");
});
