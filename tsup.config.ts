import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "webhooks/index": "src/webhooks/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node22",
  splitting: true,
  treeshake: true,
  minify: false,
  esbuildOptions(options) {
    options.chunkNames = "_internal/errors";
  },
  outExtension: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
});
