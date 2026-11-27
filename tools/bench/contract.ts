import { COUNTED, FACETS, FACET_VARIANTS } from "./scenarios.ts";
import type { ProfileName } from "./run.ts";

/**
 * Every cell tools/scale-bench-data.ts reads from profiles.json, per profile. A `--final` run must
 * have all of them at every size, so the docs can be generated from it. Keep in step with
 * REQUESTS, SCOPED, COUNTS and the facet variants in that script.
 */
const LANDING_OUT = [
  "page-plus-count",
  "sort-customer-name-plus-count",
  "two-root-facets",
  "four-mixed-facets",
  "search-ord-plus-count",
  "search-customer-plus-count",
  "relation-search-plus-count",
  "search-rare-reference-plus-count",
  "search-rare-customer-plus-count",
].map((name) => `landing/${name}`);

export const REQUIRED_CELLS: Record<ProfileName, string[]> = {
  "out-of-the-box": [
    ...LANDING_OUT,
    "page-without-count",
    "deep-cursor-id-desc",
    "id-selection-10-page-only",
    "wide-search-customer-none",
    "wide-search-customer-exact",
    "wide-search-19999-none",
    "wide-search-not-here-none",
  ],
  tuned: [
    ...LANDING_OUT.filter((k) => k !== "landing/sort-customer-name-plus-count"),
    "landing/sort-customer-name-denormalized-plus-count",
    ...COUNTED.flatMap((c) => [`${c.name}:count-exact`, `${c.name}:count-capped`]),
    ...FACETS.flatMap((f) => FACET_VARIANTS.map((v) => `${f.name}/${v.key}`)),
  ],
  scoped: [
    "landing/page-plus-count",
    "landing/page-plus-count-exact",
    "landing/relation-search-plus-count",
    "landing/two-root-facets",
  ],
};
