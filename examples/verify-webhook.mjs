// Demonstrates the webhook verifier end-to-end:
//   1. Sign a payload with a test secret (simulating AhaSend's outbound webhook).
//   2. Verify and parse it with the SDK's WebhookVerifier.
// Run:  node examples/verify-webhook.mjs

import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

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
  webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
  data: {
    account_id: "00000000-0000-4000-8000-000000000001",
    event: "on_delivered",
    from: "sender@example.com",
    recipient: "recipient@example.com",
    subject: "Hello",
    message_id_header: "<demo@example.com>",
    id: "msg_demo_1",
  },
});

const toSign = `${id}.${timestamp}.${body}`;
const key = await globalThis.crypto.subtle.importKey(
  "raw",
  Buffer.from(SECRET, "utf8"),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const signature = await globalThis.crypto.subtle.sign("HMAC", key, Buffer.from(toSign, "utf8"));
const sig = `v1,${Buffer.from(signature).toString("base64")}`;

const headers = {
  "webhook-id": id,
  "webhook-timestamp": String(timestamp),
  "webhook-signature": sig,
};

try {
  const event = await verifier.parse(headers, body);
  if (event.type !== "message.delivered") throw new Error("Unexpected webhook event type.");
  console.log("✓ verified webhook signature");
} catch {
  console.error("✗ webhook verification failed");
  process.exit(1);
}

// Demonstrate that tampering is detected
try {
  await verifier.parse(headers, body.replace("Hello", "Tampered"));
  console.error("✗ verifier accepted a tampered body — this should not happen");
  process.exit(1);
} catch (err) {
  if (!(err instanceof AhaSendWebhookVerificationError) || err.reason !== "signature_mismatch") {
    console.error("✗ unexpected tamper verification outcome");
    process.exit(1);
  }
  console.log("✓ tampered body correctly rejected");
}
