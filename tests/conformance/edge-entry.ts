import { CONFORMANCE_CASES, runConformanceSuite } from "./suite.js";

interface EdgeConformanceBridge {
  readonly inventory: string;
  readonly run: () => Promise<string>;
}

declare global {
  var __AHASEND_EDGE_CONFORMANCE__: EdgeConformanceBridge;
}

globalThis.__AHASEND_EDGE_CONFORMANCE__ = Object.freeze({
  inventory: JSON.stringify(CONFORMANCE_CASES.map(({ name }) => name)),
  run: async () => JSON.stringify(await runConformanceSuite()),
});

export {};
