import vine, { VineObject } from "@vinejs/vine";
import type { Infer, InferInput, SchemaTypes } from "@vinejs/vine/types";
import {
  resolveQueryRequestContract,
  type GenericObject,
  type QueryFilterCondition,
  type QueryRequest,
  type QueryRequestInput,
  type QueryOffsetPagination,
  type QueryCursorPagination,
  type QueryRequestSchemaOverride,
  type QueryResource,
  type QueryRootKey,
  type QueryEngineDb,
  type QueryEngineRelations,
  type QueryEngineSchema,
} from "@drizzle-resource/core";

type QueryRequestInputWithoutContext = Omit<QueryRequestInput, "context">;

export type QueryRequestVineInput = Partial<
  Omit<QueryRequestInputWithoutContext, "pagination" | "search">
> & {
  pagination?:
    | Partial<QueryOffsetPagination>
    | (Pick<QueryCursorPagination, "mode"> & Partial<Omit<QueryCursorPagination, "mode">>);
  search?: Partial<QueryRequest["search"]>;
};
export type QueryRequestVineOutput = Omit<QueryRequest, "context">;

type QueryRequestVineSchemaProperties = {
  pagination: SchemaTypes;
  sorting: SchemaTypes;
  filters: SchemaTypes;
  search: SchemaTypes;
  facets: SchemaTypes;
};

export type QueryRequestVineSchema = VineObject<
  QueryRequestVineSchemaProperties,
  QueryRequestVineInput,
  QueryRequestVineOutput,
  QueryRequestVineOutput
>;

export type QueryRequestVineSchemaInput<TSchema extends QueryRequestVineSchema> =
  InferInput<TSchema>;
export type QueryRequestVineSchemaOutput<TSchema extends QueryRequestVineSchema> = Infer<TSchema>;

const QUERY_FILTER_OPERATORS = [
  "contains",
  "is",
  "isAnyOf",
  "isNot",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "before",
  "after",
] as const satisfies readonly QueryFilterCondition["operator"][];

const QUERY_SORT_DIRECTIONS = ["asc", "desc"] as const;
const QUERY_FACET_MODES = ["exclude-self", "include-self"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownValueSchema(): SchemaTypes {
  return vine
    .any()
    .nullable()
    .transform((value): unknown => value);
}

function allowedStringSchema(values: Set<string>, label: string): SchemaTypes {
  return vine.enum(Array.from(values)).meta({ message: `${label} is not allowed` });
}

function strictObjectRule(knownKeys: readonly string[]) {
  const known = new Set(knownKeys);
  return vine.createRule((value, _options, field) => {
    if (!isRecord(value)) return;

    for (const key of Object.keys(value)) {
      if (!known.has(key)) field.report(`Unknown property "${key}"`, "strict", field);
    }
  })();
}

function strictObject<Properties extends Record<string, SchemaTypes>>(properties: Properties) {
  return vine.object(properties).use(strictObjectRule(Object.keys(properties)));
}

function filterNodeSchema({
  filters,
  maxDepth,
  depth,
}: {
  filters: Set<string>;
  maxDepth: number;
  depth: number;
}): SchemaTypes {
  const condition = strictObject({
    type: vine.literal("condition"),
    key: allowedStringSchema(filters, "Filter field"),
    operator: vine.enum(QUERY_FILTER_OPERATORS),
    value: unknownValueSchema(),
  });

  if (depth >= maxDepth) return condition;

  const group = strictObject({
    type: vine.literal("group"),
    combinator: vine.enum(["and", "or"] as const),
    children: vine.array(filterNodeSchema({ filters, maxDepth, depth: depth + 1 })),
  });

  return vine.union([
    vine.union.if((value) => isRecord(value) && value.type === "condition", condition),
    vine.union.else(group),
  ]);
}

function filterTreeStats(filters: unknown[]) {
  let depth = 0;
  let nodes = 0;
  const stack = filters.map((node) => ({ node, depth: 1 }));

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;

    nodes += 1;
    depth = Math.max(depth, entry.depth);
    if (
      !isRecord(entry.node) ||
      entry.node.type !== "group" ||
      !Array.isArray(entry.node.children)
    ) {
      continue;
    }

    stack.push(...entry.node.children.map((node) => ({ node, depth: entry.depth + 1 })));
  }

  return { depth, nodes };
}

function reportRequestErrors(contract: ReturnType<typeof resolveQueryRequestContract>) {
  return vine.createRule((value, _options, field) => {
    if (!isRecord(value)) return;

    const pagination = isRecord(value.pagination) ? value.pagination : undefined;
    const mode = pagination?.mode;
    if ((mode === "offset" || mode === "cursor") && !contract.pagination.has(mode)) {
      field.report("Pagination mode is not allowed", "query.pagination.mode", field);
    }

    const filters = Array.isArray(value.filters) ? value.filters : [];
    const stats = filterTreeStats(filters);
    if (stats.nodes > contract.limits.maxFilterNodes) {
      field.report(
        `Filter tree cannot exceed ${contract.limits.maxFilterNodes} nodes`,
        "query.filters.nodes",
        field,
      );
    }
    if (stats.depth > contract.limits.maxFilterDepth) {
      field.report(
        `Filter tree cannot exceed ${contract.limits.maxFilterDepth} levels`,
        "query.filters.depth",
        field,
      );
    }
  });
}

function hasOwnValue(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidPaginationInput(value: unknown): boolean {
  if (!isRecord(value)) return false;

  const mode = value.mode;
  if (mode !== undefined && mode !== "offset" && mode !== "cursor") return false;

  const allowedKeys =
    mode === "cursor"
      ? ["mode", "cursor", "pageSize", "count"]
      : ["mode", "pageIndex", "pageSize", "count"];
  if (!hasOnlyKeys(value, allowedKeys)) return false;
  if (
    value.pageIndex !== undefined &&
    (typeof value.pageIndex !== "number" || !Number.isFinite(value.pageIndex))
  )
    return false;
  if (
    value.pageSize !== undefined &&
    (typeof value.pageSize !== "number" || !Number.isFinite(value.pageSize))
  )
    return false;
  if (value.count !== undefined && value.count !== "none" && value.count !== "exact") return false;
  if (
    mode === "cursor" &&
    value.cursor !== undefined &&
    value.cursor !== null &&
    typeof value.cursor !== "string"
  )
    return false;
  return true;
}

function isValidRequestShape(value: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(value, ["pagination", "sorting", "filters", "search", "facets"])) return false;

  if (hasOwnValue(value, "pagination") && !isValidPaginationInput(value.pagination)) {
    return false;
  }
  if (hasOwnValue(value, "sorting") && !Array.isArray(value.sorting)) return false;
  if (hasOwnValue(value, "filters") && !Array.isArray(value.filters)) return false;

  if (hasOwnValue(value, "search")) {
    if (!isRecord(value.search) || !hasOnlyKeys(value.search, ["value", "fields"])) return false;
    if (value.search.value !== undefined && typeof value.search.value !== "string") return false;
    if (value.search.fields !== undefined && !Array.isArray(value.search.fields)) return false;
  }

  if (hasOwnValue(value, "facets") && !Array.isArray(value.facets)) return false;
  return true;
}

function normalizeRequestDefaults(
  contract: ReturnType<typeof resolveQueryRequestContract>,
  defaultSearchFields: string[],
) {
  return vine.createRule((value, _options, field) => {
    if (!isRecord(value)) return;

    if (!isValidRequestShape(value)) {
      for (const key of ["pagination", "sorting", "filters", "search", "facets"]) {
        if (value[key] === null) field.report(`The ${key} field must be defined`, "strict", field);
      }
      return;
    }

    const defaults = contract.defaults.pagination;
    const defaultMode = defaults?.mode ?? "offset";
    const defaultPageIndex = defaults?.pageIndex ?? 1;
    const defaultPageSize = Math.min(defaults?.pageSize ?? 25, contract.limits.maxPageSize);
    const defaultCount = defaults?.count ?? (defaultMode === "cursor" ? "none" : "exact");
    const paginationInput = isRecord(value.pagination) ? value.pagination : {};
    const mode = hasOwnValue(value, "pagination")
      ? paginationInput.mode === "cursor"
        ? "cursor"
        : "offset"
      : defaultMode;
    const pagination =
      mode === "cursor"
        ? {
            mode: "cursor" as const,
            cursor: typeof paginationInput.cursor === "string" ? paginationInput.cursor : null,
            pageSize:
              typeof paginationInput.pageSize === "number"
                ? paginationInput.pageSize
                : defaultPageSize,
            count:
              paginationInput.count === "none" || paginationInput.count === "exact"
                ? paginationInput.count
                : defaultMode === "cursor"
                  ? defaultCount
                  : "none",
          }
        : {
            mode: "offset" as const,
            pageIndex:
              typeof paginationInput.pageIndex === "number"
                ? paginationInput.pageIndex
                : defaultPageIndex,
            pageSize:
              typeof paginationInput.pageSize === "number"
                ? paginationInput.pageSize
                : defaultPageSize,
            count:
              paginationInput.count === "none" || paginationInput.count === "exact"
                ? paginationInput.count
                : defaultMode === "offset"
                  ? defaultCount
                  : "exact",
          };

    const sorting =
      Array.isArray(value.sorting) && value.sorting.length > 0
        ? value.sorting
        : [...(contract.defaults.sorting ?? [])];
    const filters = Array.isArray(value.filters) ? value.filters : [];
    const searchInput = isRecord(value.search) ? value.search : {};
    const search = {
      value: typeof searchInput.value === "string" ? searchInput.value : "",
      fields:
        Array.isArray(searchInput.fields) && searchInput.fields.length > 0
          ? searchInput.fields
          : defaultSearchFields,
    };

    field.mutate(
      {
        pagination,
        sorting,
        filters,
        search,
        ...(Array.isArray(value.facets) ? { facets: value.facets } : {}),
      },
      field,
    );
  });
}

function requestSchemaProperties(
  contract: ReturnType<typeof resolveQueryRequestContract>,
): QueryRequestVineSchemaProperties {
  const pageSize = vine.number().withoutDecimals().positive().max(contract.limits.maxPageSize);
  const offsetPagination = strictObject({
    mode: vine.literal("offset").optional(),
    pageIndex: vine.number().withoutDecimals().positive().optional(),
    pageSize: pageSize.optional(),
    count: vine.enum(["none", "exact"] as const).optional(),
  });
  const cursorPagination = strictObject({
    mode: vine.literal("cursor").optional(),
    cursor: vine.string().maxLength(contract.limits.maxCursorLength).nullable().optional(),
    pageSize: pageSize.optional(),
    count: vine.enum(["none", "exact"] as const).optional(),
  });
  const filter = vine
    .array(
      filterNodeSchema({
        filters: contract.filters,
        maxDepth: contract.limits.maxFilterDepth,
        depth: 1,
      }),
    )
    .maxLength(contract.limits.maxFilterNodes);
  const sorting = vine.array(
    strictObject({
      key: allowedStringSchema(contract.sorting, "Sorting field"),
      dir: vine.enum(QUERY_SORT_DIRECTIONS),
    }),
  );
  const search = strictObject({
    value: vine.string().optional(),
    fields: vine.array(allowedStringSchema(contract.search, "Search field")).optional(),
  });
  const facets = vine
    .array(
      strictObject({
        key: allowedStringSchema(contract.facets, "Facet field"),
        mode: vine.enum(QUERY_FACET_MODES).optional(),
        search: vine.string().optional(),
        limit: vine
          .number()
          .withoutDecimals()
          .positive()
          .max(contract.limits.maxFacetLimit)
          .optional(),
        cursor: vine.string().nullable().optional(),
      }),
    )
    .maxLength(contract.limits.maxFacetCount);

  return {
    pagination: vine
      .union([
        vine.union.if((value) => isRecord(value) && value.mode === "cursor", cursorPagination),
        vine.union.else(offsetPagination),
      ])
      .optional(),
    sorting: sorting.optional(),
    filters: filter.optional(),
    search: search.optional(),
    facets: facets.optional(),
  };
}

export function requestSchema<
  TDb extends QueryEngineDb,
  TSchema extends QueryEngineSchema,
  TRelations extends QueryEngineRelations,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends object | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
>(
  resource: QueryResource<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>,
  override?: QueryRequestSchemaOverride,
): QueryRequestVineSchema {
  const contract = resolveQueryRequestContract(resource, override);
  const defaultSearchFields = [...resource.queryConfig.search.defaults].filter((field) =>
    contract.search.has(field),
  );
  const schema = new VineObject<
    QueryRequestVineSchemaProperties,
    QueryRequestVineInput,
    QueryRequestVineOutput,
    QueryRequestVineOutput
  >(requestSchemaProperties(contract))
    .use(strictObjectRule(["pagination", "sorting", "filters", "search", "facets"]))
    .use(reportRequestErrors(contract)())
    .use(normalizeRequestDefaults(contract, defaultSearchFields)());

  return schema;
}

export type { QueryRequest, QueryRequestInput, QueryRequestSchemaOverride };
