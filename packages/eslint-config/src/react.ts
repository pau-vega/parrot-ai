import reactPlugin from "@eslint-react/eslint-plugin"
import eslintJs from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier/flat"
import perfectionist from "eslint-plugin-perfectionist"
import prettier from "eslint-plugin-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export const react = defineConfig([
  globalIgnores([
    "dist/**",
    "build/**",
    "node_modules/**",
    "coverage/**",
    ".turbo/**",
    ".react-router/**",
    "storybook-static/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],

    extends: [
      eslintJs.configs.recommended,
      ...tseslint.configs.recommended,
      eslintConfigPrettier,
      reactPlugin.configs["recommended-typescript"],
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.recommended,
    ],

    languageOptions: {
      globals: globals.browser,
    },

    plugins: {
      "@typescript-eslint": tseslint.plugin,
      prettier,
      perfectionist,
    },

    rules: {
      "perfectionist/sort-imports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "prettier/prettier": ["warn"],
    },
  },
])
