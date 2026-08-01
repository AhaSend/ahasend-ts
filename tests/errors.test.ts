import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { AhaSendClient } from "../src/client.js";
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
  createApiError,
  isAhaSendError,
} from "../src/errors.js";
import { AhaSendWebhookVerificationError as WebhookEntryError } from "../src/webhooks/index.js";
import { createIdempotencyExecutionRecord } from "../src/idempotency.js";
import { ACCOUNT_ID } from "./helpers/resource-call.js";

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
    "0",
    "-1",
    "1.5",
    "not-a-delay",
    "2099-12-31",
    "Sun, 31 Feb 2099 00:00:00 GMT",
    "Fri, 31 Dec 2099 23:59:59 GMT",
    "Thu, 31 Dec 2099 23:59:59 UTC",
    "Thu, 01 Jan 2026 23:59:61 GMT",
    "Thursday, 31-Dec-99 23:59:59 GMT",
  ])("treats malformed or nonpositive Retry-After %j as absent", (retryAfter) => {
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
    const recoveryKey = "reconcile-order-secret-key";
    const telemetryErrors: unknown[] = [];
    const fetch = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "still processing" }), {
          status: 409,
          headers: {
            "content-type": "application/json",
            "idempotent-replayed": "false",
            "retry-after": "1",
          },
        }),
      ),
    ) as unknown as typeof globalThis.fetch;
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
      await client.domains.create({ domain: "example.com" }, { idempotencyKey: recoveryKey });
    } catch (error) {
      caught = error;
    }
    await Promise.resolve();

    expect(caught).toBeInstanceOf(AhaSendIdempotencyConflictError);
    const error = caught as AhaSendIdempotencyConflictError;
    expect(error.idempotencyKey).toBe(recoveryKey);
    expect(fetch).toHaveBeenCalledTimes(2);
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
        accountId: "account-id",
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
