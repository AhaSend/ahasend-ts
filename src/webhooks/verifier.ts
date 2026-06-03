import { createHmac, timingSafeEqual } from "node:crypto";
import { AhaSendError } from "../errors.js";
import type { AnyWebhookEvent } from "./events.js";

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export class AhaSendWebhookVerificationError extends AhaSendError {
  public readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Webhook verification failed: ${reason}`);
    this.name = "AhaSendWebhookVerificationError";
    this.reason = reason;
  }
}

export interface WebhookVerifierOptions {
  toleranceSeconds?: number;
  /**
   * Clock injection for tests. Must return a millisecond-precision
   * timestamp matching `Date.now()` — the verifier divides by 1000
   * internally to compare against the seconds-resolution
   * `webhook-timestamp` header. Named with the `Ms` suffix so callers
   * can't accidentally inject a seconds-resolution clock (which would
   * silently produce a ~50-year tolerance error).
   */
  nowMs?: () => number;
}

export interface NormalizedHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

type HeadersInput = Record<string, string | string[] | undefined> | Headers;

export class WebhookVerifier {
  private readonly key: Buffer;
  private readonly toleranceSeconds: number;
  private readonly nowMs: () => number;

  constructor(secret: string, options: WebhookVerifierOptions = {}) {
    if (!secret || typeof secret !== "string") {
      throw new Error("WebhookVerifier: secret must be a non-empty string.");
    }
    if (options.toleranceSeconds !== undefined && options.toleranceSeconds <= 0) {
      throw new Error(
        "WebhookVerifier: toleranceSeconds must be > 0. Use a small positive " +
          "value if you want a tight window; do not disable replay protection.",
      );
    }
    this.key = decodeSecret(secret);
    this.toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.nowMs = options.nowMs ?? Date.now;
  }

  verify(headers: HeadersInput, rawBody: string | Buffer): void {
    const { id, timestamp, signature } = this.extractHeaders(headers);

    const tsSec = Number(timestamp);
    if (!Number.isFinite(tsSec)) {
      throw new AhaSendWebhookVerificationError("invalid_timestamp");
    }

    const nowSec = Math.floor(this.nowMs() / 1000);
    if (Math.abs(nowSec - tsSec) > this.toleranceSeconds) {
      throw new AhaSendWebhookVerificationError("timestamp_outside_tolerance");
    }

    const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
    const expected = this.sign(id, tsSec, body);

    const provided = signature
      .split(" ")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (!provided.some((part) => signatureMatches(part, expected))) {
      throw new AhaSendWebhookVerificationError("signature_mismatch");
    }
  }

  /**
   * Verify + JSON-parse. Returns the strict `WebhookEvent` union when
   * the payload's `type` matches a known event, or a generic
   * `UnknownWebhookEvent` branch when the server has rolled out a new
   * event type this SDK version does not yet know about. Throws
   * `AhaSendWebhookVerificationError` on signature failure, malformed
   * JSON, or a payload that does not look like a webhook envelope.
   */
  parse(headers: HeadersInput, rawBody: string | Buffer): AnyWebhookEvent {
    this.verify(headers, rawBody);
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AhaSendWebhookVerificationError("invalid_json", "Webhook body is not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      throw new AhaSendWebhookVerificationError(
        "invalid_payload",
        "Webhook body is not a recognisable AhaSend event envelope",
      );
    }
    return parsed as AnyWebhookEvent;
  }

  sign(id: string, timestampSeconds: number, body: string): string {
    const toSign = `${id}.${timestampSeconds}.${body}`;
    const digest = createHmac("sha256", this.key).update(toSign).digest("base64");
    return `v1,${digest}`;
  }

  private extractHeaders(input: HeadersInput): NormalizedHeaders {
    const get = (name: string): string | undefined => {
      if (input instanceof Headers) {
        return input.get(name) ?? undefined;
      }
      const value = input[name] ?? input[name.toLowerCase()];
      if (Array.isArray(value)) return value[0];
      return value;
    };

    const id = get(WEBHOOK_ID_HEADER);
    const timestamp = get(WEBHOOK_TIMESTAMP_HEADER);
    const signature = get(WEBHOOK_SIGNATURE_HEADER);

    if (!id) throw new AhaSendWebhookVerificationError("missing_webhook_id");
    if (!timestamp) throw new AhaSendWebhookVerificationError("missing_webhook_timestamp");
    if (!signature) throw new AhaSendWebhookVerificationError("missing_webhook_signature");

    return { id, timestamp, signature };
  }
}

function decodeSecret(secret: string): Buffer {
  // Match the Go SDK byte-for-byte: the HMAC key is the raw UTF-8 bytes
  // of the secret string. No base64 decoding, no prefix stripping.
  //
  // AhaSend's Go SDK at ahasend-go/webhooks/webhooks.go uses
  // `[]byte(secret)` directly; the server signs against the same bytes.
  // Any heuristic that tried to base64-decode "looks like base64"
  // secrets would silently produce a different HMAC key and reject every
  // webhook with `signature_mismatch`.
  return Buffer.from(secret, "utf-8");
}

function signatureMatches(provided: string, expected: string): boolean {
  // Signatures are ASCII (`v1,<base64>`), so equal string length implies
  // equal byte length. `timingSafeEqual` panics on unequal-length
  // buffers, hence the up-front length comparison.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(provided, "utf-8"),
    Buffer.from(expected, "utf-8"),
  );
}
