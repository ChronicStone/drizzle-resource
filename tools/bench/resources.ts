import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { createQueryEngine } from "../../packages/core/index.ts";
import type { QueryRequestInput } from "../../packages/core/index.ts";
import { TENANT } from "./config.ts";
import { makeModel } from "./model.ts";
import { observe } from "./measure.ts";

export type FacetStrategy = "default" | "shared" | "split";

/** What the harness calls on a resource; the engine's own generics are too deep to restate here. */
export type Resource = {
  query(args: unknown): Promise<unknown>;
  queryIds(args: unknown): Promise<unknown>;
  queryFacets(args: unknown): Promise<unknown>;
};

export type Bench = {
  db: ReturnType<typeof drizzle>;
  /** The resource for a facet strategy: the engine's default, always one shared statement, or always one per facet. */
  resource: (strategy?: FacetStrategy) => Resource;
};

function defineOne(
  engine: ReturnType<typeof createQueryEngine>,
  options: { scoped: boolean; splitAbove?: number },
): Resource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (engine as any).defineResource("orders", {
    relations: { customer: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: (fields: any) => ({ total: sql<number>`sum(${fields.orgId})`.mapWith(Number) }),
    query: {
      pagination: { modes: ["offset", "cursor"] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(options.scoped
        ? { scope: (filters: any) => filters.and([filters.is("orgId", TENANT)]) }
        : {}),
      facets: {
        allowed: ["status", "paid", "customer.segment", "customer.name"],
        ...(options.splitAbove === undefined ? {} : { splitAbove: options.splitAbove }),
      },
    },
  });
}

/** An engine over one benchmark schema, reporting every statement to `observe`. */
export function makeBench(
  pool: Pool,
  schemaName: string,
  options: { scoped?: boolean; denormalized?: boolean } = {},
): Bench {
  const { schema, relations } = makeModel(schemaName, options.denormalized ?? false);
  const db = drizzle({ client: pool, relations });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = createQueryEngine({ db, schema, relations, onQuery: observe } as any);
  const scoped = options.scoped ?? false;
  const resources = {
    default: defineOne(engine, { scoped }),
    shared: defineOne(engine, { scoped, splitAbove: Infinity }),
    split: defineOne(engine, { scoped, splitAbove: 0 }),
  };
  return { db, resource: (strategy = "default") => resources[strategy] };
}

export const baseRequest = (count: "none" | "exact" | "capped"): QueryRequestInput => ({
  pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count },
  filters: [],
  search: { value: "", fields: [] },
  sorting: [{ key: "createdAt", dir: "desc" }],
});
