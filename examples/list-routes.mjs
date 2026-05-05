// Read-only test: lists inbound routes on the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-routes.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.routes.list({ limit: 10 });
  console.log(`✓ found ${res.data.length} route(s)`);
  for (const r of res.data) {
    console.log(`  - ${r.name}  recipient=${r.recipient ?? "*"}  enabled=${r.enabled}`);
  }
} catch (err) {
  console.error("✗ list routes failed:", err.name, err.status ?? "", err.message);
  if (err.body) console.error("body:", err.body);
  process.exit(1);
}
