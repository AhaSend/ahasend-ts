// Read-only test: lists domains in the account.
// Requires: AHASEND_API_KEY + AHASEND_ACCOUNT_ID env vars.
// Run:  node examples/list-domains.mjs

import { AhaSendClient } from "../dist/index.js";

const client = AhaSendClient.fromEnv();

try {
  const res = await client.domains.list({ limit: 10 });
  console.log(`✓ found ${res.data.length} domain(s) (has_more: ${res.pagination.has_more})`);
  for (const d of res.data) {
    console.log(`  - ${d.domain}  dns_valid=${d.dns_valid}  id=${d.id}`);
  }
} catch (err) {
  console.error("✗ list domains failed:", err.name, err.status ?? "", err.message);
  process.exit(1);
}
