import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
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

  it("maps 422 with Idempotent-Replayed header to AhaSendIdempotencyMismatchError", () => {
    const err = createApiError({
      status: 422,
      body: { message: "payload mismatch" },
      headers: { "idempotent-replayed": "false" },
    });
    expect(err).toBeInstanceOf(AhaSendIdempotencyMismatchError);
    expect(err).toBeInstanceOf(AhaSendUnprocessableEntityError);
    expect(err).not.toBeInstanceOf(AhaSendBadRequestError);
  });

  it("maps generic 409 to AhaSendConflictError (e.g. duplicate domain)", () => {
    const err = createApiError({ status: 409, body: { message: "domain exists" } });
    expect(err).toBeInstanceOf(AhaSendConflictError);
    expect(err).not.toBeInstanceOf(AhaSendIdempotencyConflictError);
  });

  it("maps 409 with Idempotent-Replayed header to AhaSendIdempotencyConflictError", () => {
    const err = createApiError({
      status: 409,
      body: { message: "in progress" },
      headers: { "idempotent-replayed": "false" },
    });
    expect(err).toBeInstanceOf(AhaSendIdempotencyConflictError);
    expect(err).toBeInstanceOf(AhaSendConflictError);
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
  });

  it("does not let direct base errors impersonate subtype codes", () => {
    const error = new AhaSendError("failed", "server_error");

    expect(error.code).toBe("ahasend_error");
    expect(error.cause).toBe("server_error");
  });

  it("uses a global brand without accepting ordinary Error objects", () => {
    const brandedFromAnotherModule = {
      [Symbol.for("@ahasend/sdk.error")]: true,
      code: "api_error",
    };

    expect(isAhaSendError(brandedFromAnotherModule)).toBe(true);
    expect(isAhaSendError(new Error("failed"))).toBe(false);
    expect(isAhaSendError(null)).toBe(false);
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
    const error = new AhaSendIdempotencyConflictError({
      status: 409,
      message: "request failed",
      body: { message: "request failed", details: "body-secret" },
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

  it("shares the webhook error constructor between the core source and webhook entry", () => {
    expect(WebhookEntryError).toBe(AhaSendWebhookVerificationError);
  });
});
