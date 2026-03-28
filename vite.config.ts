import { defineConfig } from "vite-plus";

const lintIgnorePatterns = [
  "build/**",
  "coverage/**",
  "docs/.nuxt/**",
  "docs/.output/**",
  "docs/node_modules/**",
  "node_modules/**",
  "packages/*/build/**",
];

const formatIgnorePatterns = [
  "build/**",
  "coverage/**",
  "docs/.nuxt/**",
  "docs/.output/**",
  "docs/node_modules/**",
  "node_modules/**",
  "packages/*/build/**",
];

export default defineConfig({
  lint: {
    plugins: ["import", "node", "vitest"],
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    settings: {
      vitest: {
        typecheck: false,
      },
    },
    env: {
      builtin: true,
    },
    ignorePatterns: lintIgnorePatterns,
    options: {
      denyWarnings: true,
      typeAware: false,
      typeCheck: false,
    },
  },
  fmt: {
    ignorePatterns: formatIgnorePatterns,
  },
  staged: {
    "*.{js,cjs,mjs,ts,cts,mts,tsx,jsx,vue,json,md,yml,yaml}": "vp fmt",
    "*.{js,cjs,mjs,ts,cts,mts,tsx,jsx,vue}": "vp lint --fix",
  },
});
