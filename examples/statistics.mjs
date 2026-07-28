// Read-only test: pulls deliverability statistics for the last 7 days.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/statistics.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

const to_time = new Date().toISOString();
const from_time = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

try {
  const res = await client.statistics.deliverability({ from_time, to_time, group_by: "day" });
  console.log(`✓ ${res.data.length} bucket(s) returned`);
  for (const bucket of res.data) {
    console.log(
      `  - ${bucket.from_timestamp}  reception=${bucket.reception_count}  delivered=${bucket.delivered_count}  bounced=${bucket.bounced_count}`,
    );
  }
} catch (err) {
  console.error("✗ deliverability stats failed:", err.name, err.status ?? "", err.message);
  process.exit(1);
}
