// Read-only test: pulls deliverability statistics for the last 7 days.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/statistics.mjs

import { AhaSendClient, isAhaSendError } from "@ahasend/sdk";

const client = AhaSendClient.fromEnv();

const to_time = new Date().toISOString();
const from_time = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

try {
  const result = await client.statistics
    .deliverability({ from_time, to_time, group_by: "day" })
    .withResponse();
  console.log(
    `✓ ${result.data.data.length} bucket(s) returned status=${result.response.status} request-id=${result.requestId ?? "n/a"}`,
  );
} catch (err) {
  console.error("✗ deliverability stats failed", {
    errorCode: isAhaSendError(err) ? err.code : "unknown",
  });
  process.exit(1);
}
