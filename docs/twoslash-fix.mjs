// @ts-check

import { defineConfig } from "@nuxtjs/mdc/config";
import picomatch from "picomatch";
import { visit } from "unist-util-visit";

const CONTEXT_PRIORITY = ["node", "app", "shared", "server"];

function resolveFileContext(filename, contextConfigs) {
  if (!filename) {
    return undefined;
  }

  const relativePath = `../${filename}`;

  for (const contextName of CONTEXT_PRIORITY) {
    const config = contextConfigs[contextName];
    if (!config || !config.include || config.include.length === 0) {
      continue;
    }

    const included = picomatch.isMatch(relativePath, config.include);
    const excluded =
      config.exclude &&
      config.exclude.length > 0 &&
      picomatch.isMatch(relativePath, config.exclude);

    if (included && !excluded) {
      return contextName;
    }
  }

  return undefined;
}

const transformerCache = {};

function wrapTransformerWithNormalizedMeta(transformer, rawMeta) {
  return {
    ...transformer,
    preprocess(code, options) {
      const meta =
        typeof options.meta === "string"
          ? { __raw: rawMeta || options.meta }
          : { ...(options.meta || {}), __raw: rawMeta || options.meta?.__raw || "" };

      options.meta = meta;
      return transformer.preprocess?.call(this, code, options);
    },
  };
}

export default defineConfig({
  unified: {
    rehype(processor) {
      return processor.use(() => (tree) => {
        visit(tree, "element", (node) => {
          if (node.tagName === "pre" && node.properties?.filename) {
            const filename = node.properties.filename;
            const meta = node.properties.meta || "";
            node.properties.meta = `${meta} __twoslash_filename=${filename}`.trim();
          }
        });
      });
    },
  },
  shiki: {
    transformers: async (_code, _lang, _theme, options) => {
      if (typeof options.meta !== "string" || !/\btwoslash\b/.test(options.meta)) {
        return [];
      }

      try {
        const {
          rootDir,
          typeDecorations,
          moduleOptions,
          compilerOptions,
          hasProjectReferences,
          contextConfigs,
        } = await import("#twoslash-meta");
        const { createTransformer, createContextTransformer } =
          await import("nuxt-content-twoslash/runtime/transformer");

        let filename;
        let cleanMeta = options.meta;
        const filenameMatch = options.meta.match(/__twoslash_filename=(\S+)/);
        if (filenameMatch) {
          filename = filenameMatch[1];
          cleanMeta = options.meta.replace(filenameMatch[0], "").trim();
        }

        let cacheKey = "default";
        if (hasProjectReferences && filename && contextConfigs) {
          const context = resolveFileContext(filename, contextConfigs);
          if (context) {
            cacheKey = context;
          }
        }

        if (!transformerCache[cacheKey]) {
          if (hasProjectReferences && cacheKey !== "default" && contextConfigs[cacheKey]) {
            transformerCache[cacheKey] = await createContextTransformer(
              rootDir,
              moduleOptions,
              typeDecorations,
              contextConfigs[cacheKey],
            );
          } else {
            transformerCache[cacheKey] = await createTransformer(
              rootDir,
              moduleOptions,
              typeDecorations,
              compilerOptions,
            );
          }
        }

        return [wrapTransformerWithNormalizedMeta(transformerCache[cacheKey], cleanMeta)];
      } catch (error) {
        console.warn("[docs twoslash fix] Failed:", error instanceof Error ? error.message : error);
        return [];
      }
    },
  },
});
