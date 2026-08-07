import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EdgeVM } from "@edge-runtime/vm";
import { describe, expect, it } from "vitest";
import { CONFORMANCE_CASES } from "./suite.js";

const COMPLETION_TIMEOUT_MS = 15_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Edge VM conformance exceeded ${String(timeoutMs)}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("Edge VM web-globals conformance", () => {
  it(
    "runs the exact shared inventory without Node compatibility globals",
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "ahasend-edge-conformance-"));

      try {
        const buildResult = spawnSync(
          process.execPath,
          [
            resolve("node_modules/tsup/dist/cli-default.js"),
            resolve("tests/conformance/edge-entry.ts"),
            "--format",
            "iife",
            "--platform",
            "browser",
            "--target",
            "es2023",
            "--out-dir",
            temporaryDirectory,
            "--no-config",
            "--no-splitting",
            "--silent",
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: COMPLETION_TIMEOUT_MS,
          },
        );
        expect(buildResult.status, `${buildResult.stdout}${buildResult.stderr}`).toBe(0);

        const bundle = await readFile(resolve(temporaryDirectory, "edge-entry.global.js"), "utf8");
        const edgeVm = new EdgeVM({ initialCode: bundle });
        expect(
          edgeVm.evaluate(`JSON.stringify({
            process: typeof process,
            Buffer: typeof Buffer,
            require: typeof require,
            module: typeof module,
            global: typeof global,
            webCrypto: typeof crypto?.subtle
          })`),
        ).toBe(
          JSON.stringify({
            process: "undefined",
            Buffer: "undefined",
            require: "undefined",
            module: "undefined",
            global: "undefined",
            webCrypto: "object",
          }),
        );

        const expectedNames = CONFORMANCE_CASES.map(({ name }) => name);
        const inventory = JSON.parse(
          edgeVm.evaluate<string>("globalThis.__AHASEND_EDGE_CONFORMANCE__.inventory"),
        ) as unknown;
        expect(inventory).toEqual(expectedNames);

        const serializedOutcomes = edgeVm.evaluate<Promise<string>>(
          "globalThis.__AHASEND_EDGE_CONFORMANCE__.run()",
        );
        const outcomes = JSON.parse(
          await withTimeout(serializedOutcomes, COMPLETION_TIMEOUT_MS),
        ) as unknown;
        expect(outcomes).toEqual(expectedNames.map((name) => ({ name, status: "passed" })));
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }

      expect(existsSync(temporaryDirectory)).toBe(false);
    },
    COMPLETION_TIMEOUT_MS + 5_000,
  );
});
