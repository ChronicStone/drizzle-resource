import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  pack: {
    clean: true,
    deps: {
      neverBundle: ["drizzle-orm", "drizzle-orm/valibot", "valibot"],
    },
    dts: {
      oxc: true,
    },
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
