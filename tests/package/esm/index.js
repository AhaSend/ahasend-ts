import assert from "node:assert/strict";
import {
  AhaSendClient,
  AhaSendConfigurationError,
  AhaSendError,
  isAhaSendError,
} from "@ahasend/sdk";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

const verificationError = new AhaSendWebhookVerificationError("signature_mismatch");
assert.ok(verificationError instanceof AhaSendError);
assert.equal(isAhaSendError(verificationError), true);

assert.throws(
  () => new WebhookVerifier(""),
  (error) =>
    error instanceof AhaSendConfigurationError && error.constructor === AhaSendConfigurationError,
);

let requestCount = 0;
const replayedDomain = { object: "domain", domain: "replayed.example.com" };
const freshDomain = { object: "domain", domain: "fresh.example.com" };
const client = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  fetch: async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json(replayedDomain, {
        status: 201,
        headers: { "Idempotent-Replayed": "true" },
      });
    }
    if (requestCount === 2) return Response.json(freshDomain, { status: 201 });
    return Response.json({ message: "unexpected request" }, { status: 500 });
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

const replayedRequest = client.domains.create({ domain: replayedDomain.domain });
const [replayedBody, replayedResponse] = await Promise.all([
  replayedRequest,
  replayedRequest.withResponse(),
]);
assert.deepEqual(replayedBody, replayedDomain);
assert.strictEqual(replayedResponse.data, replayedBody);
assert.equal(replayedResponse.response.status, 201);
assert.equal(replayedResponse.idempotentReplayed, true);

const freshResponse = await client.domains.create({ domain: freshDomain.domain }).withResponse();
assert.deepEqual(freshResponse.data, freshDomain);
assert.equal(freshResponse.response.status, 201);
assert.equal(freshResponse.idempotentReplayed, undefined);
assert.equal(requestCount, 2);
