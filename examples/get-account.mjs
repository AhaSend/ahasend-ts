// Read-only test: fetches the bound account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/get-account.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const account = await client.accounts.get();
  console.log(`✓ account: ${account.name}  (id=${account.id})`);
  console.log(`  website=${account.website ?? "n/a"}  owner=${account.owner_id}`);
} catch (err) {
  console.error("✗ get account failed:", err.name, err.status ?? "", err.message);
  if (err.body) console.error("body:", err.body);
  process.exit(1);
}
