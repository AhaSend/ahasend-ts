import { describe, expect, it } from "vitest";
import {
  AhaSendAPIError,
  AhaSendAuthenticationError,
  AhaSendBadRequestError,
  AhaSendNotFoundError,
  AhaSendPermissionError,
  AhaSendRateLimitError,
  AhaSendServerError,
  createApiError,
} from "../src/errors.js";

describe("createApiError", () => {
  it("maps 400 to AhaSendBadRequestError", () => {
    const err = createApiError({ status: 400, body: { message: "bad" } });
    expect(err).toBeInstanceOf(AhaSendBadRequestError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("bad");
  });

  it("maps 422 to AhaSendBadRequestError (includes idempotency mismatch)", () => {
    const err = createApiError({ status: 422, body: { message: "payload mismatch" } });
    expect(err).toBeInstanceOf(AhaSendBadRequestError);
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
