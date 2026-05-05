import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AhaSendWebhookVerificationError,
  WebhookVerifier,
} from "../src/webhooks/verifier.js";

const SECRET_RAW = "test-secret-bytes-must-be-long-enough";
const SECRET_BASE64 = Buffer.from(SECRET_RAW, "utf-8").toString("base64");

function sign(secretBytes: Buffer, id: string, ts: number, body: string): string {
  const toSign = `${id}.${ts}.${body}`;
  return `v1,${createHmac("sha256", secretBytes).update(toSign).digest("base64")}`;
}

function buildEnvelope(
  secret: string,
  body: object,
  options: { id?: string; timestamp?: number } = {},
): { headers: Record<string, string>; body: string } {
  const secretBytes = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    isBase64(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret) ? "base64" : "utf-8",
  );
  const id = options.id ?? "msg_test_123";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const rawBody = JSON.stringify(body);
  const signature = sign(secretBytes, id, timestamp, rawBody);
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
    body: rawBody,
  };
}

function isBase64(v: string): boolean {
  if (v.length === 0 || v.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(v);
}

describe("WebhookVerifier", () => {
  it("verifies a correctly signed payload", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
    const { headers, body } = buildEnvelope(SECRET_BASE64, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: { id: "msg_1" },
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("parses verified payload as a typed event", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
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
    const { headers, body } = buildEnvelope(SECRET_BASE64, payload);
    const event = verifier.parse(headers, body);
    expect(event.type).toBe("message.delivered");
    if (event.type === "message.delivered") {
      expect(event.data.recipient).toBe("x@y.com");
    }
  });

  it("rejects a tampered body", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
    const { headers, body } = buildEnvelope(SECRET_BASE64, {
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
    const verifier = new WebhookVerifier(Buffer.from("different-secret").toString("base64"));
    const { headers, body } = buildEnvelope(SECRET_BASE64, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).toThrow(AhaSendWebhookVerificationError);
  });

  it("rejects an outdated timestamp (replay attack)", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64, { toleranceSeconds: 300 });
    const oldTs = Math.floor(Date.now() / 1000) - 1000;
    const { headers, body } = buildEnvelope(
      SECRET_BASE64,
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
    const verifier = new WebhookVerifier(SECRET_BASE64);
    expect(() => verifier.verify({}, "{}")).toThrow(/missing_webhook_id/);
  });

  it("supports the whsec_ prefix on the secret", () => {
    const prefixed = `whsec_${SECRET_BASE64}`;
    const verifier = new WebhookVerifier(prefixed);
    const { headers, body } = buildEnvelope(prefixed, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("accepts a Buffer body", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
    const { headers, body } = buildEnvelope(SECRET_BASE64, {
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: {},
    });
    expect(() => verifier.verify(headers, Buffer.from(body, "utf-8"))).not.toThrow();
  });

  it("accepts multiple signatures separated by spaces (key rotation)", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
    const ts = Math.floor(Date.now() / 1000);
    const id = "msg_1";
    const body = JSON.stringify({ type: "message.delivered", data: {} });
    const validSig = sign(Buffer.from(SECRET_BASE64, "base64"), id, ts, body);
    const headers = {
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": `v1,wrong-signature ${validSig} v1,another-wrong`,
    };
    expect(() => verifier.verify(headers, body)).not.toThrow();
  });

  it("accepts a Headers instance", () => {
    const verifier = new WebhookVerifier(SECRET_BASE64);
    const { headers, body } = buildEnvelope(SECRET_BASE64, {
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
