export default defineAppConfig({
  docus: {
    name: "Drizzle Resource - Documentation",
    description:
      "Schema-driven, type-safe query resources for Drizzle ORM — one typed contract for filtering, sorting, pagination, search, hydration, and facets.",
    url: "https://drizzle-resource.vercel.app",
  },
  seo: {
    titleTemplate: "%s - Drizzle Resource",
    title: "Drizzle Resource",
    description:
      "Schema-driven, type-safe query resources for Drizzle ORM — one typed contract for filtering, sorting, pagination, search, hydration, and facets.",
  },
  header: {
    title: "Drizzle Resource",
    logo: {
      alt: "Drizzle Resource",
      light: "/logo-light.svg",
      dark: "/logo-dark.svg",
      class: "h-5 md:h-7 w-auto",
      wordmark: {
        light: "/wordmark-light.svg",
        dark: "/wordmark-dark.svg",
      },
      display: "wordmark",
      favicon: "/favicon.svg",
    },
  },
  ui: {
    colors: {
      primary: "yellow",
      neutral: "zinc",
    },
    contentNavigation: {
      slots: {
        linkLeadingIcon: "size-4 mr-1.5",
        linkTrailing: "hidden",
      },
      defaultVariants: {
        variant: "link",
      },
    },
    pageHero: {
      slots: {
        title: "max-w-4xl text-balance text-5xl font-semibold sm:text-6xl",
        description: "max-w-3xl text-pretty text-lg text-toned sm:text-xl",
      },
    },
    pageCard: {
      slots: {
        root: "rounded-2xl",
        title: "text-balance text-lg font-semibold",
        description: "text-pretty",
      },
    },
  },
});
