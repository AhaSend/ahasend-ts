// Explicit idempotency keys: drive the key from your own stable
// identifier (job ID, order ID) so retries from YOUR side — not just
// the SDK's internal retries — can never double-send.
//
// The SDK auto-generates a key for every create operation when you
// don't pass one; an explicit key is for when the same logical
// operation might be attempted from multiple places.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID + AHASEND_FROM_EMAIL.
// Run:  node examples/idempotency.mjs

import { AhaSendClient } from "../dist/index.js";

const fromEmail = process.env.AHASEND_FROM_EMAIL;
if (!fromEmail) {
  console.error("✗ AHASEND_FROM_EMAIL is required (verified sending domain).");
  process.exit(1);
}

const client = AhaSendClient.fromEnv();

// Pattern 1 — key derived from your own stable ID:
const orderId = "order-12345";
const send = () =>
  client.messages.send(
    {
      from: { email: fromEmail },
      recipients: [{ email: "to@example.com" }],
      subject: `Receipt for ${orderId}`,
      text_content: "Thanks for your order.",
      sandbox: true,
    },
    { idempotencyKey: `receipt-${orderId}` },
  );

try {
  const first = await send();
  console.log("✓ first send:", first.data[0]?.status);

  // Same key — the server replays the original result instead of
  // sending a second email.
  const replay = await send();
  console.log("✓ replay send:", replay.data[0]?.status, "(no duplicate email)");
} catch (err) {
  console.error("✗ send failed:", err.name, err.status ?? "", err.message);
  process.exit(1);
}
