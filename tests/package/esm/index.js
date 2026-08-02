import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  AhaSendClient,
  AhaSendConfigurationError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  AhaSendServerError,
  AhaSendTimeoutError,
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

let timeoutRequestCount = 0;
const timeoutClient = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  timeoutMs: 5_000,
  retry: { enabled: false },
  fetch: async (_input, init) => {
    timeoutRequestCount += 1;
    return new Promise((_, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    });
  },
});

await assert.rejects(
  timeoutClient.ping({ timeoutMs: 10 }),
  (error) => error instanceof AhaSendTimeoutError && error.message.includes("10ms"),
);
assert.equal(timeoutRequestCount, 1);

let retryRequestCount = 0;
const retryClient = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  retry: {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    strategy: "constant",
    jitter: false,
  },
  fetch: async () => {
    retryRequestCount += 1;
    return Response.json({ message: "retry fixture failure" }, { status: 500 });
  },
});

await assert.rejects(
  retryClient.ping({ retry: { maxRetries: 1 } }),
  (error) => error instanceof AhaSendServerError,
);
assert.equal(retryRequestCount, 2);

const conflictKeys = [];
const conflictClient = new AhaSendClient({
  apiKey: "aha-sk-test",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://api.test",
  retry: {
    enabled: true,
    maxRetries: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
    strategy: "constant",
    jitter: false,
  },
  fetch: async (_input, init) => {
    conflictKeys.push(new Headers(init.headers).get("idempotency-key"));
    return Response.json(
      { message: "idempotent request is still processing" },
      {
        status: 409,
        headers: { "idempotent-replayed": "false", "retry-after": "1" },
      },
    );
  },
});

let conflictError;
try {
  await conflictClient.domains.create({ domain: "conflict.example.com" });
} catch (error) {
  conflictError = error;
}

assert.ok(conflictError instanceof AhaSendIdempotencyConflictError);
const recoveryKey = conflictKeys[0];
assert.equal(typeof recoveryKey, "string");
assert.ok(recoveryKey.length > 0);
assert.deepEqual(conflictKeys, [recoveryKey, recoveryKey]);
assert.equal(conflictError.idempotencyKey, recoveryKey);
const recoveryKeyDescriptor = Object.getOwnPropertyDescriptor(conflictError, "idempotencyKey");
assert.equal(recoveryKeyDescriptor.enumerable, false);
assert.equal(recoveryKeyDescriptor.value, recoveryKey);
assert.equal(recoveryKeyDescriptor.writable, false);
assert.equal(Object.keys(conflictError).includes("idempotencyKey"), false);

for (const diagnostic of [
  JSON.stringify(conflictError),
  inspect(conflictError),
  inspect(conflictError, { showHidden: true }),
]) {
  assert.equal(diagnostic.includes(recoveryKey), false);
  assert.equal(diagnostic.includes("idempotencyKey"), false);
}
