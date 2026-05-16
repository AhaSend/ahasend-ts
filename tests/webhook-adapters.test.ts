import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  expressWebhookHandler,
  fastifyWebhookHandler,
  nextRouteHandler,
  type ExpressHandler,
} from "../src/webhooks/adapters.js";
import type { WebhookEvent } from "../src/webhooks/events.js";
import { WebhookVerifier } from "../src/webhooks/verifier.js";

// AhaSend webhook secrets are raw strings — the HMAC key is the literal
// UTF-8 bytes of the secret, matching the Go SDK.
const SECRET = "aha-whsec-local-test-secret-please-rotate";

function signEnvelope(body: string, opts: { id?: string; tsSec?: number } = {}): {
  headers: Record<string, string>;
} {
  const id = opts.id ?? "msg_test_1";
  const tsSec = opts.tsSec ?? Math.floor(Date.now() / 1000);
  const sig = `v1,${createHmac("sha256", Buffer.from(SECRET, "utf-8"))
    .update(`${id}.${tsSec}.${body}`)
    .digest("base64")}`;
  return {
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(tsSec),
      "webhook-signature": sig,
    },
  };
}

const eventBody = JSON.stringify({
  type: "message.delivered",
  timestamp: new Date().toISOString(),
  data: {
    account_id: "acc_1",
    event: "delivered",
    from: "a@b.com",
    recipient: "x@y.com",
    subject: "hi",
    message_id_header: "<x@y>",
    id: "msg_1",
  },
});

class MockExpressRes {
  statusCode = 0;
  writableEnded = false;
  body: string | undefined;
  end(payload?: string | Buffer): void {
    this.writableEnded = true;
    if (payload !== undefined) {
      this.body = typeof payload === "string" ? payload : payload.toString("utf-8");
    }
  }
}

describe("expressWebhookHandler", () => {
  it("verifies, parses, and invokes the handler with a typed event", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const received: WebhookEvent[] = [];
    const handler: ExpressHandler = async (event) => {
      received.push(event);
    };
    const middleware = expressWebhookHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    const req = { headers, rawBody: eventBody };
    const res = new MockExpressRes();

    await middleware(req, res);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("message.delivered");
    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(true);
  });

  it("returns a generic 400 on signature mismatch (no reason echoed)", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn();
    const middleware = expressWebhookHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    const tamperedBody = eventBody.replace("hi", "TAMPERED");
    const req = { headers, rawBody: tamperedBody };
    const res = new MockExpressRes();

    await middleware(req, res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    // Stripe/Svix-style: no body, no reason — never give an attacker
    // probing the endpoint a per-failure signal.
    expect(res.body).toBeUndefined();
  });

  it("captures raw body from a streamed request when no rawBody is set", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn(async () => {});
    const middleware = expressWebhookHandler(verifier, handler);

    const stream = new EventEmitter();
    const { headers } = signEnvelope(eventBody);
    const req = {
      headers,
      on: stream.on.bind(stream),
    };
    const res = new MockExpressRes();

    const promise = middleware(req, res);
    stream.emit("data", Buffer.from(eventBody, "utf-8"));
    stream.emit("end");
    await promise;

    expect(handler).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it("returns a generic 500 if the handler throws", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const middleware = expressWebhookHandler(verifier, () => {
      throw new Error("oops");
    });

    const { headers } = signEnvelope(eventBody);
    const req = { headers, rawBody: eventBody };
    const res = new MockExpressRes();

    await middleware(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBeUndefined();
  });

  it("does NOT hang when express.json() already parsed the body", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn();
    const middleware = expressWebhookHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    // Simulate: express.json() ran first, body is now a parsed object,
    // and the original bytes are gone.
    const req = { headers, body: JSON.parse(eventBody) };
    const res = new MockExpressRes();

    await Promise.race([
      middleware(req, res),
      new Promise((_, reject) => setTimeout(() => reject(new Error("hang")), 500)),
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it("does not overwrite a status set by the handler", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const middleware = expressWebhookHandler(verifier, async (_event, _req, res) => {
      res.statusCode = 202;
      res.end("custom");
    });

    const { headers } = signEnvelope(eventBody);
    const req = { headers, rawBody: eventBody };
    const res = new MockExpressRes();

    await middleware(req, res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("custom");
  });
});

class MockFastifyReply {
  sent = false;
  status = 0;
  payload: unknown;
  code(status: number): MockFastifyReply {
    this.status = status;
    return this;
  }
  send(payload?: unknown): void {
    this.sent = true;
    this.payload = payload;
  }
}

describe("fastifyWebhookHandler", () => {
  it("verifies and dispatches when rawBody is present", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn(async () => {});
    const middleware = fastifyWebhookHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    const request = { headers, rawBody: eventBody };
    const reply = new MockFastifyReply();

    await middleware(request, reply);
    expect(handler).toHaveBeenCalledOnce();
    expect(reply.sent).toBe(true);
    expect(reply.status).toBe(200);
  });

  it("returns 400 raw_body_required when no body is available", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn();
    const middleware = fastifyWebhookHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    const request = { headers };
    const reply = new MockFastifyReply();

    await middleware(request, reply);
    expect(handler).not.toHaveBeenCalled();
    expect(reply.status).toBe(400);
    expect(reply.payload).toBe("raw_body_required");
  });

  it("returns a generic 400 on signature mismatch (no reason echoed)", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const middleware = fastifyWebhookHandler(verifier, vi.fn());

    const { headers } = signEnvelope(eventBody);
    const request = { headers, rawBody: eventBody.replace("hi", "TAMPERED") };
    const reply = new MockFastifyReply();

    await middleware(request, reply);
    expect(reply.status).toBe(400);
    expect(reply.payload).toBeUndefined();
  });
});

describe("nextRouteHandler", () => {
  it("verifies and returns the handler's Response", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn(async () => new Response("ok", { status: 202 }));
    const route = nextRouteHandler(verifier, handler);

    const { headers } = signEnvelope(eventBody);
    const request = new Request("https://example.test/webhooks", {
      method: "POST",
      headers,
      body: eventBody,
    });

    const res = await route(request);
    expect(handler).toHaveBeenCalledOnce();
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("ok");
  });

  it("returns a generic 400 on signature mismatch (no reason echoed)", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const route = nextRouteHandler(verifier, vi.fn());

    const { headers } = signEnvelope(eventBody);
    const request = new Request("https://example.test/webhooks", {
      method: "POST",
      headers,
      body: eventBody.replace("hi", "TAMPERED"),
    });

    const res = await route(request);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  it("returns a generic 500 when the handler throws", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const route = nextRouteHandler(verifier, () => {
      throw new Error("boom");
    });

    const { headers } = signEnvelope(eventBody);
    const request = new Request("https://example.test/webhooks", {
      method: "POST",
      headers,
      body: eventBody,
    });

    const res = await route(request);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });
});
