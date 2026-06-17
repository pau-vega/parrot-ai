import { defineConfig } from "eslint/config"

import { node } from "./src/node"

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
