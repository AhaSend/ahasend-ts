import { CONFORMANCE_CASES, runConformanceSuite } from "./suite.js";

const inventory = CONFORMANCE_CASES.map(({ name }) => name);

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/inventory") {
      const runtime = globalThis as typeof globalThis & {
        HTMLRewriter?: unknown;
        WebSocketPair?: unknown;
        navigator?: { userAgent?: unknown };
      };
      return json({
        inventory,
        globals: {
          Buffer: typeof globalThis.Buffer,
          global: typeof globalThis.global,
          module: typeof globalThis.module,
          process: typeof globalThis.process,
          require: typeof globalThis.require,
          HTMLRewriter: typeof runtime.HTMLRewriter,
          WebSocketPair: typeof runtime.WebSocketPair,
          navigator: typeof runtime.navigator,
          navigatorUserAgent:
            typeof runtime.navigator?.userAgent === "string" ? runtime.navigator.userAgent : null,
        },
      });
    }

    if (request.method === "POST" && pathname === "/run") {
      return json(await runConformanceSuite());
    }

    return json({ error: "not found" }, { status: 404 });
  },
};
