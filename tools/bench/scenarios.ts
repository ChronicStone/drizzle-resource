import type { Pool } from "pg";
import { encodeCursor } from "../../packages/core/src/cursor.ts";
import type { QueryRequestInput } from "../../packages/core/index.ts";
import { baseRequest, type Bench, type FacetStrategy } from "./resources.ts";
import type { Run } from "./measure.ts";

export type CountMode = "none" | "exact" | "capped";

const rootFacets = (["status", "paid"] as const).map((key) => ({ key, limit: 50 }));
const allFacets = [
  ...rootFacets,
  { key: "customer.segment" as const, limit: 50 },
  { key: "customer.name" as const, limit: 50 },
];
const SEARCH_FIELDS = ["reference", "customer.name"];
const EVERY_FIELD = [
  "id",
  "customerId",
  "orgId",
  "status",
  "paid",
  "reference",
  "customer.id",
  "customer.name",
  "customer.segment",
];

const withSearch = (
  count: CountMode,
  value: string,
  fields = SEARCH_FIELDS,
): QueryRequestInput => ({
  ...baseRequest(count),
  search: { value, fields },
});

/** A request that shows a count: the page's ids and the count statement. Facet requests have none. */
export type Landing = {
  name: string;
  counts: boolean;
  run: (bench: Bench, count: CountMode) => Run;
};

/** The requests the landing page and the docs show. Each is one engine call. */
export const LANDING: Landing[] = [
  {
    name: "page-plus-count",
    counts: true,
    run: (b, c) => () => b.resource().queryIds({ request: baseRequest(c) }),
  },
  {
    name: "sort-customer-name-plus-count",
    counts: true,
    run: (b, c) => () =>
      b.resource().queryIds({
        request: { ...baseRequest(c), sorting: [{ key: "customer.name", dir: "asc" }] },
      }),
  },
  {
    name: "search-ord-plus-count",
    counts: true,
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "ord") }),
  },
  {
    name: "search-customer-plus-count",
    counts: true,
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "customer") }),
  },
  {
    name: "search-rare-reference-plus-count",
    counts: true,
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "ORD-00199999") }),
  },
  {
    name: "search-rare-customer-plus-count",
    counts: true,
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "customer 19999") }),
  },
  {
    name: "relation-search-plus-count",
    counts: true,
    run: (b, c) => () =>
      b.resource().queryIds({ request: withSearch(c, "customer 1", ["customer.name"]) }),
  },
];
/** The same sort once the name is copied onto orders (a separate schema). */
export const DENORMALIZED: Landing = {
  name: "sort-customer-name-denormalized-plus-count",
  counts: true,
  run: (b, c) => () =>
    b
      .resource()
      .queryIds({ request: { ...baseRequest(c), sorting: [{ key: "customerName", dir: "asc" }] } }),
};

export const FACETS = [
  { name: "two-root-facets", facets: rootFacets },
  { name: "four-mixed-facets", facets: allFacets },
] as const;

/** How the facet statements run: shared GROUPING SETS or one per facet, on one connection or several. */
export const FACET_VARIANTS = [
  { key: "grouping-sets/sequential", strategy: "shared", sequential: true },
  { key: "grouping-sets/concurrent", strategy: "shared", sequential: false },
  { key: "separate/sequential", strategy: "split", sequential: true },
  { key: "separate/concurrent", strategy: "split", sequential: false },
] as const satisfies ReadonlyArray<{ key: string; strategy: FacetStrategy; sequential: boolean }>;

export function facetRun(
  bench: Bench,
  facets: (typeof FACETS)[number]["facets"],
  strategy: FacetStrategy,
  sequential: boolean,
): Run {
  const request = baseRequest("exact");
  const resource = bench.resource(strategy);
  // In a transaction the statements follow each other on one connection.
  return sequential
    ? () =>
        bench.db.transaction((tx) => resource.queryFacets({ request, facets: [...facets], db: tx }))
    : () => resource.queryFacets({ request, facets: [...facets] });
}

/** The count statement alone: requests measured with count exact and count capped, from the engine's own timings. */
export const COUNTED: Array<{ name: string; run: (b: Bench, c: CountMode) => Run }> = [
  {
    name: "page-exact-count",
    run: (b, c) => () => b.resource().queryIds({ request: baseRequest(c) }),
  },
  {
    name: "cross-table-search-ord",
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "ord") }),
  },
  {
    name: "cross-table-search-customer",
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "customer") }),
  },
  {
    name: "relation-search-page",
    run: (b, c) => () =>
      b.resource().queryIds({ request: withSearch(c, "customer 1", ["customer.name"]) }),
  },
  {
    name: "cross-table-search-customer-19999",
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "customer 19999") }),
  },
  {
    name: "cross-table-search-ORD-00199999",
    run: (b, c) => () => b.resource().queryIds({ request: withSearch(c, "ORD-00199999") }),
  },
  {
    name: "id-selection-1000",
    run: (b, c) => () =>
      b.resource().queryIds({
        request: {
          ...baseRequest(c),
          filters: [
            {
              type: "condition",
              key: "id",
              operator: "isAnyOf",
              value: Array.from({ length: 1000 }, (_, i) => i * 17 + 1),
            },
          ],
        },
      }),
  },
  {
    name: "wide-search-not-here-exact",
    run: (b, c) => () => b.resource().query({ request: withSearch(c, "not-here", EVERY_FIELD) }),
  },
];

/** Every request the harness knows, with the count the request itself asks for (exact where it has one). */
export async function rawScenarios(
  pool: Pool,
  schema: string,
  rows: number,
): Promise<Array<{ name: string; run: (b: Bench) => Run }>> {
  const cursors = await deepCursors(pool, schema, rows);
  const list: Array<{ name: string; run: (b: Bench) => Run }> = [
    {
      name: "page-and-shared-count-facets",
      run: (b) => () =>
        b.resource().query({ request: { ...baseRequest("exact"), facets: rootFacets } }),
    },
    {
      name: "relation-sorted-count",
      run: (b) => () =>
        b.resource().queryIds({
          request: { ...baseRequest("exact"), sorting: [{ key: "customer.name", dir: "asc" }] },
        }),
    },
  ];
  for (const value of ["ORD-00199999", "customer 19999", "customer", "ord"])
    list.push({
      name: `cross-table-search-${value.replaceAll(" ", "-")}`,
      run: (b) => () => b.resource().queryIds({ request: withSearch("exact", value) }),
    });
  for (const value of ["customer 19999", "ord"])
    list.push({
      name: `countless-cross-table-search-${value.replaceAll(" ", "-")}`,
      run: (b) => () => b.resource().queryIds({ request: withSearch("none", value) }),
    });
  for (const value of ["19999", "customer", "not-here"])
    for (const mode of ["none", "exact", "facets"] as const)
      list.push({
        name: `wide-search-${value}-${mode}`,
        run: (b) => () =>
          b.resource().query({
            request: {
              ...withSearch(mode === "none" ? "none" : "exact", value, EVERY_FIELD),
              ...(mode === "facets" ? { facets: allFacets } : {}),
            },
          }),
      });
  list.push(
    {
      name: "related-facets-with-summary",
      run: (b) => () =>
        b
          .resource()
          .query({ request: { ...baseRequest("exact"), facets: allFacets }, summary: true }),
    },
    {
      name: "root-facets-with-missing",
      run: (b) => () =>
        b.resource().queryFacets({
          request: baseRequest("exact"),
          facets: rootFacets.map((f) => ({ ...f, missing: true })),
        }),
    },
  );
  for (const size of [10, 1000]) {
    const filters: QueryRequestInput["filters"] = [
      {
        type: "condition",
        key: "id",
        operator: "isAnyOf",
        value: Array.from({ length: size }, (_, i) => i * 17 + 1),
      },
    ];
    list.push(
      {
        name: `id-selection-${size}`,
        run: (b) => () => b.resource().queryIds({ request: { ...baseRequest("exact"), filters } }),
      },
      {
        name: `id-selection-${size}-page-only`,
        run: (b) => () => b.resource().queryIds({ request: { ...baseRequest("none"), filters } }),
      },
    );
  }
  list.push(
    {
      name: "page-without-count",
      run: (b) => () => b.resource().queryIds({ request: baseRequest("none") }),
    },
    {
      name: "page-exact-count",
      run: (b) => () => b.resource().queryIds({ request: baseRequest("exact") }),
    },
    {
      name: "relation-sorted-count-page-only",
      run: (b) => () =>
        b.resource().queryIds({
          request: { ...baseRequest("none"), sorting: [{ key: "customer.name", dir: "asc" }] },
        }),
    },
    {
      name: "relation-search-page",
      run: (b) => () =>
        b.resource().queryIds({ request: withSearch("exact", "customer 1", ["customer.name"]) }),
    },
    {
      name: "relation-search-page-page-only",
      run: (b) => () =>
        b.resource().queryIds({ request: withSearch("none", "customer 1", ["customer.name"]) }),
    },
    {
      name: "filtered-exclude-self-facets",
      run: (b) => () =>
        b.resource().queryFacets({
          request: {
            ...baseRequest("exact"),
            filters: [{ type: "condition", key: "paid", operator: "is", value: true }],
          },
          facets: allFacets,
        }),
    },
  );
  for (const value of ["ORD-00199999", "customer 19999", "customer", "ord"])
    list.push({
      name: `cross-table-search-${value.replaceAll(" ", "-")}-page-only`,
      run: (b) => () => b.resource().queryIds({ request: withSearch("none", value) }),
    });
  for (const direction of ["asc", "desc"] as const)
    list.push({
      name: `deep-cursor-id-${direction}`,
      run: (b) => () => b.resource().queryIds({ request: cursors[direction] }),
    });
  return list;
}

/** A cursor 90% of the way down the default sort, in both tie-break directions. */
async function deepCursors(pool: Pool, schema: string, rows: number) {
  const out = {} as Record<"asc" | "desc", QueryRequestInput>;
  for (const direction of ["asc", "desc"] as const) {
    const sorting = [
      { key: "createdAt", dir: "desc" as const },
      { key: "id", dir: direction },
    ];
    const { rows: anchor } = await pool.query(
      `select "createdAt", id from "${schema}".orders order by "createdAt" desc, id ${direction} offset $1 limit 1`,
      [Math.floor(rows * 0.9)],
    );
    if (!anchor[0]) throw new Error("no cursor anchor");
    const cursor = encodeCursor("orders", sorting, [anchor[0].createdAt, anchor[0].id]);
    out[direction] = {
      ...baseRequest("none"),
      sorting,
      pagination: { mode: "cursor", count: "none", pageSize: 50, cursor },
    };
  }
  return out;
}
