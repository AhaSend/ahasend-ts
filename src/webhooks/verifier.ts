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
export const MAX_WEBHOOK_BODY_BYTES = 30_000_000;

/**
 * `ignoreBOM: true` keeps a leading U+FEFF in the decoded text instead of
 * stripping it, which is what `Buffer.prototype.toString("utf-8")` does. The
 * signature covers the raw bytes either way, so this only decides whether a
 * BOM-prefixed body reaches `JSON.parse` unchanged — and it should, so that a
 * body which used to be reported as `invalid_json` still is.
 */
const utf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });

export interface WebhookVerifierOptions {
  toleranceSeconds?: number | undefined;
}

interface NormalizedHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

/**
 * The `get` half of the WHATWG `Headers` interface.
 *
 * Accepted structurally rather than by class, so any `Headers` works — the
 * realm's global one, a separately installed `undici` or `node-fetch`, an edge
 * runtime's, or one that crossed a realm boundary. Express's `req` and Koa's
 * `ctx.request` satisfy it too, since their `get` is a header lookup.
 */
export interface WebhookHeadersLike {
  /**
   * Look up a header. Must be **case-insensitive**, as WHATWG `Headers`
   * requires: this SDK asks for the lowercase names only. A case-sensitive
   * container such as a bare `Map` structurally satisfies this type but will
   * report every header missing unless its keys are already lowercased.
   */
  get(name: string): string | null | undefined;
}

/**
 * Webhook headers, as either a plain record (`req.headers` on express,
 * Fastify, and `http.IncomingMessage`) or anything with a `Headers`-style
 * `get`.
 */
export type WebhookHeadersInput =
  | Record<string, string | string[] | undefined>
  | WebhookHeadersLike;

/**
 * Raw request body to verify: the exact bytes received, unparsed.
 *
 * `Uint8Array` rather than `Buffer` so the published declarations do not
 * require `@types/node`. Every `Buffer` is a `Uint8Array`, so passing
 * `req.rawBody` straight through still type-checks.
 */
export type WebhookRawBody = string | Uint8Array;
type Clock = () => number;

const verifierClocks = new WeakMap<WebhookVerifier, Clock>();

export class WebhookVerifier {
  readonly #key: Buffer;
  readonly #toleranceSeconds: number;

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
    this.#key = Buffer.from(secret, "utf-8");
    this.#toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  }

  verify(headers: WebhookHeadersInput, rawBody: WebhookRawBody): void {
    assertBodySize(rawBody);
    const { id, timestamp, signature } = extractHeaders(headers);

    const timestampSeconds = parseTimestamp(timestamp);
    const nowMilliseconds = (verifierClocks.get(this) ?? Date.now)();
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

  /**
   * Verify, parse, validate, and normalize a webhook event.
   *
   * Because `AnyWebhookEvent` includes a forward-compatible
   * `UnknownWebhookEvent` whose `type` is a plain `string`, a bare
   * `switch (event.type)` does **not** narrow `event.data` — every branch still
   * includes the unknown member, so `data` stays `unknown`. Narrow with
   * {@link isKnownWebhookEvent} first:
   *
   * ```ts
   * if (!isKnownWebhookEvent(event)) return; // future event type
   * switch (event.type) {
   *   case "message.bounced":
   *     await suppress(event.data.recipient); // fully typed
   *     break;
   * }
   * ```
   */
  parse(headers: WebhookHeadersInput, rawBody: WebhookRawBody): AnyWebhookEvent {
    this.verify(headers, rawBody);
    const text = typeof rawBody === "string" ? rawBody : utf8Decoder.decode(rawBody);
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
        return { ...parsed, type: "message.routing" };
      }
      return parsed;
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

/**
 * Internal source-test seam. This is intentionally omitted from the public
 * webhook entry point so consumers cannot replace the verifier clock.
 */
export function createWebhookVerifierWithClock(
  secret: string,
  nowMs: Clock,
  options: WebhookVerifierOptions = {},
): WebhookVerifier {
  const verifier = new WebhookVerifier(secret, options);
  verifierClocks.set(verifier, nowMs);
  return verifier;
}

function assertBodySize(rawBody: WebhookRawBody): void {
  const bytes =
    typeof rawBody === "string" ? Buffer.byteLength(rawBody, "utf-8") : rawBody.byteLength;
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

/**
 * Detect a `Headers` by capability, not by class.
 *
 * `instanceof Headers` is false for every `Headers` that is not the realm's
 * global class object — a separately installed `undici` or `node-fetch`, an
 * edge runtime's, or any value that crossed a realm boundary. Such an object
 * then falls through to the plain-record path, where `Object.entries` returns
 * `[]` because the headers live in internal slots, and every header reports as
 * missing. The adapters map that to HTTP 400, and 100 consecutive errors
 * disable the webhook.
 *
 * A plain header record cannot collide with this test: its values are
 * `string | string[] | undefined`, so a literal `get` key is never a function.
 */
function isHeadersLike(input: WebhookHeadersInput): input is WebhookHeadersLike {
  return typeof (input as Partial<WebhookHeadersLike>).get === "function";
}

/** Node reports repeated headers as an array; the first value is the one signed. */
function firstValue(value: string | string[] | undefined): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function extractHeaders(input: WebhookHeadersInput): NormalizedHeaders {
  const headersLike = isHeadersLike(input);
  const values = new Map<string, string | string[] | undefined>();
  if (!headersLike) {
    for (const [name, value] of Object.entries(input)) {
      const normalizedName = name.toLowerCase();
      if (!values.has(normalizedName)) values.set(normalizedName, value);
    }
  }

  // Both branches end in the same string check. A header source is caller
  // supplied — a foreign `Headers` is not bound by the WHATWG return contract,
  // and a JavaScript caller can put anything in a plain record — so a
  // non-string is reported as a missing header rather than reaching `sign()`,
  // where it throws a bare ERR_INVALID_ARG_TYPE from inside node:crypto.
  // Failing closed is right here: this is the signature path, and a header we
  // cannot read is a header we cannot verify against.
  const get = (name: string): string | undefined => {
    const value = headersLike ? input.get(name) : firstValue(values.get(name));
    return typeof value === "string" ? value : undefined;
  };

  const id = get(WEBHOOK_ID_HEADER);
  const timestamp = get(WEBHOOK_TIMESTAMP_HEADER);
  const signature = get(WEBHOOK_SIGNATURE_HEADER);

  if (!id) throw new AhaSendWebhookVerificationError("missing_webhook_id");
  if (!timestamp) throw new AhaSendWebhookVerificationError("missing_webhook_timestamp");
  if (!signature) throw new AhaSendWebhookVerificationError("missing_webhook_signature");

  return { id, timestamp, signature };
}

function sign(key: Buffer, id: string, timestamp: string, rawBody: WebhookRawBody): string {
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
