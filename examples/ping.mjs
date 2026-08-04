// Simplest possible smoke test. Hits GET /v2/ping.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/ping.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

try {
  const result = await client.ping().withResponse();
  console.log(`✓ ping status=${result.response.status} request-id=${result.requestId ?? "n/a"}`);
} catch (err) {
  console.error("✗ ping failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
