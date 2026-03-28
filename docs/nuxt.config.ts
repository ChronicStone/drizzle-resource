import { fileURLToPath } from "node:url";

const drizzleResourceEntry = fileURLToPath(new URL("../index.ts", import.meta.url));
const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || "https://drizzle-resource.vercel.app";

export default defineNuxtConfig({
  extends: ["docus"],
  modules: ["nuxt-content-twoslash"],
  app: {
    head: {
      link: [
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      ],
    },
  },
  alias: {
    "drizzle-resource": drizzleResourceEntry,
  },
  twoslash: {
    enableInDev: true,
    includeNuxtTypes: true,
  },
  mdc: {
    highlight: {
      theme: {
        dark: "dracula",
        default: "catppuccin-latte",
      },
      langs: ["ts", "tsx", "js", "json"],
      noApiRoute: true,
    },
  },
  llms: {
    domain: siteUrl,
    title: "drizzle resource",
    description:
      "Schema-driven, type-safe query resources for Drizzle ORM with filtering, sorting, pagination, search, hydration, and facets.",
  },
  nitro: {
    preset: "static",
  },
});
