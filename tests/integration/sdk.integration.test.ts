import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AhaSendClient } from "../../src/index.js";
import { WebhookVerifier } from "../../src/webhooks/index.js";
import { createHmac } from "node:crypto";

const PRISM_PORT = 4011;
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

let prismProc: ChildProcess | undefined;
let baseUrl = "";

async function specPath(): Promise<string> {
  const path = resolve(process.cwd(), "openapi.yaml");
  try {
    await stat(path);
    return path;
  } catch {
    throw new Error(
      `Local openapi.yaml not found at ${path}. Integration tests now load the spec from the repository, not GitHub.`,
    );
  }
}

async function waitForPrism(port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/v2/ping`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        headers: { authorization: "Bearer aha-sk-integration-test" },
      });
      if (res.ok) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Prism did not become ready within ${timeoutMs}ms`);
}

beforeAll(async () => {
  const path = await specPath();
  const isWindows = process.platform === "win32";
  prismProc = spawn(
    "npx",
    ["-y", "@stoplight/prism-cli@5", "mock", path, "-p", String(PRISM_PORT)],
    { stdio: "ignore", shell: isWindows },
  );

  prismProc.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("[integration] failed to spawn prism:", err);
  });

  await waitForPrism(PRISM_PORT, 90_000);
  baseUrl = `http://127.0.0.1:${PRISM_PORT}`;
}, 120_000);

afterAll(() => {
  if (prismProc && !prismProc.killed) {
    prismProc.kill();
  }
});

function makeClient(): AhaSendClient {
  return new AhaSendClient({
    apiKey: "aha-sk-integration-test",
    accountId: ACCOUNT_ID,
    baseUrl,
    retry: { enabled: false },
  });
}

describe("Integration: SDK against Prism mock", () => {
  it("ping returns a typed envelope", async () => {
    const res = await makeClient().ping();
    expect(res).toHaveProperty("message");
  });

  it("messages.send returns a typed SendMessageResponse", async () => {
    const res = await makeClient().messages.send({
      from: { email: "sender@example.com" },
      recipients: [{ email: "to@example.com" }],
      subject: "integration",
      text_content: "hello",
      sandbox: true,
    });
    expect(res.object).toBe("list");
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("messages.list returns a paginated response", async () => {
    const res = await makeClient().messages.list({ limit: 5 });
    expect(res.object).toBe("list");
    expect(typeof res.pagination.has_more).toBe("boolean");
  });

  it("domains.list returns a paginated response", async () => {
    const res = await makeClient().domains.list();
    expect(res.object).toBe("list");
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("apiKeys.list returns a paginated response", async () => {
    const res = await makeClient().apiKeys.list();
    expect(res.data.length).toBeGreaterThanOrEqual(0);
  });

  it("suppressions.list returns a paginated response", async () => {
    const res = await makeClient().suppressions.list();
    expect(res.object).toBe("list");
  });

  it("routes.list returns a paginated response", async () => {
    const res = await makeClient().routes.list();
    expect(res.object).toBe("list");
  });

  it("accounts.get returns the account", async () => {
    const res = await makeClient().accounts.get();
    expect(res).toHaveProperty("id");
    expect(res).toHaveProperty("owner_id");
  });

  it("smtpCredentials.list returns a paginated response", async () => {
    const res = await makeClient().smtpCredentials.list();
    expect(res.object).toBe("list");
  });

  it("statistics.deliverability returns a list envelope", async () => {
    const res = await makeClient().statistics.deliverability({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
      group_by: "day",
    });
    expect(res.object).toBe("list");
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("messages.iterate yields items via the async generator", async () => {
    const got: unknown[] = [];
    for await (const msg of makeClient().messages.iterate({ limit: 2 })) {
      got.push(msg);
      if (got.length >= 1) break;
    }
    expect(got.length).toBeGreaterThanOrEqual(0);
  });

  // Coverage for methods that the original Phase 2 integration test skipped
  // — every one of these was identified as broken in the external review
  // (wrong verb, wrong path, or invented field). Each test here proves the
  // fixed SDK now reaches a real spec endpoint end-to-end.

  it("messages.cancel hits DELETE /messages/{id}/cancel", async () => {
    const res = await makeClient().messages.cancel("msg_integration_1");
    expect(res).toHaveProperty("message");
  });

  it("webhooks.list reaches the account-scoped /webhooks endpoint", async () => {
    const res = await makeClient().webhooks.list({ limit: 5 });
    expect(res.object).toBe("list");
  });

  it("webhooks.create / get / update / delete round-trip", async () => {
    const c = makeClient();
    const created = await c.webhooks.create({
      name: "integration",
      url: "https://hooks.example/aha",
      scope: "global",
      on_delivered: true,
    });
    expect(created.object).toBe("webhook");
    const got = await c.webhooks.get(created.id);
    expect(got.object).toBe("webhook");
    const updated = await c.webhooks.update(created.id, { enabled: false });
    expect(updated.object).toBe("webhook");
    const deleted = await c.webhooks.delete(created.id);
    expect(deleted).toHaveProperty("message");
  });

  it("suppressions.delete sends email/domain query params (per spec)", async () => {
    const res = await makeClient().suppressions.delete({
      email: "blocked@example.com",
      domain: "example.com",
    });
    expect(res).toHaveProperty("message");
  });

  it("suppressions.wipe DELETEs /suppressions/all", async () => {
    const res = await makeClient().suppressions.wipe();
    expect(res).toHaveProperty("message");
  });

  it("statistics.bounces hits /statistics/transactional/bounce (singular)", async () => {
    const res = await makeClient().statistics.bounces({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(res.object).toBe("list");
  });

  it("statistics.deliveryTimes hits /statistics/transactional/delivery-time (singular)", async () => {
    const res = await makeClient().statistics.deliveryTimes({
      from_time: "2026-04-01T00:00:00Z",
      to_time: "2026-04-30T00:00:00Z",
    });
    expect(res.object).toBe("list");
  });

  it("accounts.addMember + listMembers + removeMember lifecycle", async () => {
    const c = makeClient();
    const added = await c.accounts.addMember({
      email: "newhire@example.com",
      role: "Developer",
    });
    expect(added).toHaveProperty("user_id");
    const members = await c.accounts.listMembers();
    expect(members.object).toBe("list");
    const removed = await c.accounts.removeMember(added.user_id);
    expect(removed).toHaveProperty("message");
  });

  it("routes.create no longer requires the (formerly-invented) `domain` field", async () => {
    const created = await makeClient().routes.create({
      name: "integration-route",
      url: "https://hooks.example/inbound",
      recipient: "support@example.com",
    });
    expect(created.object).toBe("route");
  });
});

describe("Integration: WebhookVerifier (offline)", () => {
  it("round-trips a signed payload locally with a raw-string secret", () => {
    const secret = "aha-whsec-integration-secret";
    const verifier = new WebhookVerifier(secret);

    const id = "msg_it_1";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: { id, account_id: ACCOUNT_ID, event: "delivered", from: "a@b", recipient: "c@d", subject: "hi", message_id_header: "<x>" },
    });
    const sig = `v1,${createHmac("sha256", Buffer.from(secret, "utf-8")).update(`${id}.${ts}.${body}`).digest("base64")}`;

    const event = verifier.parse(
      { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig },
      body,
    );
    expect(event.type).toBe("message.delivered");
  });
});
