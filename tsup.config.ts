import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  splitting: false,
  treeshake: true,
  minify: false,
  outExtension: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
});
