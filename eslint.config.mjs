// Flat ESLint config (ESLint 9+). .mjs so this one file can use ESM import
// syntax without needing "type": "module" in package.json (the rest of the
// project is CommonJS, per tsconfig.json's "module": "CommonJS").
//
// Deliberately the non-type-checked typescript-eslint "recommended" preset,
// not the type-checked variant -- that would need a tsconfig covering both
// src/ and tests/ (today's tsconfig.json only includes src/) and adds real
// lint-time cost; not worth that complexity for this project's size.
// eslint-config-prettier last so it can turn off any stylistic rule that
// would fight Prettier.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "data/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // This codebase intentionally uses `any` in a few narrow spots (e.g.
      // node:sqlite row mapping) -- warn, don't block, so it stays visible
      // without needing an inline disable comment everywhere.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  prettier
);
