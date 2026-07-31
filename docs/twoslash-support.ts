import { createQueryFilterBuilder } from "drizzle-resource";
import type {
  QueryFacetResult,
  QueryFacetsResponse,
  QueryFilterOperator,
  QueryIdsResponse,
  QueryPageInfo,
  QueryRequest,
  QueryResponse,
  QueryFilterBuilder,
  ResourceQueryDefaultsConfig,
  ResourceQueryFacetsConfig,
  ResourceQueryFiltersConfig,
  ResourceQuerySearchConfig,
  ResourceQuerySortConfig,
} from "drizzle-resource";

import { db } from "./db";
import { engine } from "./engine";
import { ordersResource } from "./orders.resource";
import { relations } from "./relations";
import { customers, orders, products, schema, tags } from "./schema";

export { customers, db, engine, orders, ordersResource, products, relations, schema, tags };

export const request: QueryRequest = {
  context: {},
  facets: [{ key: "status", limit: 10, mode: "exclude-self" }],
  filters: [],
  pagination: {
    mode: "offset",
    pageIndex: 1,
    pageSize: 25,
    count: "exact",
  },
  search: {
    fields: [],
    value: "",
  },
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

export type MyFieldPaths =
  | "createdAt"
  | "customer.name"
  | "customer.orgId"
  | "deletedAt"
  | "orderLines.product.category"
  | "orderLines.product.category.label"
  | "orderLines.product.name"
  | "orderLines.product.sku"
  | "reference"
  | "status"
  | "tags.name"
  | "totalAmount";

export const f = createQueryFilterBuilder<MyFieldPaths>();

export const utils = {
  buildWhereClause: (_input: {
    filters: QueryRequest["filters"];
    search: QueryRequest["search"];
  }) => ({}) as any,
  compileOrderBy: (_sorting: QueryRequest["sorting"]) => [] as any[],
  executeIdsQuery: async (_options: {
    context?: unknown;
    request?: QueryRequest;
  }): Promise<QueryIdsResponse<string>> => ({
    ids: ["order_1", "order_2", "order_3"],
    pageInfo: {
      mode: "offset",
      pageIndex: 1,
      pageSize: 25,
      hasNextPage: false,
      count: "exact",
      rowCount: 3,
    },
  }),
  executeRowsQuery: async (_options: { ids: unknown[] }): Promise<{ rows: unknown[] }> => ({
    rows: [],
  }),
  resolveFacets: async (_options: {
    facets: QueryRequest["facets"];
    request: QueryRequest;
  }): Promise<QueryFacetsResponse> => ({
    facets: result.facets,
  }),
  resolveField: (path: string) => ({ path }) as any,
};

export const and = (..._args: unknown[]) => ({}) as any;
export const count = () => ({}) as any;
export const eq = (..._args: unknown[]) => ({}) as any;
export const inArray = (..._args: unknown[]) => ({}) as any;
export const ilike = (..._args: unknown[]) => ({}) as any;
export const or = (..._args: unknown[]) => ({}) as any;

export class Pool {
  readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
}

export type ExampleDefaultsConfig = ResourceQueryDefaultsConfig;
export type ExampleFacetsConfig = ResourceQueryFacetsConfig<MyFieldPaths>;
export type ExampleFiltersConfig = ResourceQueryFiltersConfig<MyFieldPaths>;
export type ExampleSearchConfig = ResourceQuerySearchConfig<MyFieldPaths>;
export type ExampleSortConfig = ResourceQuerySortConfig<MyFieldPaths>;
export type ExampleQueryResponse = QueryResponse<Awaited<ReturnType<typeof ordersResource.query>>>;
export type ExampleFilterOperator = QueryFilterOperator;
export type ExampleFilterBuilder = QueryFilterBuilder<MyFieldPaths>;
