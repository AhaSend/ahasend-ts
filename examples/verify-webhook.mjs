// Demonstrates the webhook verifier end-to-end:
//   1. Sign a payload with a test secret (simulating AhaSend's outbound webhook).
//   2. Verify and parse it with the SDK's WebhookVerifier.
// Run:  node examples/verify-webhook.mjs

import { createHmac } from "node:crypto";
import { WebhookVerifier } from "../dist/webhooks/index.js";

// Pass the secret string exactly as it appears in the AhaSend dashboard
// (including any `aha-whsec-` prefix). The SDK uses the raw UTF-8 bytes
// of the string as the HMAC key, matching the Go SDK and the server.
const SECRET = "aha-whsec-local-demo-secret-please-rotate";
const verifier = new WebhookVerifier(SECRET);

const id = "msg_demo_1";
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  type: "message.delivered",
  timestamp: new Date().toISOString(),
  webhook_id: "wh_demo",
  data: {
    account_id: "acc_demo",
    event: "delivered",
    from: "sender@example.com",
    recipient: "recipient@example.com",
    subject: "Hello",
    message_id_header: "<demo@example.com>",
    id: "msg_demo_1",
  },
});

const toSign = `${id}.${timestamp}.${body}`;
const sig = `v1,${createHmac("sha256", Buffer.from(SECRET, "utf-8")).update(toSign).digest("base64")}`;

const headers = {
  "webhook-id": id,
  "webhook-timestamp": String(timestamp),
  "webhook-signature": sig,
};

try {
  const event = verifier.parse(headers, body);
  console.log("✓ verified webhook signature");
  console.log(`  type: ${event.type}`);
  if (event.type === "message.delivered") {
    console.log(`  recipient: ${event.data.recipient}  subject: ${event.data.subject}`);
  }
} catch (err) {
  console.error("✗ verification failed:", err.name, err.reason ?? "", err.message);
  process.exit(1);
}

// Demonstrate that tampering is detected
try {
  verifier.parse(headers, body.replace("Hello", "Tampered"));
  console.error("✗ verifier accepted a tampered body — this should not happen");
  process.exit(1);
} catch (err) {
  console.log(`✓ tampered body correctly rejected (reason: ${err.reason})`);
}
