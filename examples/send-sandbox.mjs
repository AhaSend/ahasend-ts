// Exercises the full send path in SANDBOX mode — AhaSend accepts the request
// but does not actually deliver the email. No real email is sent.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
//           AHASEND_FROM_EMAIL (any address on a domain you have, or any string in sandbox)
// Run:  node examples/send-sandbox.mjs

import { AhaSendClient } from "../dist/index.js";

const fromEmail = process.env.AHASEND_FROM_EMAIL ?? "test@example.com";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.messages.send({
    from: { email: fromEmail, name: "AhaSend SDK Test" },
    recipients: [{ email: "to@example.com", name: "Test Recipient" }],
    subject: "SDK sandbox test",
    text_content: "This is a sandbox-mode send from the AhaSend Node SDK.",
    html_content: "<p>This is a <b>sandbox-mode</b> send from the AhaSend Node SDK.</p>",
    sandbox: true,
    sandbox_result: "deliver", // deliver | bounce | defer | fail | suppress
    tags: ["sdk-smoketest"],
  });
  console.log("✓ send accepted:", JSON.stringify(res, null, 2));
} catch (err) {
  console.error("✗ send failed:", err.name, err.status ?? "", err.message);
  if (err.body) console.error("body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
}
