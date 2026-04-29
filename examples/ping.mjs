// Simplest possible smoke test. Hits GET /v2/ping.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/ping.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.ping();
  console.log("✓ ping:", res);
} catch (err) {
  console.error("✗ ping failed:", err.name, err.status ?? "", err.message);
  if (err.body) console.error("body:", err.body);
  process.exit(1);
}
