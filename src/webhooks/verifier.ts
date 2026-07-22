import { createHmac, timingSafeEqual } from "node:crypto";
import { AhaSendConfigurationError, AhaSendWebhookVerificationError } from "../errors.js";
import {
  isKnownWebhookEventType,
  validateKnownWebhookEvent,
  validateUnknownWebhookEvent,
} from "../generated/webhook-validators.js";
import type { AnyWebhookEvent } from "./events.js";

export { AhaSendWebhookVerificationError } from "../errors.js";
export type { WebhookVerificationReason } from "../errors.js";

export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export interface WebhookVerifierOptions {
  toleranceSeconds?: number;
  /**
   * Clock injection for deterministic verification. The result uses the same
   * millisecond resolution as `Date.now()`.
   */
  nowMs?: () => number;
}

interface NormalizedHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

type HeadersInput = Record<string, string | string[] | undefined> | Headers;
type RawBody = string | Buffer;

export class WebhookVerifier {
  readonly #key: Buffer;
  readonly #toleranceSeconds: number;
  readonly #nowMs: () => number;

  constructor(secret: string, options: WebhookVerifierOptions = {}) {
    if (!secret || typeof secret !== "string") {
      throw new AhaSendConfigurationError("WebhookVerifier: secret must be a non-empty string.");
    }
    if (
      options.toleranceSeconds !== undefined &&
      (!Number.isSafeInteger(options.toleranceSeconds) || options.toleranceSeconds <= 0)
    ) {
      throw new AhaSendConfigurationError(
        "WebhookVerifier: toleranceSeconds must be a positive safe integer.",
      );
    }
    if (options.nowMs !== undefined && typeof options.nowMs !== "function") {
      throw new AhaSendConfigurationError("WebhookVerifier: nowMs must be a function.");
    }

    this.#key = Buffer.from(secret, "utf-8");
    this.#toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.#nowMs = options.nowMs ?? Date.now;
  }

  verify(headers: HeadersInput, rawBody: RawBody): void {
    assertBodySize(rawBody);
    const { id, timestamp, signature } = extractHeaders(headers);

    const timestampSeconds = parseTimestamp(timestamp);
    const nowMilliseconds = this.#nowMs();
    if (!Number.isFinite(nowMilliseconds) || !Number.isSafeInteger(nowMilliseconds)) {
      throw new AhaSendConfigurationError(
        "WebhookVerifier: nowMs must return a finite safe-integer millisecond timestamp.",
      );
    }
    const nowSeconds = Math.floor(nowMilliseconds / 1000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.#toleranceSeconds) {
      throw new AhaSendWebhookVerificationError("timestamp_outside_tolerance");
    }

    const expected = sign(this.#key, id, timestamp, rawBody);
    const provided = signature.split(" ").filter((part) => part.length > 0);

    if (!provided.some((part) => signatureMatches(part, expected))) {
      throw new AhaSendWebhookVerificationError("signature_mismatch");
    }
  }

  /** Verify, parse, validate, and normalize a webhook event. */
  parse(headers: HeadersInput, rawBody: RawBody): AnyWebhookEvent {
    this.verify(headers, rawBody);
    const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new AhaSendWebhookVerificationError(
        "invalid_json",
        "Webhook body is not valid JSON",
        cause,
      );
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      throw new AhaSendWebhookVerificationError(
        "invalid_payload",
        "Webhook body is not a recognisable AhaSend event envelope",
      );
    }

    const type = (parsed as { type: string }).type;
    if (isKnownWebhookEventType(type)) {
      if (!validateKnownWebhookEvent(parsed)) {
        throw new AhaSendWebhookVerificationError(
          "invalid_event",
          "Webhook body does not match the schema for its known event type",
        );
      }
      if (type === "route.message") {
        return { ...parsed, type: "message.routing" } as AnyWebhookEvent;
      }
      return parsed as AnyWebhookEvent;
    }

    if (!validateUnknownWebhookEvent(parsed)) {
      throw new AhaSendWebhookVerificationError(
        "invalid_payload",
        "Webhook body is not a recognisable AhaSend event envelope",
      );
    }
    return parsed;
  }
}

function assertBodySize(rawBody: RawBody): void {
  const bytes = typeof rawBody === "string" ? Buffer.byteLength(rawBody, "utf-8") : rawBody.length;
  if (bytes > MAX_WEBHOOK_BODY_BYTES) {
    throw new AhaSendWebhookVerificationError("body_too_large");
  }
}

function parseTimestamp(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new AhaSendWebhookVerificationError("invalid_timestamp");
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new AhaSendWebhookVerificationError("invalid_timestamp");
  }
  return timestamp;
}

function extractHeaders(input: HeadersInput): NormalizedHeaders {
  const values = new Map<string, string | string[] | undefined>();
  if (!(input instanceof Headers)) {
    for (const [name, value] of Object.entries(input)) {
      const normalizedName = name.toLowerCase();
      if (!values.has(normalizedName)) values.set(normalizedName, value);
    }
  }

  const get = (name: string): string | undefined => {
    if (input instanceof Headers) return input.get(name) ?? undefined;
    const value = values.get(name);
    return Array.isArray(value) ? value[0] : value;
  };

  const id = get(WEBHOOK_ID_HEADER);
  const timestamp = get(WEBHOOK_TIMESTAMP_HEADER);
  const signature = get(WEBHOOK_SIGNATURE_HEADER);

  if (!id) throw new AhaSendWebhookVerificationError("missing_webhook_id");
  if (!timestamp) throw new AhaSendWebhookVerificationError("missing_webhook_timestamp");
  if (!signature) throw new AhaSendWebhookVerificationError("missing_webhook_signature");

  return { id, timestamp, signature };
}

function sign(key: Buffer, id: string, timestamp: string, rawBody: RawBody): string {
  const hmac = createHmac("sha256", key).update(id, "utf-8").update(".", "utf-8");
  hmac.update(timestamp, "utf-8").update(".", "utf-8").update(rawBody);
  return `v1,${hmac.digest("base64")}`;
}

function signatureMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, "utf-8");
  const expectedBytes = Buffer.from(expected, "utf-8");
  if (providedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(providedBytes, expectedBytes);
}
