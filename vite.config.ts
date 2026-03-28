import { defineConfig } from "vite-plus";

const ignorePatterns = [
  "build/**",
  "coverage/**",
  "docs/**",
  "docs/.nuxt/**",
  "docs/.output/**",
  "docs/node_modules/**",
  "node_modules/**",
];

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
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
    ignorePatterns,
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns,
  },
  pack: {
    clean: true,
    dts: true,
    entry: ["./index.ts"],
    fixedExtension: false,
    format: "esm",
    minify: "dce-only",
    outDir: "./build",
    sourcemap: false,
    target: "esnext",
    treeshake: false,
  },
  staged: {
    "*.{js,cjs,mjs,ts,cts,mts,tsx,jsx,vue,json,md,yml,yaml}": "vp fmt",
    "*.{js,cjs,mjs,ts,cts,mts,tsx,jsx,vue}": "vp lint --fix",
  },
});
