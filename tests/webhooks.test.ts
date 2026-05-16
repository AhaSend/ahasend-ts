import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AhaSendWebhookVerificationError,
  WebhookVerifier,
} from "../src/webhooks/verifier.js";

// AhaSend webhook secrets are raw strings: the HMAC key is the literal
// UTF-8 bytes of the secret as the user pastes it from the dashboard.
// This matches the Go SDK at ahasend-go/webhooks/webhooks.go.
const SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const PREFIXED_SECRET = `aha-whsec-${SECRET}`;

function sign(secret: string, id: string, ts: number, body: string): string {
  const toSign = `${id}.${ts}.${body}`;
  return `v1,${createHmac("sha256", Buffer.from(secret, "utf-8"))
    .update(toSign)
    .digest("base64")}`;
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
    if (event.type === "message.delivered") {
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
});
