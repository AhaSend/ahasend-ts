const assert = require("node:assert/strict");
const {
  AhaSendClient,
  AhaSendConfigurationError,
  AhaSendError,
  isAhaSendError,
} = require("@ahasend/sdk");
const { AhaSendWebhookVerificationError, WebhookVerifier } = require("@ahasend/sdk/webhooks");

const verificationError = new AhaSendWebhookVerificationError("signature_mismatch");
assert.ok(verificationError instanceof AhaSendError);
assert.equal(isAhaSendError(verificationError), true);

assert.throws(
  () => new WebhookVerifier(""),
  (error) =>
    error instanceof AhaSendConfigurationError && error.constructor === AhaSendConfigurationError,
);

let requestCount = 0;
const client = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  fetch: async () => {
    requestCount += 1;
    return Response.json({ message: "unexpected request" });
  },
});

assert.throws(
  () => client.suppressions.wipe({ domian: "example.com" }),
  /Unknown query parameter "domian"/,
);
assert.throws(
  () => client.suppressions.delete({ domain: "example.com" }),
  /Missing required query parameter "email"/,
);
assert.throws(
  () => client.messages.list({ after: "next", before: "previous" }),
  /must not include both "after" and "before"/,
);
assert.throws(() => client.apiKeys.get("not-a-uuid"), /expected uuid/);
assert.throws(() => client.domains.get("invalid_hostname.example"), /expected hostname/);
assert.throws(
  () => client.subAccounts.apiKeys.delete("22222222-2222-4222-8222-222222222222", ".."),
  /path segments must not be empty/,
);
assert.equal(requestCount, 0);
