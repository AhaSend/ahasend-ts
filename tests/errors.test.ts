import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
import { isRetryableError } from "../src/retry.js";
import * as errors from "../src/errors.js";
import {
  AhaSendAbortError,
  AhaSendAPIError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendConflictError,
  AhaSendConfigurationError,
  AhaSendConnectionError,
  AhaSendError,
  AhaSendIdempotencyConflictError,
  AhaSendIdempotencyMismatchError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
  AhaSendRateLimitError,
  AhaSendResponseParseError,
  AhaSendServerError,
  AhaSendTimeoutError,
  AhaSendUnprocessableEntityError,
  AhaSendWebhookVerificationError,
  AhaSendRateLimitQueueFullError,
  createApiError,
  isAhaSendError,
} from "../src/errors.js";
import { AhaSendWebhookVerificationError as WebhookEntryError } from "../src/webhooks/index.js";
import { createIdempotencyExecutionRecord } from "../src/idempotency.js";
import { ACCOUNT_ID, captureFetch } from "./helpers/resource-call.js";

const ELIGIBLE_KEYED = createIdempotencyExecutionRecord(
  Object.freeze({ completion: "automatic" }),
  "stable-key",
);

describe("createApiError", () => {
  it("maps 400 to AhaSendBadRequestError", () => {
    const err = createApiError({ status: 400, body: { message: "bad" } });
    expect(err).toBeInstanceOf(AhaSendBadRequestError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad");
  });

  it("maps generic 422 to AhaSendUnprocessableEntityError (NOT a BadRequest)", () => {
    const err = createApiError({ status: 422, body: { message: "validation failed" } });
    expect(err).toBeInstanceOf(AhaSendUnprocessableEntityError);
    expect(err).toBeInstanceOf(AhaSendAPIError);
    // Important: 422 must NOT be caught by `catch (AhaSendBadRequestError)`.
    expect(err).not.toBeInstanceOf(AhaSendBadRequestError);
    expect(err).not.toBeInstanceOf(AhaSendIdempotencyMismatchError);
  });

  it("maps headerless 422 only for an eligible keyed execution", () => {
    const err = createApiError({
      status: 422,
      body: { message: "payload mismatch" },
      idempotency: ELIGIBLE_KEYED,
    });
    expect(err).toBeInstanceOf(AhaSendIdempotencyMismatchError);
    expect(err).toBeInstanceOf(AhaSendUnprocessableEntityError);
    expect(err).not.toBeInstanceOf(AhaSendBadRequestError);
  });

  it.each([
    ["a replay header", { "idempotent-replayed": "true" }],
    ["a retry header", { "retry-after": "3" }],
  ])("keeps eligible keyed 422 responses with %s generic", (_name, headers) => {
    const err = createApiError({
      status: 422,
      body: { message: "wording is irrelevant" },
      headers,
      idempotency: ELIGIBLE_KEYED,
    });

    expect(err.constructor).toBe(AhaSendUnprocessableEntityError);
    expect(err).not.toBeInstanceOf(AhaSendIdempotencyMismatchError);
  });

  it("keeps keyed-ineligible and eligible-unkeyed 422 responses generic", () => {
    const keyedIneligible = createIdempotencyExecutionRecord(null, "stable-key");
    const eligibleUnkeyed = createIdempotencyExecutionRecord(
      Object.freeze({ completion: "automatic" }),
      undefined,
    );

    for (const idempotency of [keyedIneligible, eligibleUnkeyed]) {
      expect(
        createApiError({ status: 422, body: { message: "changed" }, idempotency }),
      ).toBeInstanceOf(AhaSendUnprocessableEntityError);
    }
  });

  it("maps generic 409 to AhaSendConflictError (e.g. duplicate domain)", () => {
    const err = createApiError({ status: 409, body: { message: "domain exists" } });
    expect(err).toBeInstanceOf(AhaSendConflictError);
    expect(err).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
  });

  it("keeps every production duplicate 409 a terminal conflict, never a retry", () => {
    // The exact bodies the API emits for duplicate creates. They share the
    // 409 status with the idempotency in-progress state but never its header
    // tuple — the middleware sets `Idempotent-Replayed: false` + `Retry-After`
    // only on its own early return, so a handler duplicate cannot carry them.
    for (const message of [
      "domain already exists",
      "user is already a member of this account",
      "suppression already exists",
    ]) {
      const err = createApiError({
        status: 409,
        body: { message },
        headers: {},
        idempotency: ELIGIBLE_KEYED,
      });
      expect(err, message).toBeInstanceOf(AhaSendConflictError);
      expect(err, message).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
      expect(isRetryableError(err), message).toBe(false);
      expect(err.message).toBe(message);
    }
  });

  it("maps the complete eligible 409 in-progress tuple", () => {
    const err = createApiError({
      status: 409,
      body: { message: "in progress" },
      headers: { "idempotent-replayed": "false", "retry-after": "3" },
      idempotency: ELIGIBLE_KEYED,
    });
    expect(err).toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(err).toBeInstanceOf(AhaSendConflictError);
    expect((err as AhaSendIdempotencyConflictError).retryAfterSeconds).toBe(3);
  });

  it.each([
    ["missing replay header", { "retry-after": "3" }],
    ["wrong replay value", { "idempotent-replayed": "true", "retry-after": "3" }],
    ["missing delay", { "idempotent-replayed": "false" }],
    ["zero delay", { "idempotent-replayed": "false", "retry-after": "0" }],
    ["negative delay", { "idempotent-replayed": "false", "retry-after": "-1" }],
    ["fractional delay", { "idempotent-replayed": "false", "retry-after": "1.5" }],
    ["space-prefixed delay", { "idempotent-replayed": "false", "retry-after": " 1" }],
    ["unsafe integer delay", { "idempotent-replayed": "false", "retry-after": "9007199254740992" }],
    [
      "date delay",
      { "idempotent-replayed": "false", "retry-after": "Wed, 21 Oct 2037 07:28:00 GMT" },
    ],
  ])("keeps 409 generic with %s", (_name, headers) => {
    const err = createApiError({
      status: 409,
      body: { message: "arbitrary conflict text" },
      headers,
      idempotency: ELIGIBLE_KEYED,
    });
    expect(err.constructor).toBe(AhaSendConflictError);
  });

  it("keeps the exact in-progress headers generic without eligible keyed context", () => {
    const headers = { "idempotent-replayed": "false", "retry-after": "3" };
    expect(createApiError({ status: 409, body: null, headers }).constructor).toBe(
      AhaSendConflictError,
    );
    expect(
      createApiError({
        status: 409,
        body: null,
        headers,
        idempotency: createIdempotencyExecutionRecord(null, "stable-key"),
      }).constructor,
    ).toBe(AhaSendConflictError);
  });

  it("does not define a special 412 class or mapping", () => {
    const err = createApiError({ status: 412, body: { message: "original failed" } });
    expect(err.constructor).toBe(AhaSendAPIError);
    expect(err.status).toBe(412);
    expect(errors).not.toHaveProperty("AhaSendIdempotencyPreconditionFailedError");
  });

  it("maps 401 to AhaSendAuthenticationError", () => {
    const err = createApiError({ status: 401, body: null });
    expect(err).toBeInstanceOf(AhaSendAuthenticationError);
    expect(err.message).toMatch(/401/);
  });

  it("maps 403 to AhaSendPermissionError", () => {
    const err = createApiError({ status: 403, body: { message: "forbidden" } });
    expect(err).toBeInstanceOf(AhaSendPermissionError);
  });

  it("maps 404 to AhaSendNotFoundError", () => {
    const err = createApiError({ status: 404, body: { message: "missing" } });
    expect(err).toBeInstanceOf(AhaSendNotFoundError);
  });

  it("maps 429 to AhaSendRateLimitError and parses Retry-After", () => {
    const err = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": "12" },
    });
    expect(err).toBeInstanceOf(AhaSendRateLimitError);
    expect((err as AhaSendRateLimitError).retryAfterSeconds).toBe(12);
  });

  it("accepts a zero-second Retry-After for generic 429 responses", () => {
    const err = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": "0" },
    });

    expect(err).toBeInstanceOf(AhaSendRateLimitError);
    expect((err as AhaSendRateLimitError).retryAfterSeconds).toBe(0);
  });

  it.each([
    "Fri, 02 Jan 2026 00:00:00 GMT",
    "Friday, 02-Jan-26 00:00:00 GMT",
    "Fri Jan  2 00:00:00 2026",
    "Thu, 01 Jan 2026 23:59:60 GMT",
  ])("parses RFC 9110 HTTP-date form %j", (retryAfter) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    const err = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": retryAfter },
    }) as AhaSendRateLimitError;

    expect(err.retryAfterSeconds).toBe(86_400);
    now.mockRestore();
  });

  it("applies the RFC 850 rollover at the exact 50-year timestamp boundary", () => {
    const currentTime = Date.UTC(2026, 6, 22);
    const now = vi.spyOn(Date, "now").mockReturnValue(currentTime);

    const atBoundary = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": "Wednesday, 22-Jul-76 00:00:00 GMT" },
    }) as AhaSendRateLimitError;
    const overBoundary = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": "Thursday, 23-Jul-76 00:00:00 GMT" },
    }) as AhaSendRateLimitError;

    expect(atBoundary.retryAfterSeconds).toBe((Date.UTC(2076, 6, 22) - currentTime) / 1000);
    expect(overBoundary.retryAfterSeconds).toBeUndefined();
    now.mockRestore();
  });

  it.each([
    "-1",
    "1.5",
    "not-a-delay",
    "2099-12-31",
    "Sun, 31 Feb 2099 00:00:00 GMT",
    "Fri, 31 Dec 2099 23:59:59 GMT",
    "Thu, 31 Dec 2099 23:59:59 UTC",
    "Thu, 01 Jan 2026 23:59:61 GMT",
    "Thursday, 31-Dec-99 23:59:59 GMT",
  ])("treats malformed or negative Retry-After %j as absent", (retryAfter) => {
    const err = createApiError({
      status: 429,
      body: null,
      headers: { "retry-after": retryAfter },
    }) as AhaSendRateLimitError;
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("does not use messages to alter 403, 409, or 422 classification", () => {
    for (const message of ["in progress", "payload mismatch", "completely changed"]) {
      expect(createApiError({ status: 403, body: { message } })).toBeInstanceOf(
        AhaSendPermissionError,
      );
      expect(createApiError({ status: 409, body: { message } }).constructor).toBe(
        AhaSendConflictError,
      );
      expect(createApiError({ status: 422, body: { message } }).constructor).toBe(
        AhaSendUnprocessableEntityError,
      );
    }
  });

  it("maps 500 to AhaSendServerError", () => {
    const err = createApiError({ status: 500, body: { message: "boom" } });
    expect(err).toBeInstanceOf(AhaSendServerError);
  });

  it("falls back to AhaSendAPIError for unknown 4xx", () => {
    const err = createApiError({ status: 418, body: null });
    expect(err).toBeInstanceOf(AhaSendAPIError);
    expect(err).not.toBeInstanceOf(AhaSendBadRequestError);
  });

  it("accepts string bodies", () => {
    const err = createApiError({ status: 500, body: "internal error" });
    expect(err.body).toBe("internal error");
    expect(err.message).toBe("internal error");
  });

  it("preserves requestId and headers", () => {
    const err = createApiError({
      status: 400,
      body: { message: "nope" },
      requestId: "req_abc",
      headers: { "x-request-id": "req_abc" },
    });
    expect(err.requestId).toBe("req_abc");
    expect(err.headers["x-request-id"]).toBe("req_abc");
  });
});

describe("AhaSend error contract", () => {
  const apiParams = { status: 400, message: "failed", body: null };

  it.each([
    [new AhaSendError("failed"), "ahasend_error"],
    [new AhaSendConfigurationError("failed"), "configuration_error"],
    [new AhaSendConnectionError("failed"), "connection_error"],
    [new AhaSendAbortError(), "abort_error"],
    [new AhaSendTimeoutError(), "timeout_error"],
    [new AhaSendResponseParseError({ status: 200, body: "invalid" }), "response_parse_error"],
    [new AhaSendAPIError(apiParams), "api_error"],
    [new AhaSendAuthenticationError(apiParams), "authentication_error"],
    [new AhaSendPermissionError(apiParams), "permission_error"],
    [new AhaSendNotFoundError(apiParams), "not_found_error"],
    [new AhaSendBadRequestError(apiParams), "bad_request_error"],
    [new AhaSendConflictError(apiParams), "conflict_error"],
    [new AhaSendIdempotencyConflictError(apiParams), "idempotency_conflict_error"],
    [new AhaSendUnprocessableEntityError(apiParams), "unprocessable_entity_error"],
    [new AhaSendIdempotencyMismatchError(apiParams), "idempotency_mismatch_error"],
    [new AhaSendRateLimitError(apiParams), "rate_limit_error"],
    [new AhaSendServerError(apiParams), "server_error"],
    [new AhaSendWebhookVerificationError("signature_mismatch"), "webhook_verification_error"],
  ])("assigns stable code %s", (error, code) => {
    expect(error.code).toBe(code);
    expect(isAhaSendError(error)).toBe(true);
    expect(AhaSendError.is(error)).toBe(true);
    expect(AhaSendAPIError.is(error)).toBe(error instanceof AhaSendAPIError);
  });

  it("does not let direct base errors impersonate subtype codes", () => {
    const error = new AhaSendError("failed", "server_error");

    expect(error.code).toBe("ahasend_error");
    expect(error.cause).toBe("server_error");
  });

  it("uses the global brand for static cross-module guards", () => {
    const brandedBaseError = {
      [Symbol.for("@ahasend/sdk.error")]: true,
      code: "configuration_error",
    };
    const brandedApiError = {
      [Symbol.for("@ahasend/sdk.error")]: true,
      code: "api_error",
    };

    expect(AhaSendError.is(brandedBaseError)).toBe(true);
    expect(AhaSendAPIError.is(brandedBaseError)).toBe(false);
    expect(AhaSendError.is(brandedApiError)).toBe(true);
    expect(AhaSendAPIError.is(brandedApiError)).toBe(true);
    expect(isAhaSendError(brandedApiError)).toBe(true);
  });

  it.each([
    ["an ordinary Error", new Error("failed")],
    ["an unbranded API-shaped value", { code: "api_error", status: 400 }],
    ["a false brand", { [Symbol.for("@ahasend/sdk.error")]: false, code: "api_error" }],
    ["null", null],
    ["undefined", undefined],
    ["a primitive", "failed"],
  ])("rejects %s with both static guards", (_name, value) => {
    expect(AhaSendError.is(value)).toBe(false);
    expect(AhaSendAPIError.is(value)).toBe(false);
  });

  it("rejects values whose branded properties cannot be read", () => {
    const inaccessibleBrand = new Proxy(
      {},
      {
        get() {
          throw new Error("inaccessible");
        },
      },
    );
    const inaccessibleCode = new Proxy(
      { [Symbol.for("@ahasend/sdk.error")]: true },
      {
        get(target, property, receiver) {
          if (property === "code") throw new Error("inaccessible");
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(AhaSendError.is(inaccessibleBrand)).toBe(false);
    expect(AhaSendAPIError.is(inaccessibleBrand)).toBe(false);
    expect(AhaSendError.is(inaccessibleCode)).toBe(true);
    expect(AhaSendAPIError.is(inaccessibleCode)).toBe(false);
  });

  it("preserves applicable causes as non-enumerable properties", () => {
    const cause = new Error("socket included a secret-token");
    const connection = new AhaSendConnectionError("network failed", cause);
    const configuration = new AhaSendConfigurationError("bad option", cause);

    expect(connection.cause).toBe(cause);
    expect(configuration.cause).toBe(cause);
    expect(Object.keys(connection)).not.toContain("cause");
    expect(Object.keys(configuration)).not.toContain("cause");
  });

  it("keeps diagnostics readable but redacts serialization and inspection", () => {
    const cause = new Error("cause-secret");
    const malformedWireBody: unknown = {
      message: "request failed",
      details: "body-secret",
    };
    const error = new AhaSendIdempotencyConflictError({
      status: 409,
      message: "request failed",
      body: malformedWireBody as errors.ApiErrorBody,
      requestId: "request-id",
      headers: { "idempotency-key": "header-secret" },
      cause,
    });

    expect(error.body).toEqual({ message: "request failed", details: "body-secret" });
    expect(error.headers["idempotency-key"]).toBe("header-secret");
    expect(error.cause).toBe(cause);
    expect(Object.keys(error)).toEqual([]);

    const json = JSON.stringify(error);
    const rendered = inspect(error);
    for (const secret of ["body-secret", "header-secret", "cause-secret"]) {
      expect(json).not.toContain(secret);
      expect(rendered).not.toContain(secret);
    }
    expect(JSON.parse(json)).toEqual({
      name: "AhaSendIdempotencyConflictError",
      code: "idempotency_conflict_error",
      message: "request failed",
      status: 409,
      requestId: "request-id",
      body: "[REDACTED]",
      headers: "[REDACTED]",
      cause: "[REDACTED]",
    });
  });

  it("exposes only the exhausted conflict recovery key to the caller", async () => {
    const telemetryErrors: unknown[] = [];
    const { fetch, calls } = captureFetch(
      () =>
        new Response(JSON.stringify({ message: "still processing" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "idempotent-replayed": "false",
            "retry-after": "1",
          },
        }),
    );
    const client = new AhaSendClient({
      apiKey: "aha-sk-test",
      accountId: ACCOUNT_ID,
      baseUrl: "https://api.test",
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: false },
      hooks: {
        onError: (event) => {
          telemetryErrors.push(event.error);
        },
      },
    });

    let caught: unknown;
    try {
      await client.domains.create({ domain: "example.com" });
    } catch (error) {
      caught = error;
    }
    await Promise.resolve();

    expect(caught).toBeInstanceOf(AhaSendIdempotencyConflictError);
    const error = caught as AhaSendIdempotencyConflictError;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
    const recoveryKey = calls[0]?.headers["idempotency-key"];
    expect(recoveryKey).toEqual(expect.any(String));
    expect(recoveryKey).not.toHaveLength(0);
    expect(calls.map((call) => call.headers["idempotency-key"])).toEqual([
      recoveryKey,
      recoveryKey,
    ]);
    expect(error.idempotencyKey).toBe(recoveryKey);
    expect(Object.getOwnPropertyDescriptor(error, "idempotencyKey")).toMatchObject({
      enumerable: false,
      writable: false,
      value: recoveryKey,
    });
    expect(Object.keys(error)).not.toContain("idempotencyKey");
    expect(Object.entries(error)).not.toContainEqual(["idempotencyKey", recoveryKey]);
    expect({ ...error }).not.toHaveProperty("idempotencyKey");

    expect(telemetryErrors).toHaveLength(2);
    for (const telemetryError of telemetryErrors) {
      expect((telemetryError as AhaSendIdempotencyConflictError).idempotencyKey).toBeUndefined();
    }

    const diagnostics = [
      JSON.stringify(error),
      inspect(error),
      inspect(error, { showHidden: true }),
      JSON.stringify(telemetryErrors),
      inspect(telemetryErrors, { showHidden: true }),
    ];
    for (const diagnostic of diagnostics) {
      expect(diagnostic).not.toContain(recoveryKey);
      expect(diagnostic).not.toContain("idempotencyKey");
    }
  });

  it("does not expose rejected base URL credentials in messages or safe renderings", () => {
    const username = "credential-user";
    const password = "credential-secret";
    let error: unknown;

    try {
      new AhaSendClient({
        apiKey: "aha-sk-test",
        accountId: "22222222-2222-4222-8222-222222222222",
        baseUrl: `https://${username}:${password}@example.com`,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AhaSendConfigurationError);
    for (const rendered of [String(error), JSON.stringify(error), inspect(error)]) {
      expect(rendered).not.toContain(username);
      expect(rendered).not.toContain(password);
    }
  });

  it("shares the webhook error constructor between the core source and webhook entry", () => {
    expect(WebhookEntryError).toBe(AhaSendWebhookVerificationError);
  });
});

describe("error messages derived from a response body", () => {
  // A non-JSON error body is whatever sat in front of the API. Using it
  // verbatim made `error.message` as large as that page — repeated per retry
  // attempt and printed by every default logger.
  it("bounds a large non-JSON body without discarding it", () => {
    const page = `<!DOCTYPE html>\n<html>\n  <head>\n    <title>502 Bad Gateway</title>\n  </head>\n  <body>${"x".repeat(300_000)}</body>\n</html>`;
    const error = createApiError({ status: 502, body: page, headers: {} });

    expect(page.length).toBeGreaterThan(200_000);
    // Exact, not "under 300": 200 characters plus the marker.
    expect(error.message).toHaveLength(266);
    expect(error.message.endsWith("not in logs)")).toBe(true);
    // The identifying part of the page survives the truncation.
    expect(error.message).toContain("502 Bad Gateway");
    expect(error.message).toContain("truncated");
    // Nothing is lost: the full body is still on the error.
    expect(error.body).toBe(page);
  });

  it("collapses whitespace so a message cannot span log lines", () => {
    const error = createApiError({
      status: 502,
      body: "upstream\n\n  failed\ton\r\n  gateway",
      headers: {},
    });

    expect(error.message).toBe("upstream failed on gateway");
    expect(error.message).not.toMatch(/[\n\r\t]/u);
  });

  it("passes a short body through unchanged", () => {
    expect(createApiError({ status: 502, body: "Bad Gateway", headers: {} }).message).toBe(
      "Bad Gateway",
    );
  });

  it("bounds a structured API message too", () => {
    // The JSON `message` field is the API's own contract, but a broken or
    // hostile upstream can still make it enormous.
    const error = createApiError({
      status: 422,
      body: { message: "z".repeat(10_000) },
      headers: {},
    });

    expect(error.message).toHaveLength(266);
  });

  it.each([
    ["a bare newline", "\n"],
    ["spaces and tabs", "   \n\t "],
    ["a lone byte-order mark", "\uFEFF"],
    ["a blank structured message", { message: "   " }],
    ["an empty structured message", { message: "" }],
  ])("falls back to the status message when the body is %s", (_label, body) => {
    // These arrive from misconfigured intermediaries all the time. Collapsing
    // them to "" and returning it would satisfy the `??` fallback's nullish
    // check without satisfying its purpose, leaving an error whose message is
    // the empty string.
    expect(createApiError({ status: 502, body: body as string, headers: {} }).message).toBe(
      "AhaSend API error (HTTP 502)",
    );
  });

  it("strips control and formatting characters a whitespace pass would miss", () => {
    // `\s` matches neither the C0 controls nor NEL nor the bidi overrides, so
    // an intermediary's error page could otherwise carry terminal escape
    // sequences into console.error through the debug logger.
    const hostile = "\u001b[2J\u001b[1;1Hlooks official\u0007\u0000 \u0085 next \u202e reversed";
    const message = createApiError({ status: 502, body: hostile, headers: {} }).message;

    for (const control of ["\u001b", "\u0007", "\u0000", "\u0085", "\u202e"]) {
      expect(message, control).not.toContain(control);
    }
    expect(message).toContain("looks official");
  });

  it("never truncates onto half a surrogate pair", () => {
    // A cut mid-pair is lossy through UTF-8 (the half becomes U+FFFD) and
    // strict JSON readers reject the unpaired escape, so the log line is
    // dropped rather than shortened.
    const message = createApiError({
      status: 502,
      body: `Blocked: ${"\u{1F4A5}".repeat(400)}`,
      headers: {},
    }).message;

    // No unpaired surrogate: a high surrogate not followed by a low one, or a
    // low surrogate not preceded by a high one.
    expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    // The practical consequence: a lone surrogate does not survive UTF-8.
    expect(Buffer.from(message, "utf8").toString("utf8")).toBe(message);
  });

  it.each([
    [199, false],
    [200, false],
    [201, true],
  ])("truncates a %i-character body: %s", (length, truncated) => {
    const message = createApiError({
      status: 502,
      body: "a".repeat(length),
      headers: {},
    }).message;

    expect(message.includes("truncated")).toBe(truncated);
    expect(message).toHaveLength(truncated ? 266 : length);
  });

  it("scans only a bounded prefix of the body", () => {
    // Collapsing the whole body allocated a near-full-size copy, and the
    // sliced result PINNED it — V8 keeps a slice as a view over its parent —
    // so a 229-character message retained the page a second time on top of
    // `error.body`. Measured on a 371 KB 502: 6.5 MB retained across 20 errors
    // and 2.5 ms each, against 0.5 MB and 0.09 ms once bounded.
    //
    // The trade-off, pinned here so it is a decision rather than a surprise:
    // content sitting past the scan budget is not found. Only a body that is
    // almost entirely leading whitespace can hit this.
    const beyondBudget = `${" ".repeat(200 * 32 + 10)}the real error text`;
    expect(createApiError({ status: 502, body: beyondBudget, headers: {} }).message).toBe(
      "AhaSend API error (HTTP 502)",
    );

    // Just inside the budget, the text is still found.
    const withinBudget = `${" ".repeat(100)}the real error text`;
    expect(createApiError({ status: 502, body: withinBudget, headers: {} }).message).toBe(
      "the real error text",
    );
  });

  it("still falls back to a status message for an empty body", () => {
    expect(createApiError({ status: 500, body: "", headers: {} }).message).toBe(
      "AhaSend API error (HTTP 500)",
    );
  });
});

describe("cause serialization", () => {
  const apiError = () =>
    createApiError({
      status: 503,
      body: { message: "upstream exploded" },
      requestId: "req-123",
      headers: { "x-secret": "nope" },
    });

  // The one in-SDK path that nests a cause had no test at all.
  it("serialises a nested SDK cause while keeping its body and headers redacted", () => {
    const wrapped = new AhaSendRateLimitQueueFullError("standard", 1_000, apiError());
    const json = wrapped.toJSON();

    expect(json.cause).toMatchObject({
      name: "AhaSendServerError",
      code: "server_error",
      message: "upstream exploded",
      status: 503,
      requestId: "req-123",
      body: "[REDACTED]",
      headers: "[REDACTED]",
    });
  });

  it("still redacts a non-SDK cause", () => {
    const wrapped = new AhaSendRateLimitQueueFullError(
      "standard",
      1_000,
      new TypeError("fetch failed: secret-host"),
    );

    expect(wrapped.toJSON().cause).toBe("[REDACTED]");
  });

  // toJSON runs inside the consumer's catch block and inside their logger, so
  // a serializer that throws turns a handled failure into an unhandled crash
  // in the handler meant to contain it.
  it("does not throw on a branded value that is not an SDK error", () => {
    // The brand is a global-registry symbol, so any code in the process can
    // set it; being branded does not imply having toJSON.
    const impostor = { [Symbol.for("@ahasend/sdk.error")]: true, name: "X" };
    const wrapped = new AhaSendRateLimitQueueFullError("standard", 1, impostor);

    expect(() => JSON.stringify(wrapped)).not.toThrow();
    expect(wrapped.toJSON().cause).toBe("[REDACTED]");
  });

  it("does not recurse forever on a cyclic cause chain", () => {
    const cyclic = apiError();
    Object.defineProperty(cyclic, "cause", { value: cyclic, configurable: true });

    expect(() => JSON.stringify(cyclic)).not.toThrow();
    expect(() => inspect(cyclic)).not.toThrow();
  });

  // `JSON.stringify` calls `toJSON` with the holder's property key, which
  // shadows the `depth` default. Before the key was coerced away, the cap
  // compared strings: at the root it fired after 2 levels instead of 4, and
  // under a property key — how every structured logger nests an error — it
  // never fired at all.
  const chain = (length: number): AhaSendError => {
    let error: AhaSendError = apiError();
    for (let index = 1; index < length; index++) {
      error = new AhaSendRateLimitQueueFullError("standard", 1_000, error);
    }
    return error;
  };

  const causeDepth = (serialized: unknown): number => {
    let depth = 0;
    let cursor = (serialized as { cause?: unknown }).cause;
    while (typeof cursor === "object" && cursor !== null) {
      depth += 1;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return depth;
  };

  it("caps the cause chain at the same depth from JSON.stringify as from toJSON()", () => {
    const direct = chain(8).toJSON();
    const atRoot = JSON.parse(JSON.stringify(chain(8))) as unknown;

    expect(causeDepth(direct)).toBe(4);
    expect(causeDepth(atRoot)).toBe(4);
  });

  it("caps the cause chain when the error is serialized under a property key", () => {
    const nested = JSON.parse(JSON.stringify({ error: chain(8) })) as { error: unknown };

    expect(causeDepth(nested.error)).toBe(4);
  });

  it("bounds a cyclic cause chain serialized under a property key", () => {
    const first = apiError();
    const second = new AhaSendRateLimitQueueFullError("standard", 1_000, first);
    Object.defineProperty(first, "cause", { value: second, configurable: true });

    const serialized = JSON.stringify({ error: second });

    // Without the cap this recursed to the stack limit and emitted close to a
    // megabyte per log line; with it, four levels then "[REDACTED]".
    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).toContain('"[REDACTED]"');
  });

  it("does not let a negative caller-supplied depth buy recursion past the cap", () => {
    // toJSON(depth) is public API; a finite negative start such as -10000
    // would satisfy a `>= MAX_CAUSE_DEPTH` guard only after that many extra
    // levels — on a cyclic chain, a silent near-stack-limit recursion again.
    expect(causeDepth(chain(8).toJSON(-10_000))).toBe(4);
    expect(causeDepth(chain(8).toJSON(2.5))).toBe(4);
  });

  it("redacts a branded cause whose toJSON returns an unstringifiable value", () => {
    // The brand is a global-registry symbol, so `toJSON` may not be ours: one
    // that RETURNS a cyclic structure (rather than throwing) used to be
    // spliced in verbatim and blew up JSON.stringify later, inside the
    // consumer's logger — the exact crash serializeCause exists to prevent.
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const impostor = {
      [Symbol.for("@ahasend/sdk.error")]: true,
      toJSON: () => cyclic,
    };
    const wrapped = new AhaSendRateLimitQueueFullError("standard", 1, impostor);

    expect(() => JSON.stringify(wrapped)).not.toThrow();
    expect(wrapped.toJSON().cause).toBe("[REDACTED]");
  });
});
