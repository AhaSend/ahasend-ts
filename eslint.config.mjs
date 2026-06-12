import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: "module", ecmaVersion: 2022 },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The SDK deliberately uses `{}`-style empty interfaces for
      // forward-compatible param objects (e.g. ListMembersParams).
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
];
