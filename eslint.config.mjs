import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import js from "@eslint/js";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: "module",
      ecmaVersion: 2022,
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs["recommended-type-checked"].rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The SDK deliberately uses `{}`-style empty interfaces for
      // forward-compatible param objects (e.g. ListMembersParams).
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    files: ["examples/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        globalThis: "readonly",
        process: "readonly",
        Response: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];
