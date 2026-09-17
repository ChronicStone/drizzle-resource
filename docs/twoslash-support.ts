import { createQueryFilterBuilder } from "drizzle-resource";
import type {
  QueryFacetResult,
  QueryFieldPath,
  QueryFilterOperator,
  QueryPageInfo,
  QueryRequest,
  QueryRequestInput,
  QueryResourceUtils,
  QueryResponse,
  QueryFilterBuilder,
  ResourceQueryDefaultsConfig,
  ResourceQueryFacetsConfig,
  ResourceQueryFiltersConfig,
  ResourceQueryPaginationConfig,
  ResourceQuerySearchConfig,
  ResourceQuerySortConfig,
  ResourceQueryValidationConfig,
} from "drizzle-resource";

import { db } from "./db";
import { engine } from "./engine";
import { ordersResource, ordersRelations } from "./orders.resource";
import { relations } from "./relations";
import { customers, orderLines, orderTags, orders, products, schema, tags } from "./schema";

export {
  customers,
  db,
  engine,
  orderLines,
  orderTags,
  orders,
  ordersResource,
  products,
  relations,
  schema,
  tags,
};

/** Real Drizzle operators, so strategy examples compose actual SQL. */
export { and, count, desc, eq, gt, gte, inArray, like, lt, lte, or, sql } from "drizzle-orm";

/**
 * Field paths are DERIVED from the schema and the resource relation tree — never
 * hand-written. A path that does not exist cannot be used in an example.
 */
export type MyFieldPaths = QueryFieldPath<
  typeof schema,
  typeof relations,
  "orders",
  typeof ordersRelations
>;

/** The hydrated row type the orders resource returns. */
export type OrderRow = Awaited<ReturnType<typeof ordersResource.query>>["rows"][number];

export const f = createQueryFilterBuilder<MyFieldPaths>();

export const offsetRequest: QueryRequest = {
  context: {},
  facets: [{ key: "status", limit: 10, mode: "exclude-self" }],
  filters: [],
  pagination: { mode: "offset", pageIndex: 1, pageSize: 25, count: "exact" },
  search: { fields: [], value: "" },
  sorting: [{ dir: "desc", key: "createdAt" }],
};

export const cursorRequest: QueryRequest = {
  context: {},
  filters: [],
  pagination: { mode: "cursor", cursor: null, pageSize: 25, count: "none" },
  search: { fields: [], value: "" },
  sorting: [{ dir: "desc", key: "createdAt" }],
};

/** Kept as the historical name used across examples. */
export const request = offsetRequest;

export const requestInput: QueryRequestInput = {
  filters: [],
  pagination: { mode: "offset", pageIndex: 1, pageSize: 25 },
  search: { fields: [], value: "" },
  sorting: [{ dir: "desc", key: "createdAt" }],
};

export const ids = ["order_1", "order_2", "order_3", "order_4"];

export const offsetPageInfo = {
  mode: "offset",
  pageIndex: 1,
  pageSize: 25,
  hasNextPage: false,
  count: "exact",
  rowCount: 0,
} satisfies QueryPageInfo;

export const cursorPageInfo = {
  mode: "cursor",
  pageSize: 25,
  nextCursor: null,
  count: "none",
  rowCount: null,
} satisfies QueryPageInfo;

export const result = {
  facets: [
    {
      key: "status",
      options: [
        { count: 12, value: "pending" },
        { count: 4, value: "processing" },
        { count: 31, value: "shipped" },
      ],
      total: 3,
    },
  ],
} satisfies { facets: QueryFacetResult[] };

/**
 * Typed as the real `QueryResourceUtils`, so every helper carries its true
 * signature and all twelve members exist. Examples that misuse a helper now
 * fail Twoslash instead of silently shipping.
 */
export const utils = {} as QueryResourceUtils<OrderRow>;

export type ExampleDefaultsConfig = ResourceQueryDefaultsConfig;
export type ExampleFacetsConfig = ResourceQueryFacetsConfig<MyFieldPaths>;
export type ExampleFiltersConfig = ResourceQueryFiltersConfig<MyFieldPaths>;
export type ExamplePaginationConfig = ResourceQueryPaginationConfig;
export type ExampleSearchConfig = ResourceQuerySearchConfig<MyFieldPaths>;
export type ExampleSortConfig = ResourceQuerySortConfig<MyFieldPaths>;
export type ExampleValidationConfig = ResourceQueryValidationConfig;
export type ExampleQueryResponse = QueryResponse<OrderRow>;
export type ExampleFilterOperator = QueryFilterOperator;
export type ExampleFilterBuilder = QueryFilterBuilder<MyFieldPaths>;
