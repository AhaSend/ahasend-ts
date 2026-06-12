// Async pagination: walk every message matching a filter without
// manual cursor management. `iterate()` fetches pages lazily as the
// loop consumes them.
//
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/iterate.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

let count = 0;
try {
  for await (const msg of client.messages.iterate({ status: "Delivered", limit: 50 })) {
    console.log(`  - ${msg.id}  ${msg.subject}  → ${msg.recipient}`);
    if (++count >= 200) break; // stop early — pages are fetched lazily
  }
  console.log(`✓ iterated ${count} message(s)`);
} catch (err) {
  console.error("✗ iterate failed:", err.name, err.status ?? "", err.message);
  process.exit(1);
}
