import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateLoopbackPort,
  formatCapturedOutput,
  spawnCapturedProcess,
  stopProcess,
  waitForProcessReadiness,
  withDeadline,
  type CapturedLocalProcess,
} from "../helpers/local-process.js";
import { CONFORMANCE_CASES, type ConformanceOutcome } from "./suite.js";

const WORKERD_VERSION = "1.20260801.1";
const WRANGLER_VERSION = "4.120.0";
const STARTUP_TIMEOUT_MS = 20_000;
const EXECUTION_TIMEOUT_MS = 15_000;
const FORBIDDEN_DATE_DIAGNOSTIC =
  /(?:compatibility[ _-]?date)[^\n]*(?:unsupported|clamp|fall(?:ing)? back|fallback)|(?:unsupported|clamp|fall(?:ing)? back|fallback)[^\n]*(?:compatibility[ _-]?date)/iu;

interface WranglerConfig {
  readonly alias: Readonly<Record<string, string>>;
  readonly compatibility_date: string;
  readonly compatibility_flags: readonly string[];
  readonly main: string;
}

interface PackageMetadata {
  readonly version: string;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface WorkerdInventory {
  readonly inventory: readonly string[];
  readonly globals: Readonly<Record<string, string | null>>;
}

const WORKERD_CONFIGS = [
  {
    label: "current compatibility date",
    path: "wrangler.workerd.json",
    compatibilityDate: "2026-07-22",
    runtimeSignals: {
      HTMLRewriter: "function",
      WebSocketPair: "function",
      navigator: "object",
      navigatorUserAgent: "Cloudflare-Workers",
    },
  },
  {
    label: "pre-global_navigator compatibility date",
    path: "wrangler.workerd-legacy.json",
    compatibilityDate: "2021-11-03",
    runtimeSignals: {
      HTMLRewriter: "function",
      WebSocketPair: "function",
      navigator: "undefined",
      navigatorUserAgent: null,
    },
  },
] as const;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

async function readResponseJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${String(response.status)}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function assertNoCompatibilityDateFallback(process: CapturedLocalProcess): void {
  const output = `${process.stdout}\n${process.stderr}`;
  expect(output).not.toMatch(FORBIDDEN_DATE_DIAGNOSTIC);
}

function earlyExitError(process: CapturedLocalProcess): Promise<never> {
  return process.exited.then((exit) => {
    const status =
      exit.error?.message ??
      (exit.exitCode === null
        ? `signal ${String(exit.signal)}`
        : `exit code ${String(exit.exitCode)}`);
    throw new Error(
      `workerd exited during conformance (${status}).${formatCapturedOutput(process)}`,
    );
  });
}

describe("no-compat workerd conformance", () => {
  it.each(WORKERD_CONFIGS)("runs the exact shared inventory on the $label", async (runtimeCase) => {
    const config = readJson<WranglerConfig>(runtimeCase.path);
    expect(config).toMatchObject({
      compatibility_date: runtimeCase.compatibilityDate,
      compatibility_flags: [],
      main: "./tests/conformance/workerd-worker.ts",
      alias: {
        "@ahasend/sdk": "./dist/index.js",
        "@ahasend/sdk/webhooks": "./dist/webhooks/index.js",
      },
    });
    expect(config.compatibility_flags).not.toContain("nodejs_compat");

    const workerdPackage = readJson<PackageMetadata>("node_modules/workerd/package.json");
    const wranglerPackage = readJson<PackageMetadata>("node_modules/wrangler/package.json");
    expect(workerdPackage.version).toBe(WORKERD_VERSION);
    expect(wranglerPackage).toMatchObject({
      version: WRANGLER_VERSION,
      engines: { node: ">=22.0.0" },
      dependencies: { workerd: WORKERD_VERSION },
    });

    const port = await allocateLoopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "ahasend-workerd-conformance-"));
    let workerd: CapturedLocalProcess | undefined;

    try {
      workerd = spawnCapturedProcess(
        process.execPath,
        [
          resolve("node_modules/wrangler/bin/wrangler.js"),
          "dev",
          "--config",
          resolve(runtimeCase.path),
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--local",
          "--persist-to",
          runtimeDirectory,
          "--show-interactive-dev-session=false",
        ],
        {
          cwd: runtimeDirectory,
          env: {
            ...process.env,
            NO_COLOR: "1",
            WRANGLER_SEND_METRICS: "false",
          },
        },
      );

      await waitForProcessReadiness(
        workerd,
        async (signal) => {
          const response = await fetch(`${origin}/inventory`, { signal });
          return response.ok;
        },
        { label: "workerd conformance Worker", timeoutMs: STARTUP_TIMEOUT_MS },
      );
      assertNoCompatibilityDateFallback(workerd);

      const expectedNames = CONFORMANCE_CASES.map(({ name }) => name);
      const inventory = await readResponseJson<WorkerdInventory>(
        await fetch(`${origin}/inventory`),
        "workerd inventory",
      );
      expect(inventory.inventory).toEqual(expectedNames);
      expect(inventory.globals).toEqual({
        Buffer: "undefined",
        ...runtimeCase.runtimeSignals,
        global: "undefined",
        module: "undefined",
        process: "undefined",
        require: "undefined",
      });

      const activeWorkerd = workerd;
      const outcomes = await withDeadline(
        async (signal) =>
          await Promise.race([
            fetch(`${origin}/run`, { method: "POST", signal }).then(
              async (response) =>
                await readResponseJson<readonly ConformanceOutcome[]>(
                  response,
                  "workerd conformance",
                ),
            ),
            earlyExitError(activeWorkerd),
          ]),
        EXECUTION_TIMEOUT_MS,
        () =>
          new Error(
            `workerd conformance exceeded ${String(EXECUTION_TIMEOUT_MS)}ms.${formatCapturedOutput(activeWorkerd)}`,
          ),
      );

      expect(outcomes).toEqual(expectedNames.map((name) => ({ name, status: "passed" })));
      assertNoCompatibilityDateFallback(workerd);
    } finally {
      try {
        await stopProcess(workerd);
      } finally {
        await rm(runtimeDirectory, { recursive: true, force: true });
      }
    }
  });
});
