import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  expressWebhookHandler,
  fastifyWebhookHandler,
  nextRouteHandler,
  type ExpressHandler,
  type FastifyHandler,
  type NextHandler,
  type WebhookAdapterErrorContext,
  type WebhookAdapterOptions,
} from "../src/webhooks/adapters.js";
import type { AnyWebhookEvent, MessageDeliveredEvent } from "../src/webhooks/events.js";
import { MAX_WEBHOOK_BODY_BYTES, WebhookVerifier } from "../src/webhooks/verifier.js";

const SECRET = "aha-whsec-local-test-secret-please-rotate";

function signEnvelope(body: string | Buffer): Record<string, string> {
  const id = "msg_test_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${createHmac("sha256", Buffer.from(SECRET, "utf-8"))
      .update(id)
      .update(".")
      .update(timestamp)
      .update(".")
      .update(body)
      .digest("base64")}`,
  };
}

const eventBody = JSON.stringify({
  type: "message.delivered",
  webhook_id: "9aaf3ea1-b6f8-42c9-a930-5601b530bdd1",
  timestamp: new Date().toISOString(),
  data: {
    account_id: "835d2a9f-2c7e-4e8f-96f6-5b7d4b8521aa",
    event: "on_delivered",
    from: "a@b.com",
    recipient: "x@y.com",
    subject: "hi",
    message_id_header: "<x@y>",
    id: "message-1",
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

describe("webhook adapter handler declarations", () => {
  it("require every public handler to accept AnyWebhookEvent", () => {
    expectTypeOf<Parameters<ExpressHandler>[0]>().toEqualTypeOf<AnyWebhookEvent>();
    expectTypeOf<Parameters<FastifyHandler>[0]>().toEqualTypeOf<AnyWebhookEvent>();
    expectTypeOf<Parameters<NextHandler>[0]>().toEqualTypeOf<AnyWebhookEvent>();

    const verifier = new WebhookVerifier(SECRET);
    const expressHandler: ExpressHandler = () => {};
    const fastifyHandler: FastifyHandler = () => {};
    const nextHandler: NextHandler = () => new Response();

    expect(expressWebhookHandler(verifier, expressHandler)).toBeTypeOf("function");
    expect(fastifyWebhookHandler(verifier, fastifyHandler)).toBeTypeOf("function");
    expect(nextRouteHandler(verifier, nextHandler)).toBeTypeOf("function");

    if (false) {
      const narrowExpressHandler = (_event: MessageDeliveredEvent) => {};
      const narrowFastifyHandler = (_event: MessageDeliveredEvent) => {};
      const narrowNextHandler = (_event: MessageDeliveredEvent) => new Response();

      // @ts-expect-error handlers must narrow AnyWebhookEvent themselves
      expressWebhookHandler(verifier, narrowExpressHandler);
      // @ts-expect-error handlers must narrow AnyWebhookEvent themselves
      fastifyWebhookHandler(verifier, narrowFastifyHandler);
      // @ts-expect-error handlers must narrow AnyWebhookEvent themselves
      nextRouteHandler(verifier, narrowNextHandler);

      // @ts-expect-error adapter factories do not accept caller-selected event types
      expressWebhookHandler<MessageDeliveredEvent>(verifier, expressHandler);
      // @ts-expect-error adapter factories do not accept caller-selected event types
      fastifyWebhookHandler<MessageDeliveredEvent>(verifier, fastifyHandler);
      // @ts-expect-error adapter factories do not accept caller-selected event types
      nextRouteHandler<MessageDeliveredEvent>(verifier, nextHandler);
    }
  });
});

describe("shared webhook adapter options", () => {
  it("are accepted as the trailing argument by all three factories", () => {
    const options: WebhookAdapterOptions = {
      maxBodyBytes: 1024,
      onError: async (_error, context: WebhookAdapterErrorContext) => {
        expect(Object.keys(context).sort()).toEqual(["adapter", "stage"]);
      },
    };
    const verifier = new WebhookVerifier(SECRET);

    expect(expressWebhookHandler(verifier, vi.fn(), options)).toBeTypeOf("function");
    expect(fastifyWebhookHandler(verifier, vi.fn(), options)).toBeTypeOf("function");
    expect(nextRouteHandler(verifier, vi.fn(), options)).toBeTypeOf("function");
  });

  it("accepts body limits from 1 through the fixed ceiling consistently", () => {
    const verifier = new WebhookVerifier(SECRET);
    for (const maxBodyBytes of [1, 1024, MAX_WEBHOOK_BODY_BYTES]) {
      expect(() => expressWebhookHandler(verifier, vi.fn(), { maxBodyBytes })).not.toThrow();
      expect(() => fastifyWebhookHandler(verifier, vi.fn(), { maxBodyBytes })).not.toThrow();
      expect(() => nextRouteHandler(verifier, vi.fn(), { maxBodyBytes })).not.toThrow();
    }
  });

  it("rejects non-integer, out-of-range, and ceiling-raising body limits consistently", () => {
    const verifier = new WebhookVerifier(SECRET);
    for (const maxBodyBytes of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_WEBHOOK_BODY_BYTES + 1,
    ]) {
      expect(() => expressWebhookHandler(verifier, vi.fn(), { maxBodyBytes })).toThrow(TypeError);
      expect(() => fastifyWebhookHandler(verifier, vi.fn(), { maxBodyBytes })).toThrow(TypeError);
      expect(() => nextRouteHandler(verifier, vi.fn(), { maxBodyBytes })).toThrow(TypeError);
    }
  });
});

describe("expressWebhookHandler", () => {
  it("verifies, parses, and invokes the handler with a typed event", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const received: AnyWebhookEvent[] = [];
    const handler: ExpressHandler = async (event) => {
      received.push(event);
    };
    const middleware = expressWebhookHandler(verifier, handler);
    const res = new MockExpressRes();
    const next = vi.fn();

    await middleware({ headers: signEnvelope(eventBody), rawBody: eventBody }, res, next);

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("message.delivered");
    expect(res.statusCode).toBe(200);
    expect(res.writableEnded).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns opaque 400 responses for invalid signatures and known-event schemas", async () => {
    const verifier = new WebhookVerifier(SECRET);
    const handler = vi.fn();
    const middleware = expressWebhookHandler(verifier, handler);

    for (const body of [eventBody.replace("hi", "tampered"), '{"type":"message.delivered"}']) {
      const res = new MockExpressRes();
      const next = vi.fn();
      await middleware({ headers: signEnvelope(eventBody), rawBody: body }, res, next);
      expect(res.statusCode).toBe(400);
      expect(res.body).toBeUndefined();
      expect(next).not.toHaveBeenCalled();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("defaults to the fixed 30,000,000-byte ceiling for preloaded bodies", async () => {
    const middleware = expressWebhookHandler(new WebhookVerifier(SECRET), vi.fn());
    const res = new MockExpressRes();
    const next = vi.fn();

    await middleware({ headers: {}, rawBody: Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1) }, res, next);

    expect(res.statusCode).toBe(413);
    expect(res.body).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
  });

  it("bounds streamed bodies using the configured byte ceiling", async () => {
    const middleware = expressWebhookHandler(new WebhookVerifier(SECRET), vi.fn(), {
      maxBodyBytes: 4,
    });
    const stream = new EventEmitter();
    const req = {
      headers: {},
      on: stream.on.bind(stream),
      off: stream.off.bind(stream),
    };
    const res = new MockExpressRes();
    const next = vi.fn();

    const pending = middleware(req, res, next);
    stream.emit("data", Buffer.from("123"));
    stream.emit("data", Buffer.from("45"));
    await pending;

    expect(res.statusCode).toBe(413);
    expect(res.body).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("passes setup errors to next once and observes only stable non-sensitive context", async () => {
    const contexts: WebhookAdapterErrorContext[] = [];
    const errors: unknown[] = [];
    const middleware = expressWebhookHandler(new WebhookVerifier(SECRET), vi.fn(), {
      onError(error, context) {
        errors.push(error);
        contexts.push(context);
      },
    });
    const next = vi.fn();

    await middleware(
      {
        headers: { authorization: "secret-header" },
        body: { signature: "secret-signature", body: "secret-body" },
      },
      new MockExpressRes(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(errors[0]);
    expect(contexts).toEqual([{ adapter: "express", stage: "setup" }]);
    expect(Object.keys(contexts[0]!)).toEqual(["adapter", "stage"]);
    expect(JSON.stringify(contexts[0])).not.toContain("secret");
  });

  it("passes the original stream error to next once", async () => {
    const original = new Error("socket reset");
    const observer = vi.fn();
    const middleware = expressWebhookHandler(new WebhookVerifier(SECRET), vi.fn(), {
      onError: observer,
    });
    const stream = new EventEmitter();
    const next = vi.fn();
    const pending = middleware(
      { headers: {}, on: stream.on.bind(stream), off: stream.off.bind(stream) },
      new MockExpressRes(),
      next,
    );

    stream.emit("error", original);
    await pending;

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(original);
    expect(observer).toHaveBeenCalledWith(original, { adapter: "express", stage: "stream" });
  });

  it.each([
    ["resolving", () => Promise.resolve()],
    [
      "throwing",
      () => {
        throw new Error("observer throw");
      },
    ],
    ["rejecting", () => Promise.reject(new Error("observer rejection"))],
  ])("keeps the original application error when the observer is %s", async (_name, onError) => {
    const original = new Error("application failure");
    const middleware = expressWebhookHandler(
      new WebhookVerifier(SECRET),
      async (_event, _request, response) => {
        response.end();
        throw original;
      },
      { onError },
    );
    const res = new MockExpressRes();
    const next = vi.fn();

    await middleware({ headers: signEnvelope(eventBody), rawBody: eventBody }, res, next);
    await Promise.resolve();

    expect(res.writableEnded).toBe(true);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(original);
  });

  it("does not await an observer before taking the native error path", async () => {
    const original = new Error("application failure");
    const never = new Promise<void>(() => {});
    const middleware = expressWebhookHandler(
      new WebhookVerifier(SECRET),
      () => {
        throw original;
      },
      { onError: () => never },
    );
    const next = vi.fn();

    await middleware(
      { headers: signEnvelope(eventBody), rawBody: eventBody },
      new MockExpressRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(original);
  });

  it("does not overwrite a response completed by the handler", async () => {
    const middleware = expressWebhookHandler(
      new WebhookVerifier(SECRET),
      async (_event, _req, res) => {
        res.statusCode = 202;
        res.end("custom");
      },
    );
    const res = new MockExpressRes();

    await middleware({ headers: signEnvelope(eventBody), rawBody: eventBody }, res, vi.fn());

    expect(res.statusCode).toBe(202);
    expect(res.body).toBe("custom");
  });
});

describe("fastifyWebhookHandler", () => {
  it("verifies and dispatches when rawBody is present", async () => {
    const handler = vi.fn(async () => {});
    const route = fastifyWebhookHandler(new WebhookVerifier(SECRET), handler);
    const reply = new MockFastifyReply();

    await route({ headers: signEnvelope(eventBody), rawBody: eventBody }, reply);

    expect(handler).toHaveBeenCalledOnce();
    expect(reply.sent).toBe(true);
    expect(reply.status).toBe(200);
  });

  it("returns opaque 400 for verification failure", async () => {
    const route = fastifyWebhookHandler(new WebhookVerifier(SECRET), vi.fn());
    const reply = new MockFastifyReply();

    await route(
      { headers: signEnvelope(eventBody), rawBody: eventBody.replace("hi", "tampered") },
      reply,
    );

    expect(reply.status).toBe(400);
    expect(reply.payload).toBeUndefined();
  });

  it("returns opaque 400 without dispatching when a parsed body has no rawBody", async () => {
    const handler = vi.fn();
    const route = fastifyWebhookHandler(new WebhookVerifier(SECRET), handler);
    const reply = new MockFastifyReply();

    await route({ headers: signEnvelope(eventBody), body: JSON.parse(eventBody) }, reply);

    expect(reply.status).toBe(400);
    expect(reply.sent).toBe(true);
    expect(reply.payload).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("enforces default and configured body ceilings", async () => {
    for (const [body, options] of [
      [Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1), undefined],
      ["12345", { maxBodyBytes: 4 }],
    ] as const) {
      const route = fastifyWebhookHandler(new WebhookVerifier(SECRET), vi.fn(), options);
      const reply = new MockFastifyReply();
      await route({ headers: {}, rawBody: body }, reply);
      expect(reply.status).toBe(413);
      expect(reply.payload).toBeUndefined();
    }
  });

  it("throws and observes setup failures even if a reply was already sent", async () => {
    const observer = vi.fn();
    const route = fastifyWebhookHandler(new WebhookVerifier(SECRET), vi.fn(), {
      onError: observer,
    });
    const reply = new MockFastifyReply();
    reply.sent = true;

    let original: unknown;
    try {
      await route({ headers: {} }, reply);
    } catch (error) {
      original = error;
    }

    expect(original).toBeInstanceOf(Error);
    expect(observer).toHaveBeenCalledWith(original, { adapter: "fastify", stage: "setup" });
    expect(reply.status).toBe(0);
  });

  it.each([
    ["resolving", () => Promise.resolve()],
    [
      "throwing",
      () => {
        throw new Error("observer throw");
      },
    ],
    ["rejecting", () => Promise.reject(new Error("observer rejection"))],
  ])(
    "throws the original application failure after reply.sent when observer is %s",
    async (_name, onError) => {
      const original = new Error("application failure");
      const observer = vi.fn(onError);
      const route = fastifyWebhookHandler(
        new WebhookVerifier(SECRET),
        async (_event, _request, reply) => {
          reply.send();
          throw original;
        },
        { onError: observer },
      );
      const reply = new MockFastifyReply();

      await expect(
        route({ headers: signEnvelope(eventBody), rawBody: eventBody }, reply),
      ).rejects.toBe(original);
      await Promise.resolve();

      expect(observer).toHaveBeenCalledWith(original, {
        adapter: "fastify",
        stage: "application",
      });
      expect(reply.sent).toBe(true);
    },
  );
});

describe("nextRouteHandler", () => {
  it("verifies and returns the handler response", async () => {
    const handler = vi.fn(async () => new Response("ok", { status: 202 }));
    const route = nextRouteHandler(new WebhookVerifier(SECRET), handler);
    const request = new Request("https://example.test/webhooks", {
      method: "POST",
      headers: signEnvelope(eventBody),
      body: eventBody,
    });

    const response = await route(request);

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("ok");
  });

  it("returns opaque 400 for verification failure", async () => {
    const route = nextRouteHandler(new WebhookVerifier(SECRET), vi.fn());
    const request = new Request("https://example.test/webhooks", {
      method: "POST",
      headers: signEnvelope(eventBody),
      body: eventBody.replace("hi", "tampered"),
    });

    const response = await route(request);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  it("enforces default and configured byte ceilings with opaque 413 responses", async () => {
    for (const [body, options] of [
      [Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1), undefined],
      ["€€", { maxBodyBytes: 5 }],
    ] as const) {
      const route = nextRouteHandler(new WebhookVerifier(SECRET), vi.fn(), options);
      const request = new Request("https://example.test/webhooks", {
        method: "POST",
        body,
      });
      const response = await route(request);
      expect(response.status).toBe(413);
      expect(await response.text()).toBe("");
    }
  });

  it.each([
    ["resolving", () => Promise.resolve()],
    [
      "throwing",
      () => {
        throw new Error("observer throw");
      },
    ],
    ["rejecting", () => Promise.reject(new Error("observer rejection"))],
  ])("rejects with the original application error when observer is %s", async (_name, onError) => {
    const original = new Error("application failure");
    const route = nextRouteHandler(
      new WebhookVerifier(SECRET),
      () => {
        throw original;
      },
      { onError },
    );
    const request = new Request("https://example.test/webhooks?signature=secret", {
      method: "POST",
      headers: signEnvelope(eventBody),
      body: eventBody,
    });

    await expect(route(request)).rejects.toBe(original);
    await Promise.resolve();
  });

  it("reports exact non-sensitive context", async () => {
    const original = new Error("application failure");
    const observer = vi.fn();
    const route = nextRouteHandler(
      new WebhookVerifier(SECRET),
      () => {
        throw original;
      },
      { onError: observer },
    );
    const request = new Request("https://example.test/private?signature=secret", {
      method: "POST",
      headers: signEnvelope(eventBody),
      body: eventBody,
    });

    await expect(route(request)).rejects.toBe(original);

    const context = observer.mock.calls[0]![1] as WebhookAdapterErrorContext;
    expect(context).toEqual({ adapter: "next", stage: "application" });
    expect(Object.keys(context)).toEqual(["adapter", "stage"]);
    expect(JSON.stringify(context)).not.toContain("private");
    expect(JSON.stringify(context)).not.toContain("secret");
  });
});
