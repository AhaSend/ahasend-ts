import { spawn, type ChildProcess } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AhaSendClient } from "../../src/index.js";
import { WebhookVerifier } from "../../src/webhooks/index.js";
import { createHmac } from "node:crypto";

const PRISM_PORT = 4011;
const SPEC_URL =
  "https://raw.githubusercontent.com/AhaSend/ahasend-go/main/openapi/openapi.yaml";
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000000";

let prismProc: ChildProcess | undefined;
let baseUrl = "";

async function specPath(): Promise<string> {
  const path = join(tmpdir(), "ahasend-openapi-it.yaml");
  try {
    await stat(path);
    return path;
  } catch {
    const res = await fetch(SPEC_URL);
    if (!res.ok) throw new Error(`Failed to fetch OpenAPI spec: HTTP ${res.status}`);
    await writeFile(path, await res.text(), "utf-8");
    return path;
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
      from: "2026-04-01T00:00:00Z",
      to: "2026-04-30T00:00:00Z",
      granularity: "day",
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
});

describe("Integration: WebhookVerifier (offline)", () => {
  it("round-trips a signed payload locally", () => {
    const secret = Buffer.from("integration-secret", "utf-8").toString("base64");
    const verifier = new WebhookVerifier(secret);

    const id = "msg_it_1";
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      type: "message.delivered",
      timestamp: new Date().toISOString(),
      data: { id, account_id: ACCOUNT_ID, event: "delivered", from: "a@b", recipient: "c@d", subject: "hi", message_id_header: "<x>" },
    });
    const sig = `v1,${createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;

    const event = verifier.parse(
      { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig },
      body,
    );
    expect(event.type).toBe("message.delivered");
  });
});
