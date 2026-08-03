// Exercises the full send path in SANDBOX mode — AhaSend accepts the request
// but does not actually deliver the email. No real email is sent.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars and the explicit
//           AHASEND_ALLOW_MUTATIONS=1 acknowledgement.
//           AHASEND_FROM_EMAIL must be an address on a verified sending
//           domain on your account. The API rejects unverified-domain
//           sends even in sandbox mode.
// Run:  node examples/send-sandbox.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

if (process.env.AHASEND_ALLOW_MUTATIONS !== "1") {
  throw new Error("Refusing mutation; set AHASEND_ALLOW_MUTATIONS=1 after reviewing the script.");
}

const fromEmail = process.env.AHASEND_FROM_EMAIL;
if (!fromEmail) {
  console.error(
    "✗ AHASEND_FROM_EMAIL is required — set it to an address on a verified " +
      "sending domain on your account (sandbox mode does not bypass domain validation).",
  );
  process.exit(1);
}

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
  // A 202 is multi-status: one result per recipient, and an individual
  // entry can carry status "error" while the promise still resolves. Inspect
  // every entry — recipient addresses and error text are deliberately not
  // logged here, since example output is not a safe place for either.
  const queued = res.data.filter((r) => r.status !== "error");
  const rejected = res.data.filter((r) => r.status === "error");
  console.log(`✓ sandbox send: ${queued.length} queued, ${rejected.length} rejected`);
} catch (err) {
  console.error("✗ send failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
