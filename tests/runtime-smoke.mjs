import { AhaSendClient } from "@ahasend/sdk";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "@ahasend/sdk/webhooks";

function assert(condition, message) {
  if (!condition) throw new Error(`Runtime smoke assertion failed: ${message}`);
}

const encoder = new TextEncoder();
const secret = "runtime-smoke-secret";
const webhookId = "msg_runtime_smoke";
const timestamp = String(Math.floor(Date.now() / 1_000));
const body = JSON.stringify({ type: "runtime.smoke", data: {} });
const key = await globalThis.crypto.subtle.importKey(
  "raw",
  encoder.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const digest = new Uint8Array(
  await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${webhookId}.${timestamp}.${body}`),
  ),
);
let binaryDigest = "";
for (const byte of digest) binaryDigest += String.fromCodePoint(byte);

const headers = new Headers({
  "webhook-id": webhookId,
  "webhook-timestamp": timestamp,
  "webhook-signature": `v1,${btoa(binaryDigest)}`,
});
const verifier = new WebhookVerifier(secret);
await verifier.verify(headers, body);

let rejection;
try {
  await verifier.verify(headers, `${body}tampered`);
} catch (error) {
  rejection = error;
}
assert(
  rejection instanceof AhaSendWebhookVerificationError,
  "a tampered webhook must reject with the public verification error",
);
assert(rejection.reason === "signature_mismatch", "a tampered webhook must reject its signature");

let requestCount = 0;
const client = new AhaSendClient({
  apiKey: "aha-sk-runtime-smoke",
  accountId: "11111111-1111-4111-8111-111111111111",
  baseUrl: "https://runtime-smoke.invalid",
  retry: { enabled: false },
  fetch: async (input, init) => {
    requestCount += 1;
    assert(new URL(input).pathname === "/v2/ping", "ping must use the public API path");
    assert(init?.method === "GET", "ping must use GET");
    assert(
      new Headers(init.headers).get("authorization") === "Bearer aha-sk-runtime-smoke",
      "the injected request must carry SDK authorization",
    );
    return Response.json({ message: "pong" });
  },
});

const response = await client.ping();
assert(response.message === "pong", "the client must parse the injected fetch response");
assert(requestCount === 1, "the client must use injected fetch exactly once");
