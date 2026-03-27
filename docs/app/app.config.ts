export default defineAppConfig({
  docus: {
    name: 'Drizzle Query Resource',
    description:
      'Schema-driven, type-safe query resources for Drizzle ORM with filtering, sorting, pagination, search, hydration, and facets.',
    url: 'http://localhost:3000',
  },
  header: {
    title: 'Drizzle Query Resource',
    logo: {
      alt: 'Drizzle Query Resource',
      light: '/logo-light.svg',
      dark: '/logo-dark.svg',
      wordmark: {
        light: '/wordmark-light.svg',
        dark: '/wordmark-dark.svg',
      },
      display: 'wordmark',
      favicon: '/favicon.svg',
    },
  },
  ui: {
    colors: {
      primary: 'sky',
      neutral: 'slate',
    },
    contentNavigation: {
      slots: {
        linkLeadingIcon: 'size-4 mr-1.5',
        linkTrailing: 'hidden',
      },
      defaultVariants: {
        variant: 'link',
      },
    },
    pageHero: {
      slots: {
        title: 'max-w-4xl text-balance text-5xl font-semibold sm:text-6xl',
        description: 'max-w-3xl text-pretty text-lg text-toned sm:text-xl',
      },
    },
    pageCard: {
      slots: {
        root: 'rounded-2xl',
        title: 'text-balance text-lg font-semibold',
        description: 'text-pretty',
      },
    },
  },
})
