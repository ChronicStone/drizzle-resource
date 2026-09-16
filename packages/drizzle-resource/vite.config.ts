import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    alias: {
      "@drizzle-resource/core": fileURLToPath(new URL("../core/index.ts", import.meta.url)),
    },
  },
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
    deps: {
      neverBundle: [
        "@vinejs/vine",
        "drizzle-orm",
        "drizzle-orm/zod",
        "drizzle-orm/valibot",
        "valibot",
        "zod",
      ],
    },
    dts: {
      oxc: true,
    },
    entry: ["./index.ts", "./core.ts", "./zod.ts", "./valibot.ts", "./vine.ts"],
    fixedExtension: false,
    format: "esm",
    minify: "dce-only",
    outDir: "./build",
    sourcemap: false,
    target: "esnext",
    treeshake: false,
  },
});
