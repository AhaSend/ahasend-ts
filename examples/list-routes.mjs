// Read-only test: lists inbound routes on the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-routes.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

try {
  const result = await client.routes.list({ limit: 10 }).withResponse();
  console.log(
    `✓ found ${result.data.data.length} route(s) status=${result.response.status} request-id=${result.requestId ?? "n/a"}`,
  );
} catch (err) {
  console.error("✗ list routes failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
