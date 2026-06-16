import { node } from "@parrot/eslint-config"
import { defineConfig } from "eslint/config"

export default defineConfig([
  ...node,
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
])
