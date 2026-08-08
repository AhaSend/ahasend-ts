#!/usr/bin/env node

import { resolve } from "node:path";
import { build } from "esbuild";

const [outputDirectory] = process.argv.slice(2);
if (outputDirectory === undefined || outputDirectory.trim().length === 0) {
  throw new TypeError("Usage: node scripts/build-edge-conformance.mjs <output-directory>");
}

const result = await build({
  entryPoints: [resolve("tests/conformance/edge-entry.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2023",
  outdir: resolve(outputDirectory),
  splitting: false,
  sourcemap: false,
  logLevel: "silent",
  metafile: true,
  alias: {
    "@ahasend/sdk": resolve("dist/index.js"),
    "@ahasend/sdk/webhooks": resolve("dist/webhooks/index.js"),
  },
});

const inputs = Object.keys(result.metafile.inputs);
for (const expected of ["dist/index.js", "dist/webhooks/index.js"]) {
  if (!inputs.includes(expected)) {
    throw new TypeError(`Edge conformance bundle did not consume built artifact ${expected}.`);
  }
}
const sourceImplementation = inputs.find((path) => path.startsWith("src/"));
if (sourceImplementation !== undefined) {
  throw new TypeError(
    `Edge conformance bundle bypassed built artifacts through ${sourceImplementation}.`,
  );
}
