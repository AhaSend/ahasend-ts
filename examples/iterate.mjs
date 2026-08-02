// Async pagination: consume a bounded prefix without manual cursor
// management. `iterate()` fetches pages lazily as the iterator advances.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/iterate.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

try {
  const messages = client.messages.iterate({ status: "Delivered", limit: 50 });
  const first = await messages.next();
  if (first.done) console.log("✓ iterated 0 message(s)");
  else console.log("✓ iterated 1 message(s)");
} catch (err) {
  console.error("✗ iterate failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
