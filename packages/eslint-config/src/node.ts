import eslintJs from "@eslint/js"
import eslintConfigPrettier from "eslint-config-prettier/flat"
import perfectionist from "eslint-plugin-perfectionist"
import prettier from "eslint-plugin-prettier"
import { defineConfig, globalIgnores } from "eslint/config"
import globals from "globals"
import tseslint from "typescript-eslint"

export const node = defineConfig([
  globalIgnores(["dist/**", "build/**", "node_modules/**", "coverage/**", ".turbo/**"]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [eslintJs.configs.recommended, tseslint.configs.recommended, eslintConfigPrettier],
    languageOptions: {
      globals: { ...globals.node },
      parser: tseslint.parser,
    },
    plugins: { prettier, perfectionist },
    rules: {
      "perfectionist/sort-imports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "prettier/prettier": [
        "warn",
        {
          semi: false,
          printWidth: 120,
        },
      ],
    },
  },
])
