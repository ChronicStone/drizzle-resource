import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  BuildQueryResult,
  SQL,
  TableRelationalConfig,
  TablesRelationalConfig,
} from "drizzle-orm";

export type GenericObject = Record<string, unknown>;

/**
 * Free-text search input accepted by a {@link QueryRequest}.
 */
export interface QuerySearchRequest {
  /**
   * Raw user-entered search text.
   *
   * An empty string disables search compilation entirely.
   */
  value: string;
  /**
   * Field paths to search against.
   *
   * When omitted at runtime, the resource-level `query.search.defaults` list is applied.
   */
  fields: string[];
}

export interface QuerySortDescriptor<TField extends string = string> {
  /**
   * Field path to sort by.
   */
  key: TField;
  /**
   * Sort direction.
   */
  dir: "asc" | "desc";
}

export type QuerySorting<TField extends string = string> = QuerySortDescriptor<TField>[];

export type QueryFilterOperator =
  | "contains"
  | "is"
  | "isAnyOf"
  | "isNot"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "before"
  | "after";

/**
 * A single filter condition applied to one field path.
 */
export interface QueryFilterCondition<TField extends string = string> {
  type: "condition";
  /**
   * Field path resolved from the resource field registry.
   *
   * Examples: `"fullName"`, `"department.company.name"`, `"employeeSkills.skill.label"`.
   */
  key: TField;
  /**
   * Comparison operator compiled to SQL by the built-in Drizzle compiler.
   */
  operator: QueryFilterOperator;
  /**
   * Operator payload.
   *
   * Examples:
   * - `contains`: `"ada"`
   * - `isAnyOf`: `["active", "pending"]`
   * - `between`: `{ from: 10, to: 20 }`
   */
  value: unknown;
}

/**
 * A logical filter group combining child nodes with `and` or `or`.
 */
export interface QueryFilterGroup<TField extends string = string> {
  type: "group";
  /**
   * Boolean combinator used to merge all `children`.
   */
  combinator: "and" | "or";
  /**
   * Child conditions or nested groups.
   */
  children: QueryFilterNode<TField>[];
}

export type QueryFilterNode<TField extends string = string> =
  | QueryFilterGroup<TField>
  | QueryFilterCondition<TField>;

export type QueryFilterInput<TField extends string = string> =
  | QueryFilterNode<TField>
  | QueryFilterNode<TField>[]
  | null
  | undefined;

export type QueryFilters<TField extends string = string> = QueryFilterNode<TField>[];

/**
 * Normalized request consumed by all resource query methods.
 */
export interface QueryRequest {
  /**
   * Offset pagination settings.
   */
  pagination: {
    /**
     * One-based page number.
     *
     * Invalid values are replaced with `query.defaults.pagination.pageIndex` or `1`.
     */
    pageIndex: number;
    /**
     * Number of rows requested per page.
     *
     * Invalid values are replaced with `query.defaults.pagination.pageSize` or `25`.
     */
    pageSize: number;
  };
  /**
   * Sort descriptors applied in order.
   *
   * When empty, the resource-level `query.sort.defaults` list is used.
   */
  sorting: QuerySorting;
  /**
   * Top-level filters combined with an implicit `and`.
   *
   * Add nested `group` nodes only when you need custom boolean logic.
   * Scope filters are merged into this array automatically at runtime.
   */
  filters: QueryFilters;
  /**
   * Free-text search settings.
   */
  search: QuerySearchRequest;
  /**
   * Arbitrary transport context sent by the caller.
   *
   * The package does not inspect this object directly; it is available to your strategies.
   */
  context: Record<string, unknown>;
  /**
   * Optional facet requests to resolve alongside the main query.
   */
  facets?: QueryFacetRequest[];
}

/**
 * Result returned from `resource.query(...)`.
 */
export interface QueryResponse<TRow = Record<string, unknown>> {
  /**
   * Hydrated rows for the current page.
   */
  rows: TRow[];
  /**
   * Total rows matching the current request before pagination.
   */
  rowCount: number;
  /**
   * Optional facet payloads.
   *
   * Present when requested and resolved either by the built-in facet resolver or a custom strategy.
   */
  facets?: QueryFacetResult[];
}

/**
 * IDs-only result returned by `resource.queryIds(...)`.
 */
export interface QueryIdsResponse<TId = unknown> {
  /**
   * Ordered page IDs.
   */
  ids: TId[];
  /**
   * Total rows matching the current request before pagination.
   */
  rowCount: number;
}

/**
 * A single facet request.
 */
export interface QueryFacetRequest<TField extends string = string> {
  /**
   * Field path to aggregate.
   */
  key: TField;
  /**
   * Facet filter mode.
   *
   * - `exclude-self`: removes filters on the same field before computing buckets.
   * - `include-self`: keeps current self-filters applied.
   */
  mode?: "exclude-self" | "include-self";
  /**
   * Optional free-text bucket search.
   */
  search?: string;
  /**
   * Maximum number of facet options to return.
   */
  limit?: number;
  /**
   * Pagination cursor returned as `nextCursor` by a previous facet response.
   */
  cursor?: string | null;
}

/**
 * One option inside a facet bucket list.
 */
export interface QueryFacetOption {
  /**
   * Raw grouped value for the bucket.
   */
  value: unknown;
  /**
   * Number of rows matching this facet option.
   */
  count: number;
}

/**
 * Aggregated response for a single facet field.
 */
export interface QueryFacetResult<TField extends string = string> {
  /**
   * Faceted field path.
   */
  key: TField;
  /**
   * Bucketed facet values for this field.
   */
  options: QueryFacetOption[];
  /**
   * Cursor for the next page of facet buckets, or `null` when exhausted.
   */
  nextCursor?: string | null;
  /**
   * Total bucket count before facet pagination.
   */
  total?: number;
}

/**
 * Wrapper returned by `resource.queryFacets(...)`.
 */
export interface QueryFacetsResponse<TField extends string = string> {
  facets: QueryFacetResult<TField>[];
}

export type QueryEngineDb = {
  query: Record<string, { findMany: (args?: any) => Promise<any[]> }>;
};

export type QueryEngineSchema = Record<string, { _: { columns: Record<string, unknown> } }>;

export type QueryEngineRelations = Record<
  string,
  {
    relations?: Record<
      string,
      {
        targetTableName: string;
        relationType: "one" | "many";
        sourceColumns: unknown[];
        targetColumns: unknown[];
      }
    >;
  }
>;

export type QueryRootKey<TDb extends QueryEngineDb, TSchema extends QueryEngineSchema> = Extract<
  keyof TDb["query"] & keyof TSchema,
  string
>;

type FindManyArg<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRoot extends QueryRootKey<TDb, TSchema>,
> = Parameters<TDb["query"][TRoot]["findMany"]>[0];

export type QueryWith<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRoot extends QueryRootKey<TDb, TSchema>,
> =
  NonNullable<FindManyArg<TDb, TSchema, TRoot>> extends { with?: infer TWith }
    ? NonNullable<TWith>
    : never;

export type QueryRowShape<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRoot extends QueryRootKey<TDb, TSchema>,
> =
  Awaited<ReturnType<TDb["query"][TRoot]["findMany"]>> extends Array<infer TRow>
    ? Extract<TRow, GenericObject>
    : GenericObject;

type QuerySelectionShape<TWith> = [TWith] extends [undefined]
  ? true
  : {
      with: NonNullable<TWith>;
    };

export type QueryResultRowShape<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
> = TRelations extends TablesRelationalConfig
  ? TRelations[TRoot] extends TableRelationalConfig
    ? Extract<
        BuildQueryResult<TRelations, TRelations[TRoot], QuerySelectionShape<TWith>>,
        GenericObject
      >
    : QueryRowShape<TDb, TSchema, TRoot>
  : QueryRowShape<TDb, TSchema, TRoot>;

type RootColumnKey<TSchema extends QueryEngineSchema, TRoot extends keyof TSchema> = Extract<
  keyof TSchema[TRoot]["_"]["columns"],
  string
>;

type RootRelations<
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TRelations,
> = TRelations[TRoot] extends { relations: infer TRel }
  ? Extract<TRel, Record<string, unknown>>
  : never;

type RelationKey<TRelations extends QueryEngineRelations, TRoot extends keyof TRelations> = Extract<
  keyof RootRelations<TRelations, TRoot>,
  string
>;

type RelationTargetTableName<
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TRelations,
  TRelation extends RelationKey<TRelations, TRoot>,
> = RootRelations<TRelations, TRoot>[TRelation] extends { targetTableName: infer TTarget }
  ? Extract<TTarget, string>
  : never;

type QueryTypeDepth = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type DecrementDepth<TDepth extends QueryTypeDepth> = [TDepth] extends [6]
  ? 5
  : [TDepth] extends [5]
    ? 4
    : [TDepth] extends [4]
      ? 3
      : [TDepth] extends [3]
        ? 2
        : [TDepth] extends [2]
          ? 1
          : [TDepth] extends [1]
            ? 0
            : 0;

export type QueryRelationsConfig<
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TRelations,
  TDepth extends QueryTypeDepth = 4,
> = [TDepth] extends [0]
  ? never
  : [RelationKey<TRelations, TRoot>] extends [never]
    ? never
    : {
        [TRelation in RelationKey<TRelations, TRoot>]?:
          | true
          | {
              with?: QueryRelationsConfig<
                TRelations,
                Extract<RelationTargetTableName<TRelations, TRoot, TRelation>, keyof TRelations>,
                DecrementDepth<TDepth>
              >;
            };
      };

type PrefixPath<TPrefix extends string, TPath extends string> = `${TPrefix}.${TPath}`;

type ExtractNestedWith<TConfig> = TConfig extends { with?: infer TNested }
  ? NonNullable<TNested>
  : never;

type RelationFieldPath<
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TSchema & keyof TRelations,
  TRelationConfig,
  TDepth extends QueryTypeDepth,
> =
  | RootColumnKey<TSchema, TRoot>
  | RelationPaths<TSchema, TRelations, TRoot, ExtractNestedWith<TRelationConfig>, TDepth>;

type RelationPaths<
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TSchema & keyof TRelations,
  TWith,
  TDepth extends QueryTypeDepth,
> = [TDepth] extends [0]
  ? never
  : [TWith] extends [never]
    ? never
    : TWith extends object
      ? {
          [TRelation in Extract<keyof TWith, string>]: TRelation extends RelationKey<
            TRelations,
            TRoot
          >
            ? PrefixPath<
                TRelation,
                RelationFieldPath<
                  TSchema,
                  TRelations,
                  Extract<
                    RelationTargetTableName<TRelations, TRoot, TRelation>,
                    keyof TSchema & keyof TRelations
                  >,
                  TWith[TRelation],
                  DecrementDepth<TDepth>
                >
              >
            : never;
        }[Extract<keyof TWith, string>]
      : never;

export type QueryFieldPath<
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends keyof TSchema & keyof TRelations,
  TWith,
  TDepth extends QueryTypeDepth = 4,
> =
  | RootColumnKey<TSchema, TRoot>
  | RelationPaths<TSchema, TRelations, TRoot, NonNullable<TWith>, TDepth>;

export interface FieldRegistryRelationStep {
  path: string;
  relationName: string;
  relationType: "one" | "many";
  sourceTableName: string;
  targetTableName: string;
  sourceColumns: unknown[];
  targetColumns: unknown[];
}

export interface FieldRegistryEntry {
  path: string;
  source: "root" | "relation";
  column: unknown;
  tableName: string;
  relationPath: FieldRegistryRelationStep[];
  firstManyIndex: number;
  outerJoinSteps: FieldRegistryRelationStep[];
  isManyPath: boolean;
  sortable: boolean;
}

export interface QueryFilterBuilder<TField extends string> {
  /**
   * Reuse an existing condition object as-is.
   */
  condition: (condition: QueryFilterCondition<TField>) => QueryFilterCondition<TField>;
  /**
   * Combine nodes with `and`.
   */
  and: (children: QueryFilterNode<TField>[]) => QueryFilterGroup<TField>;
  /**
   * Combine nodes with `or`.
   */
  or: (children: QueryFilterNode<TField>[]) => QueryFilterGroup<TField>;
  /**
   * Compile a case-insensitive substring match.
   */
  contains: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile an equality comparison.
   */
  is: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile an `IN (...)` style comparison.
   */
  isAnyOf: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile a non-equality comparison.
   */
  isNot: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile a strict greater-than comparison.
   */
  gt: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile a greater-than-or-equal comparison.
   */
  gte: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile a strict less-than comparison.
   */
  lt: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile a less-than-or-equal comparison.
   */
  lte: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Compile an inclusive range comparison.
   *
   * Example: `filters.between('createdAt', { from: '2026-01-01', to: '2026-01-31' })`
   */
  between: (
    key: TField,
    value: {
      from?: unknown;
      to?: unknown;
    },
  ) => QueryFilterCondition<TField>;
  /**
   * Semantic alias of `lt`, useful for temporal fields.
   */
  before: (key: TField, value: unknown) => QueryFilterCondition<TField>;
  /**
   * Semantic alias of `gt`, useful for temporal fields.
   */
  after: (key: TField, value: unknown) => QueryFilterCondition<TField>;
}

/**
 * Low-level helpers exposed to custom strategies.
 */
export interface QueryResourceUtils<TRow extends GenericObject = GenericObject> {
  /**
   * Lowercase-normalize arbitrary input for case-insensitive matching.
   */
  normalizeString: (value: unknown) => string;
  /**
   * Compile a single filter condition into a Drizzle SQL fragment.
   */
  compileCondition: (condition: QueryFilterCondition) => SQL;
  /**
   * Compile a full filter tree into a Drizzle SQL fragment.
   */
  compileFilterNode: (node: QueryFilterNode) => SQL;
  /**
   * Normalize top-level request filters into a root `and` group.
   */
  normalizeFilters: (filters: QueryRequest["filters"]) => QueryFilterGroup;
  /**
   * Compile the current search request into a Drizzle SQL fragment.
   */
  compileSearch: (search: QueryRequest["search"]) => SQL | undefined;
  /**
   * Compile resource sorting into Drizzle `orderBy(...)` arguments.
   */
  compileOrderBy: (
    sorting: QueryRequest["sorting"],
  ) => Array<SQL | PgColumn | SQL.Aliased<unknown>>;
  /**
   * Build the combined search + filter `where` clause for a request.
   */
  buildWhereClause: (request: QueryRequest) => SQL | undefined;
  /**
   * Execute the built-in IDs query.
   *
   * Useful when you want to wrap the default behavior with additional strategy logic.
   */
  executeIdsQuery: (args: {
    request: QueryRequest;
  }) => Promise<QueryIdsResponse<TRow extends { id: infer TId } ? TId : unknown>>;
  /**
   * Hydrate rows by ID using Drizzle relational queries.
   */
  executeRowsQuery: (args: {
    ids: Array<TRow extends { id: infer TId } ? TId : unknown>;
    request?: QueryRequest;
  }) => Promise<TRow[]>;
  /**
   * Execute the built-in IDs query followed by row hydration.
   */
  executeHydratedPage: (args: { request: QueryRequest }) => Promise<QueryResponse<TRow>>;
  /**
   * Resolve requested facets using the built-in facet engine.
   */
  resolveFacets: (args: {
    request: QueryRequest;
    facets: QueryFacetRequest[];
  }) => Promise<QueryFacetsResponse>;
  /**
   * Inspect a field path in the resource registry.
   */
  resolveField: (path: string) => FieldRegistryEntry | undefined;
}

/**
 * Search configuration for `defineResource(...).query.search`.
 */
export interface ResourceQuerySearchConfig<TField extends string> {
  /**
   * Explicitly searchable field paths.
   *
   * When omitted, every registered field is considered searchable.
   */
  allowed?: readonly TField[];
  /**
   * Search fields used when `request.search.fields` is empty.
   *
   * Example:
   * ```ts
   * defaults: ['fullName', 'department.company.name']
   * ```
   */
  defaults?: readonly TField[];
}

/**
 * Sort configuration for `defineResource(...).query.sort`.
 */
export interface ResourceQuerySortConfig<TField extends string> {
  /**
   * Field paths that may still exist in filters/search, but should not be sortable.
   */
  disabled?: readonly TField[];
  /**
   * Fallback sorting applied when `request.sorting` is empty.
   *
   * Example:
   * ```ts
   * defaults: [{ key: 'id', dir: 'asc' }]
   * ```
   */
  defaults?: readonly QuerySortDescriptor<TField>[];
}

export interface ResourceQueryFiltersConfig<TField extends string> {
  /**
   * Fields removed from the public registry entirely.
   *
   * Hidden fields cannot be filtered, searched, sorted, or faceted.
   */
  hidden?: readonly TField[];
  /**
   * Fields present in the registry but not accepted in filters.
   */
  disabled?: readonly TField[];
}

export interface ResourceQueryFacetsConfig<TField extends string> {
  /**
   * Field paths allowed in facet requests.
   *
   * When omitted, every registered field is considered facetable.
   */
  allowed?: readonly TField[];
}

/**
 * Request defaults applied before strategies run.
 */
export interface ResourceQueryDefaultsConfig {
  /**
   * Pagination fallback values.
   */
  pagination?: Partial<QueryRequest["pagination"]>;
  /**
   * Sorting fallback values.
   */
  sorting?: Readonly<QueryRequest["sorting"]>;
}

/**
 * Arguments shared by `strategy.query`, `strategy.ids`, and `strategy.rows`.
 */
export interface ResourceQueryStrategyIdsArgs<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
> {
  /**
   * Fully normalized request, after scope filters and defaults are applied.
   */
  request: QueryRequest;
  /**
   * Optional caller context passed from `resource.query*({ context })`.
   */
  context?: TContext;
  /**
   * Resource metadata and query helpers for the current root.
   */
  resource: QueryResource<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>;
  /**
   * Built-in SQL and execution helpers you can compose inside custom strategies.
   */
  utils: QueryResourceUtils<TRow>;
}

export interface ResourceQueryStrategyRowsArgs<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
> extends ResourceQueryStrategyIdsArgs<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow> {
  /**
   * Ordered page IDs selected by a prior IDs step.
   */
  ids: Array<TRow extends { id: infer TId } ? TId : unknown>;
}

export interface ResourceQueryStrategyFacetsArgs<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
  TFacetKey extends string = string,
> extends ResourceQueryStrategyIdsArgs<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow> {
  /**
   * Requested facets to resolve.
   */
  facets: QueryFacetRequest<TFacetKey>[];
}

/**
 * Optional execution overrides for a resource.
 */
export interface ResourceQueryStrategyConfig<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
> {
  /**
   * Full-page override for `resource.query(...)`.
   *
   * If provided, the package skips the built-in `ids -> rows` pipeline.
   */
  query?: (
    args: ResourceQueryStrategyIdsArgs<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>,
  ) => Promise<QueryResponse<TRow>>;
  /**
   * IDs-stage override.
   *
   * Use this when you need custom pagination or SQL selection but still want built-in row hydration.
   */
  ids?: (
    args: ResourceQueryStrategyIdsArgs<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>,
  ) => Promise<QueryIdsResponse<TRow extends { id: infer TId } ? TId : unknown>>;
  /**
   * Row-hydration override.
   *
   * Use this when the default Drizzle `findMany({ where: { id: { in: ids } }, with })` call is insufficient.
   */
  rows?: (
    args: ResourceQueryStrategyRowsArgs<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>,
  ) => Promise<TRow[]>;
  /**
   * Facet override used by both `resource.queryFacets(...)` and `resource.query(...)` when facets are requested.
   */
  facets?: <TFacetKey extends string = string>(
    args: ResourceQueryStrategyFacetsArgs<
      TDb,
      TSchema,
      TRelations,
      TRoot,
      TWith,
      TContext,
      TRow,
      TFacetKey
    >,
  ) => Promise<QueryFacetsResponse<TFacetKey>>;
}

/**
 * Declarative resource configuration under `defineResource(...).query`.
 */
export interface ResourceQueryConfig<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
> {
  /**
   * Scope filters automatically merged into every request.
   *
   * Example:
   * ```ts
   * scope: (filters, context) =>
   *   filters.and([filters.is('department.company.country', context.orgId)])
   * ```
   */
  scope?: QueryScopeHandler<QueryFieldPath<TSchema, TRelations, TRoot, TWith>, TContext>;
  /**
   * Searchable field configuration.
   */
  search?: ResourceQuerySearchConfig<QueryFieldPath<TSchema, TRelations, TRoot, TWith>>;
  /**
   * Sort configuration.
   */
  sort?: ResourceQuerySortConfig<QueryFieldPath<TSchema, TRelations, TRoot, TWith>>;
  /**
   * Filter visibility and availability configuration.
   */
  filters?: ResourceQueryFiltersConfig<QueryFieldPath<TSchema, TRelations, TRoot, TWith>>;
  /**
   * Facet configuration.
   */
  facets?: ResourceQueryFacetsConfig<QueryFieldPath<TSchema, TRelations, TRoot, TWith>>;
  /**
   * Request defaults applied before strategies run.
   */
  defaults?: ResourceQueryDefaultsConfig;
}

export interface ResourceRuntimeQueryConfig<TField extends string> {
  search: {
    allowed: Set<TField>;
    defaults: TField[];
  };
  sort: {
    disabled: Set<TField>;
  };
  filters: {
    hidden: Set<TField>;
    disabled: Set<TField>;
  };
  facets: {
    allowed: Set<TField>;
  };
  defaults: ResourceQueryDefaultsConfig;
}

export interface QueryResource<
  TDb extends QueryEngineDb = QueryEngineDb,
  TSchema extends QueryEngineSchema = QueryEngineSchema,
  TRelations extends QueryEngineRelations = QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema> = QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined = QueryWith<TDb, TSchema, TRoot> | undefined,
  TContext extends GenericObject = GenericObject,
  TRow extends GenericObject = QueryResultRowShape<TDb, TSchema, TRelations, TRoot, TWith>,
> {
  /**
   * Root table key registered for this resource.
   */
  key: TRoot;
  /**
   * Drizzle relational `with` tree used for default row hydration.
   */
  relations?: TWith;
  /**
   * Resolved field registry for root and relation paths.
   */
  fields: Map<string, FieldRegistryEntry>;
  /**
   * Runtime-normalized query configuration.
   */
  queryConfig: ResourceRuntimeQueryConfig<QueryFieldPath<TSchema, TRelations, TRoot, TWith>>;
  /**
   * Resolve a page of rows, count, and optionally facets.
   */
  query: <TContextOverride extends TContext = TContext>(args: {
    request: QueryRequest;
    context?: TContextOverride;
  }) => Promise<QueryResponse<TRow>>;
  /**
   * Resolve ordered IDs and total count without row hydration.
   */
  queryIds: <TContextOverride extends TContext = TContext>(args: {
    request: QueryRequest;
    context?: TContextOverride;
  }) => Promise<QueryIdsResponse<TRow extends { id: infer TId } ? TId : unknown>>;
  /**
   * Hydrate rows for a known ordered ID list.
   */
  queryRows: <TContextOverride extends TContext = TContext>(args: {
    request: QueryRequest;
    ids: Array<TRow extends { id: infer TId } ? TId : unknown>;
    context?: TContextOverride;
  }) => Promise<TRow[]>;
  /**
   * Resolve facets independently of the main query pipeline.
   */
  queryFacets: <
    TFacetKey extends string = string,
    TContextOverride extends TContext = TContext,
  >(args: {
    request: QueryRequest;
    facets: QueryFacetRequest<TFacetKey>[];
    context?: TContextOverride;
  }) => Promise<QueryFacetsResponse<TFacetKey>>;
}

/**
 * Options accepted by `defineResource(...)`.
 */
export interface DefineResourceOptions<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TEngineContext extends GenericObject,
  TContext extends TEngineContext,
  TRow extends GenericObject = QueryResultRowShape<TDb, TSchema, TRelations, TRoot, TWith>,
> {
  /**
   * Drizzle relational `with` tree used for typing and default row hydration.
   */
  relations?: TWith;
  /**
   * Declarative query behavior.
   */
  query?: ResourceQueryConfig<TDb, TSchema, TRelations, TRoot, TWith, TContext>;
  /**
   * Imperative execution overrides.
   */
  strategy?: ResourceQueryStrategyConfig<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>;
}

export type DefineQueryResourceOptions<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TEngineContext extends GenericObject,
  TContext extends TEngineContext,
  TRow extends GenericObject = QueryResultRowShape<TDb, TSchema, TRelations, TRoot, TWith>,
> = DefineResourceOptions<TDb, TSchema, TRelations, TRoot, TWith, TEngineContext, TContext, TRow>;

export type QueryScopeHandler<TField extends string, TContext extends GenericObject> = (
  filters: QueryFilterBuilder<TField>,
  context: TContext,
) => QueryFilterInput<TField>;

export interface QueryEngineConfig<
  TDb extends QueryEngineDb = QueryEngineDb,
  TSchema extends QueryEngineSchema = QueryEngineSchema,
  TRelations extends QueryEngineRelations = QueryEngineRelations,
> {
  /**
   * Drizzle database instance containing relational `db.query.*.findMany(...)`.
   */
  db: TDb;
  /**
   * Drizzle schema object keyed by table name.
   */
  schema: TSchema;
  /**
   * Drizzle relations object created from the same schema.
   */
  relations: TRelations;
}

/**
 * Factory returned by {@link createQueryEngine}.
 */
export interface QueryEngine<
  TDb extends QueryEngineDb = QueryEngineDb,
  TSchema extends QueryEngineSchema = QueryEngineSchema,
  TRelations extends QueryEngineRelations = QueryEngineRelations,
  TEngineContext extends GenericObject = Record<string, unknown>,
> {
  /**
   * Narrow the shared context type for every resource defined from this engine.
   */
  withContext<TContext extends GenericObject>(): QueryEngine<TDb, TSchema, TRelations, TContext>;

  /**
   * Build a typed scope handler that can later be reused in `query.scope`.
   */
  defineScope<
    TRoot extends QueryRootKey<TDb, TSchema>,
    const TRelationsConfig extends QueryRelationsConfig<TRelations, TRoot>,
    TContext extends TEngineContext = TEngineContext,
  >(
    root: TRoot,
    withClause: TRelationsConfig,
    handler: (
      context: TContext,
      filters: QueryFilterBuilder<QueryFieldPath<TSchema, TRelations, TRoot, TRelationsConfig>>,
    ) => QueryFilterInput<QueryFieldPath<TSchema, TRelations, TRoot, TRelationsConfig>>,
  ): QueryScopeHandler<QueryFieldPath<TSchema, TRelations, TRoot, TRelationsConfig>, TContext>;

  /**
   * Overload for defining a scope without relation paths.
   */
  defineScope<
    TRoot extends QueryRootKey<TDb, TSchema>,
    TContext extends TEngineContext = TEngineContext,
  >(
    root: TRoot,
    handler: (
      context: TContext,
      filters: QueryFilterBuilder<QueryFieldPath<TSchema, TRelations, TRoot, undefined>>,
    ) => QueryFilterInput<QueryFieldPath<TSchema, TRelations, TRoot, undefined>>,
  ): QueryScopeHandler<QueryFieldPath<TSchema, TRelations, TRoot, undefined>, TContext>;

  /**
   * Define a resource rooted only in the base table.
   */
  defineResource<
    TRoot extends QueryRootKey<TDb, TSchema>,
    TContext extends TEngineContext = TEngineContext,
    TRow extends GenericObject = QueryResultRowShape<TDb, TSchema, TRelations, TRoot, undefined>,
  >(
    root: TRoot,
    options: DefineResourceOptions<
      TDb,
      TSchema,
      TRelations,
      TRoot,
      undefined,
      TEngineContext,
      TContext,
      TRow
    > & {
      relations?: undefined;
    },
  ): QueryResource<TDb, TSchema, TRelations, TRoot, undefined, TContext, TRow>;

  /**
   * Define a resource with relation-aware field paths.
   */
  defineResource<
    TRoot extends QueryRootKey<TDb, TSchema>,
    const TRelationsConfig extends QueryRelationsConfig<TRelations, TRoot>,
    TContext extends TEngineContext = TEngineContext,
    TRow extends GenericObject = QueryResultRowShape<
      TDb,
      TSchema,
      TRelations,
      TRoot,
      TRelationsConfig
    >,
  >(
    root: TRoot,
    options: DefineResourceOptions<
      TDb,
      TSchema,
      TRelations,
      TRoot,
      TRelationsConfig,
      TEngineContext,
      TContext,
      TRow
    > & {
      relations: TRelationsConfig;
    },
  ): QueryResource<TDb, TSchema, TRelations, TRoot, TRelationsConfig, TContext, TRow>;

  /**
   * Backwards-compatible alias of {@link defineResource}.
   */
  defineQueryResource: QueryEngine<TDb, TSchema, TRelations, TEngineContext>["defineResource"];
}
