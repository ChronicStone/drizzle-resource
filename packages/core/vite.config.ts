import { defineConfig } from "vite-plus";

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
    ignorePatterns: ["build/**", "node_modules/**"],
    options: {
      denyWarnings: true,
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: ["build/**", "node_modules/**"],
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
});
