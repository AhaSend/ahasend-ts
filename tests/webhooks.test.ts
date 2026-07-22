import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { digestYamlArtifact } from "../scripts/digest-artifact.mjs";
import { parseWebhookContract } from "../scripts/generate-contracts.mjs";
import { generateSdkArtifacts } from "../scripts/generate-sdk.mjs";
import { WEBHOOK_SHA256 } from "../src/generated/contract-digests.js";
import type { components as WebhookComponents } from "../src/generated/webhook-types.js";
import {
  CANONICAL_WEBHOOK_EVENT_TYPES,
  DEPRECATED_WEBHOOK_EVENT_TYPES,
  WEBHOOK_CONTRACT_SHA256,
  WEBHOOK_SCHEMA_NAMES,
} from "../src/generated/webhook-types.js";
import {
  validateKnownWebhookEvent,
  validateUnknownWebhookEvent,
  validateWebhookEvent,
} from "../src/generated/webhook-validators.js";
import { isKnownWebhookEvent } from "../src/webhooks/events.js";
import { AhaSendWebhookVerificationError, WebhookVerifier } from "../src/webhooks/verifier.js";

// AhaSend webhook secrets are raw strings: the HMAC key is the literal
// UTF-8 bytes of the secret as the user pastes it from the dashboard.
// This matches the Go SDK at ahasend-go/webhooks/webhooks.go.
const SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PREFIXED_SECRET = `aha-whsec-${SECRET}`;
const ROOT = process.cwd();
const OPENAPI_SOURCE = readFileSync(resolve(ROOT, "openapi.yaml"), "utf8");
const WEBHOOK_SOURCE = readFileSync(resolve(ROOT, "webhooks.yaml"), "utf8");

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a record");
  }
  return value as Record<string, unknown>;
}

describe("generated webhook schema", () => {
  it("binds generated artifacts to the pinned webhook contract digest", () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, "contracts.lock.json"), "utf8")) as {
      artifactHashes: Record<string, string>;
    };
    const digest = digestYamlArtifact(Buffer.from(WEBHOOK_SOURCE, "utf8"));

    expect(digest).toBe(lock.artifactHashes["webhooks.yaml"]);
    expect(WEBHOOK_CONTRACT_SHA256).toBe(digest);
    expect(WEBHOOK_SHA256).toBe(digest);
  });

  it("regenerates webhook output deterministically and passes clean check mode", async () => {
    const first = await generateSdkArtifacts(OPENAPI_SOURCE, WEBHOOK_SOURCE);
    const second = await generateSdkArtifacts(OPENAPI_SOURCE, WEBHOOK_SOURCE);
    const generatedPaths = [
      "src/generated/webhook-types.ts",
      "src/generated/webhook-validators.ts",
    ] as const;

    for (const path of generatedPaths) {
      expect(first.get(path), path).toBe(second.get(path));
      expect(readFileSync(resolve(ROOT, path), "utf8"), path).toBe(first.get(path));
    }

    const beforeCheck = generatedPaths.map((path) => readFileSync(resolve(ROOT, path), "utf8"));
    const check = spawnSync(process.execPath, ["scripts/generate-sdk.mjs", "--check"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(generatedPaths.map((path) => readFileSync(resolve(ROOT, path), "utf8"))).toEqual(
      beforeCheck,
    );
  });

  it("models canonical routing, deprecated input compatibility, and optional is_bot", () => {
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toContain("message.routing");
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).not.toContain("route.message");
    expect(DEPRECATED_WEBHOOK_EVENT_TYPES).toEqual(["route.message"]);

    expectTypeOf<{
      account_id: string;
      event: "on_opened";
      from: string;
      recipient: string;
      subject: string;
      message_id_header: string;
      id: string;
    }>().toExtend<WebhookComponents["schemas"]["MessageWebhookData"]>();
    expectTypeOf<WebhookComponents["schemas"]["MessageWebhookData"]["is_bot"]>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<{
      type: "route.message";
      route_id: string;
      timestamp: string;
      data: WebhookComponents["schemas"]["RouteWebhookData"];
    }>().toExtend<WebhookComponents["schemas"]["RouteWebhookPayload"]>();
  });

  it("covers every declared webhook schema and canonical event example", () => {
    const document = parseWebhookContract(WEBHOOK_SOURCE);
    const schemas = record(record(document["components"])["schemas"]);
    const webhooks = record(document["webhooks"]);

    expect(WEBHOOK_SCHEMA_NAMES).toEqual(Object.keys(schemas));
    expect(WEBHOOK_SCHEMA_NAMES).toHaveLength(18);
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toEqual(Object.keys(webhooks));
    expect(CANONICAL_WEBHOOK_EVENT_TYPES).toHaveLength(11);

    for (const [eventType, webhookValue] of Object.entries(webhooks)) {
      const post = record(record(webhookValue)["post"]);
      const requestBody = record(post["requestBody"]);
      const content = record(requestBody["content"]);
      const mediaType = record(content["application/json"]);
      expect(validateKnownWebhookEvent(mediaType["example"]), eventType).toBe(true);
    }
  });

  it("validates complete known envelopes and nested payload fields", () => {
    const clicked = {
      type: "message.clicked",
      timestamp: "2024-05-06T09:49:16.687031577Z",
      data: {
        account_id: "4cdd7bdd-294e-4762-892f-83d40abf5a87",
        event: "on_clicked",
        from: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Hello",
        message_id_header: "<message@example.com>",
        url: "https://example.com",
        user_agent: "AhaSend test",
        ip: "192.0.2.1",
        id: "message-1",
        is_bot: false,
      },
    };

    expect(validateKnownWebhookEvent(clicked)).toBe(true);
    const withoutOptionalBoolean = structuredClone(clicked);
    Reflect.deleteProperty(withoutOptionalBoolean.data, "is_bot");
    expect(validateKnownWebhookEvent(withoutOptionalBoolean)).toBe(true);
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, is_bot: "false" },
      }),
    ).toBe(false);
    const withoutUrl = structuredClone(clicked);
    Reflect.deleteProperty(withoutUrl.data, "url");
    expect(validateKnownWebhookEvent(withoutUrl)).toBe(false);
  });

  it("validates RFC 3339 date-times and the complete UUID format", () => {
    const clicked = {
      type: "message.clicked",
      timestamp: "2024-05-06t09:49:16.687031577z",
      data: {
        account_id: "00000000-0000-0000-0000-000000000000",
        event: "on_clicked",
        from: "sender@example.com",
        recipient: "recipient@example.com",
        subject: "Hello",
        message_id_header: "<message@example.com>",
        url: "https://example.com",
        user_agent: "AhaSend test",
        ip: "192.0.2.1",
        id: "message-1",
      },
    };

    expect(validateKnownWebhookEvent(clicked)).toBe(true);
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, account_id: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      }),
    ).toBe(true);
    for (const timestamp of [
      "2024-02-29T09:49:16Z",
      "1990-12-31T23:59:60Z",
      "1990-12-31T15:59:60-08:00",
      "1991-01-01T08:59:60+09:00",
      "2024-05-06T09:49:16+23:59",
    ]) {
      expect(validateKnownWebhookEvent({ ...clicked, timestamp }), timestamp).toBe(true);
    }
    for (const timestamp of [
      "2024-99-99T99:99:99Z",
      "2023-02-29T09:49:16Z",
      "2024-04-31T09:49:16Z",
      "2024-05-06T24:00:00Z",
      "2024-05-06T09:60:00Z",
      "2024-05-06T09:49:61Z",
      "2024-05-06T09:49:60Z",
      "2024-05-06T09:49:16+24:00",
      "2024-05-06T09:49:16+00:60",
      "2024-05-06 09:49:16Z",
    ]) {
      expect(validateKnownWebhookEvent({ ...clicked, timestamp }), timestamp).toBe(false);
    }
    expect(
      validateKnownWebhookEvent({
        ...clicked,
        data: { ...clicked.data, account_id: "00000000000000000000000000000000" },
      }),
    ).toBe(false);
  });

  it("accepts canonical and deprecated routing inputs against the same full schema", () => {
    const routing = {
      type: "message.routing",
      route_id: "abe11757-2886-4b55-96f1-0e0afc95795a",
      timestamp: "2024-05-06T13:15:46Z",
      data: {
        id: "route-message-1",
        from: "sender@example.com",
        to: "support@example.com",
        subject: "Help",
        message_id: "<route@example.com>",
        size: 512,
        bounce: false,
        html_body: "<p>Help</p>",
        plain_body: "Help",
        attachments: [{ filename: "note.txt", content_type: "text/plain", data: "SGVsbG8=" }],
        headers: { "X-Mailer": "AhaSend test" },
      },
    } as const;

    expect(validateKnownWebhookEvent(routing)).toBe(true);
    expect(validateKnownWebhookEvent({ ...routing, type: "route.message" })).toBe(true);
    expect(
      validateKnownWebhookEvent({
        ...routing,
        data: { ...routing.data, attachments: [{ filename: "note.txt" }] },
      }),
    ).toBe(false);
  });

  it("validates future event types only against the schema-defined common envelope", () => {
    const future = {
      type: "message.future_event",
      timestamp: "2026-07-22T12:00:00Z",
      data: { future_field: true },
      future_envelope_field: "preserved",
    };

    expect(validateUnknownWebhookEvent(future)).toBe(true);
    expect(validateWebhookEvent(future)).toBe(true);
    expect(validateUnknownWebhookEvent({ ...future, data: "not-an-object" })).toBe(false);
    expect(validateUnknownWebhookEvent({ type: future.type, timestamp: future.timestamp })).toBe(
      false,
    );
    expect(
      validateUnknownWebhookEvent({
        type: "message.clicked",
        timestamp: future.timestamp,
        data: {},
      }),
    ).toBe(false);
  });
});

function sign(secret: string, id: string, ts: number, body: string): string {
  const toSign = `${id}.${ts}.${body}`;
  return `v1,${createHmac("sha256", Buffer.from(secret, "utf-8")).update(toSign).digest("base64")}`;
}

function buildEnvelope(
  secret: string,
  body: object,
  options: { id?: string; timestamp?: number } = {},
): { headers: Record<string, string>; body: string } {
  const id = options.id ?? "msg_test_123";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(body);
  const signature = sign(secret, id, timestamp, rawBody);
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
    body: rawBody,
  };
}

describe("WebhookVerifier", () => {
  it("verifies a correctly signed payload", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: { id: "msg_1" },
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("parses verified payload as a typed event", () => {
    const verifier = new WebhookVerifier(SECRET);
    const payload = {
      type: "message.delivered" as const,
      timestamp: new Date().toISOString(),
      data: {
        account_id: "acc_1",
        event: "delivered",
        from: "a@b.com",
        recipient: "x@y.com",
        subject: "Test",
        message_id_header: "<x@y>",
        id: "msg_1",
      },
    };
    const { headers, body } = buildEnvelope(SECRET, payload);
    const event = verifier.parse(headers, body);
    expect(event.type).toBe("message.delivered");
    expect(isKnownWebhookEvent(event)).toBe(true);
    if (isKnownWebhookEvent(event) && event.type === "message.delivered") {
      expect(event.data.recipient).toBe("x@y.com");
    }
  });

  it("rejects a tampered body", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    const tamperedBody = body.replace("message.delivered", "message.opened");
    try {
      verifier.verify(headers, tamperedBody);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AhaSendWebhookVerificationError);
      expect((err as AhaSendWebhookVerificationError).reason).toBe("signature_mismatch");
    }
  });

  it("rejects a wrong secret", () => {
    const verifier = new WebhookVerifier("a-different-secret-entirely");
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).toThrow(AhaSendWebhookVerificationError);
  });

  it("rejects an outdated timestamp (replay attack)", () => {
    const verifier = new WebhookVerifier(SECRET, { toleranceSeconds: 300 });
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const { headers, body } = buildEnvelope(
      SECRET,
      { type: "message.delivered", timestamp: "2020-01-01T00:00:00Z", data: {} },
      { timestamp: oldTs },
    );
    try {
      verifier.verify(headers, body);
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as AhaSendWebhookVerificationError).reason).toBe("timestamp_outside_tolerance");
    }
  });

  it("rejects when required headers are missing", () => {
    const verifier = new WebhookVerifier(SECRET);
    expect(() => verifier.verify({}, "{}")).toThrow(/missing_webhook_id/);
  });

  it("treats the aha-whsec- prefix as part of the secret bytes (matches Go SDK)", () => {
    // AhaSend's secret format is `aha-whsec-<key>`. The Go SDK uses the
    // entire string (prefix included) as the HMAC key bytes, and so does
    // the AhaSend server. The TS verifier must do the same.
    const verifier = new WebhookVerifier(PREFIXED_SECRET);
    const { headers, body } = buildEnvelope(PREFIXED_SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("CROSS-SDK FIXTURE: accepts a base64-legal raw secret without decoding it", () => {
    // `MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw` is 32 alphanumeric characters —
    // it is base64-legal (length % 4 == 0, only base64 alphabet). The
    // previous verifier base64-decoded it, producing different key bytes
    // from what the Go SDK and the AhaSend server produce, and rejected
    // every webhook with signature_mismatch. This test pins the fix.
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("accepts a Buffer body", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, Buffer.from(body, "utf-8"))).not.toThrow();
  });

  it("accepts multiple signatures separated by spaces (key rotation)", () => {
    const verifier = new WebhookVerifier(SECRET);
    const ts = Math.floor(Date.now() / 1000);
    const id = "msg_1";
    const body = JSON.stringify({ type: "message.delivered", data: {} });
    const validSig = sign(SECRET, id, ts, body);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,wrong-signature ${validSig} v1,another-wrong`,
    };
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("accepts a Headers instance", () => {
    const verifier = new WebhookVerifier(SECRET);
    const { headers, body } = buildEnvelope(SECRET, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    const h = new Headers(headers);
    expect(() => verifier.verify(h, body)).not.toThrow();
  });

  it("constructor throws on empty secret", () => {
    expect(() => new WebhookVerifier("")).toThrow(/secret/);
  });

  it("PINNED CROSS-SDK FIXTURE: signature byte-stability under decodeSecret refactors", () => {
    // (secret, id, timestamp, body) tuple. The expected signature is
    // computed once using the byte-exact algorithm the Go SDK
    // (ahasend-go/webhooks/webhooks.go) and the AhaSend server use,
    // then hardcoded so that any future change to `decodeSecret` —
    // including a well-intentioned base64 reintroduction or an attempt
    // to strip a prefix — will fail this test loudly.
    const secret = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const id = "msg_2KbAaY8M";
    const timestamp = 1700000000;
    const body = '{"type":"message.delivered","data":{}}';

    // The expected signature is whatever the documented algorithm
    // produces. If the verifier ever drifts (e.g. base64-decoding the
    // secret again), the input to HMAC changes and the actual signature
    // emitted by `WebhookVerifier.sign()` will no longer match this
    // independent computation done in pure-Node crypto.
    const expectedDigest = createHmac("sha256", Buffer.from(secret, "utf-8"))
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    const expectedSignature = `v1,${expectedDigest}`;

    const verifier = new WebhookVerifier(secret, { nowMs: () => timestamp * 1000 });
    expect(() =>
      verifier.verify(
        {
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": expectedSignature,
        },
        body,
      ),
    ).not.toThrow();
    // The internal sign() must produce the byte-exact same signature.
    expect(verifier.sign(id, timestamp, body)).toBe(expectedSignature);
  });
});
