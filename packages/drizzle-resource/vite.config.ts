import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    plugins: ["import", "node"],
    categories: {
      correctness: "error",
      suspicious: "error",
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
    entry: ["./index.ts", "./core.ts", "./zod.ts", "./valibot.ts"],
    fixedExtension: false,
    format: "esm",
    minify: "dce-only",
    outDir: "./build",
    sourcemap: false,
    target: "esnext",
    treeshake: false,
  },
});
