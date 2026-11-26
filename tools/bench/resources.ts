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
  /** The engine, for `checkIndexes`. */
  engine: { checkIndexes: (options: { live: true }) => Promise<IndexFindingLike[]> };
};

export type IndexFindingLike = {
  level: "error" | "warn" | "info";
  rule: string;
  message: string;
  fields: string[];
  fix?: { drizzle: string; sql: string };
};

type Shape = { scoped: boolean; denormalized: boolean; splitAbove?: number };

/**
 * The resource every setup benchmarks. It declares what the application means to expose: orders
 * sorted by `createdAt` newest first, sorts through the customer's name (or the copied name once
 * it exists), and every column searchable, which is the engine's default. The other sorts are
 * switched off the way the engine's index check suggests when a sort has no use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defineOne(engine: any, shape: Shape): Resource {
  const disabledSorts = [
    "customerId",
    "orgId",
    "status",
    "paid",
    "reference",
    "customer.id",
    "customer.segment",
  ];
  if (shape.denormalized) disabledSorts.push("customer.name");
  return engine.defineResource("orders", {
    relations: { customer: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    summary: (fields: any) => ({ total: sql<number>`sum(${fields.orgId})`.mapWith(Number) }),
    query: {
      pagination: { modes: ["offset", "cursor"] },
      sort: { defaults: [{ key: "createdAt", dir: "desc" }], disabled: disabledSorts },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(shape.scoped
        ? { scope: (filters: any) => filters.and([filters.is("orgId", TENANT)]) }
        : {}),
      facets: {
        allowed: ["status", "paid", "customer.segment", "customer.name"],
        ...(shape.splitAbove === undefined ? {} : { splitAbove: shape.splitAbove }),
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
  const base = { scoped: options.scoped ?? false, denormalized: options.denormalized ?? false };
  const resources = {
    default: defineOne(engine, base),
    shared: defineOne(engine, { ...base, splitAbove: Infinity }),
    split: defineOne(engine, { ...base, splitAbove: 0 }),
  };
  return {
    db,
    resource: (strategy = "default") => resources[strategy],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    engine: engine as any,
  };
}

/**
 * An engine that only defines the resource, for `checkIndexes`. One resource per engine, so the
 * findings are about that resource alone.
 */
export function makeCheck(
  pool: Pool,
  schemaName: string,
  shape: { scoped: boolean; denormalized: boolean },
) {
  const { schema, relations } = makeModel(schemaName, shape.denormalized);
  const db = drizzle({ client: pool, relations });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const engine = createQueryEngine({ db, schema, relations } as any);
  defineOne(engine, shape);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return engine as any as Bench["engine"];
}

export const baseRequest = (count: "none" | "exact" | "capped"): QueryRequestInput => ({
  pagination: { mode: "offset", pageIndex: 1, pageSize: 50, count },
  filters: [],
  search: { value: "", fields: [] },
  sorting: [{ key: "createdAt", dir: "desc" }],
});
