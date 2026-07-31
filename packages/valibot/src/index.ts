import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

export type QueryValibotIntegrationConfig = { readonly package: "valibot" };

export const queryValibotIntegration: QueryValibotIntegrationConfig = { package: "valibot" };

type ResourceRow<TResource> = TResource extends {
  query: (...args: never[]) => Promise<{ rows: Array<infer TRow> }>;
}
  ? Extract<TRow, Record<string, unknown>>
  : never;

interface QuerySchemaResponse<TRow> {
  rows: TRow[];
  pageInfo:
    | {
        mode: "offset";
        pageIndex: number;
        pageSize: number;
        hasNextPage: boolean;
        count: "none";
        rowCount: null;
      }
    | {
        mode: "offset";
        pageIndex: number;
        pageSize: number;
        hasNextPage: boolean;
        count: "exact";
        rowCount: number;
      }
    | {
        mode: "cursor";
        pageSize: number;
        nextCursor: string | null;
        count: "none";
        rowCount: null;
      }
    | {
        mode: "cursor";
        pageSize: number;
        nextCursor: string | null;
        count: "exact";
        rowCount: number;
      };
  facets?: Array<{
    key: string;
    options: Array<{ value: unknown; count: number }>;
    nextCursor?: string | null;
    total?: number;
  }>;
}

type RelationKey<TRow extends Record<string, unknown>> = {
  [TKey in keyof TRow]-?: NonNullable<TRow[TKey]> extends
    | readonly unknown[]
    | Record<string, unknown>
    ? TKey
    : never;
}[keyof TRow];

type ColumnKey<TRow extends Record<string, unknown>> = Exclude<keyof TRow, RelationKey<TRow>>;

type RelationRow<TValue> =
  NonNullable<TValue> extends readonly (infer TItem)[]
    ? Extract<TItem, Record<string, unknown>>
    : Extract<NonNullable<TValue>, Record<string, unknown>>;

type SchemaFor<TOutput> = v.BaseSchema<unknown, TOutput, v.BaseIssue<unknown>>;

type OverrideOutput<TSchema> =
  TSchema extends v.BaseSchema<unknown, infer TOutput, v.BaseIssue<unknown>> ? TOutput : never;

type OverrideColumns<TRow extends Record<string, unknown>, TColumns> = TColumns extends object
  ? Omit<TRow, keyof TColumns> & {
      [TKey in keyof TColumns & keyof TRow]: TColumns[TKey] extends (
        schema: SchemaFor<TRow[TKey]>,
      ) => infer TSchema
        ? OverrideOutput<TSchema>
        : TRow[TKey];
    }
  : TRow;

type OverrideRelation<TValue, TOverride> =
  NonNullable<TValue> extends readonly unknown[]
    ? Array<OverrideRow<RelationRow<TValue>, TOverride>>
    : OverrideRow<RelationRow<TValue>, TOverride> | Extract<TValue, null | undefined>;

type OverrideRelations<TRow extends Record<string, unknown>, TRowOverride> = TRowOverride extends {
  relations?: infer TRelations;
}
  ? TRelations extends object
    ? Omit<
        OverrideColumns<TRow, TRowOverride extends { columns?: infer TColumns } ? TColumns : never>,
        keyof TRelations
      > & {
        [TKey in keyof TRelations & keyof TRow]: OverrideRelation<TRow[TKey], TRelations[TKey]>;
      }
    : OverrideColumns<TRow, TRowOverride extends { columns?: infer TColumns } ? TColumns : never>
  : OverrideColumns<TRow, TRowOverride extends { columns?: infer TColumns } ? TColumns : never>;

type OverrideRow<TRow extends Record<string, unknown>, TRowOverride> = OverrideRelations<
  TRow,
  TRowOverride
>;

export interface QueryResponseSchemaOverride<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> {
  columns?: {
    [TKey in ColumnKey<TRow>]?: (schema: SchemaFor<TRow[TKey]>) => v.GenericSchema;
  };
  relations?: {
    [TKey in RelationKey<TRow>]?: QueryResponseSchemaOverride<RelationRow<TRow[TKey]>>;
  };
}

interface QueryRequestSchemaOverride {
  defaults?: {
    pagination?: {
      mode?: "offset" | "cursor";
      pageIndex?: number;
      pageSize?: number;
      count?: "none" | "exact";
    };
    sorting?: readonly any[];
  };
  limits?: Partial<ReturnType<typeof defaultLimits>>;
  allow?: {
    filters?: readonly string[];
    sorting?: readonly string[];
    search?: readonly string[];
    facets?: readonly string[];
    pagination?: readonly ("offset" | "cursor")[];
  };
}

const defaultLimits = () => ({
  maxPageSize: 100,
  maxCursorLength: 2048,
  maxFilterDepth: 5,
  maxFilterNodes: 50,
  maxFacetCount: 10,
  maxFacetLimit: 50,
});

function resolveQueryRequestContract(resource: any, override?: QueryRequestSchemaOverride) {
  const restrict = (base: Iterable<string>, allow?: readonly string[]) => {
    const fields = new Set(base);
    return allow === undefined ? fields : new Set(allow.filter((field) => fields.has(field)));
  };
  const defaults = {
    ...resource.queryConfig.defaults,
    ...override?.defaults,
    pagination: {
      ...resource.queryConfig.defaults.pagination,
      ...override?.defaults?.pagination,
    },
    sorting: override?.defaults?.sorting ?? resource.queryConfig.defaults.sorting,
  };
  const contract = {
    filters: restrict(resource.fields.keys(), override?.allow?.filters),
    sorting: restrict(
      Array.from(resource.fields.values())
        .filter((entry: any) => entry.sortable)
        .map((entry: any) => entry.path),
      override?.allow?.sorting,
    ),
    search: restrict(resource.queryConfig.search.allowed, override?.allow?.search),
    facets: restrict(resource.queryConfig.facets.allowed, override?.allow?.facets),
    pagination: restrict(resource.queryConfig.pagination.modes, override?.allow?.pagination),
    defaults,
    limits: Object.fromEntries(
      Object.entries(defaultLimits()).map(([key, fallback]) => [
        key,
        Math.min(
          resource.queryConfig.validation?.[key] ?? fallback,
          override?.limits?.[key as keyof typeof override.limits] ?? Infinity,
        ),
      ]),
    ) as ReturnType<typeof defaultLimits>,
  };

  for (const descriptor of contract.defaults.sorting ?? []) {
    if (!contract.sorting.has(descriptor.key)) {
      throw new Error(
        `Default sorting field "${descriptor.key}" is not allowed for resource "${String(resource.key)}"`,
      );
    }
  }
  const defaultPaginationMode = contract.defaults.pagination?.mode ?? "offset";
  if (!contract.pagination.has(defaultPaginationMode)) {
    throw new Error(
      `Default pagination mode "${defaultPaginationMode}" is not allowed for resource "${String(resource.key)}"`,
    );
  }
  return contract;
}

function allowedString(values: Set<string>, label: string) {
  return v.pipe(
    v.string(),
    v.check((value) => values.has(value), `${label} is not allowed`),
  );
}

function hasAllowedFilterDepth(filters: any[], maxDepth: number) {
  const stack = filters.map((filter) => ({ filter, depth: 1 }));
  while (stack.length > 0) {
    const { filter, depth } = stack.pop()!;
    if (depth > maxDepth) return false;
    if (filter.type === "group") {
      stack.push(...filter.children.map((child: any) => ({ filter: child, depth: depth + 1 })));
    }
  }
  return true;
}

function responseRowSchema(
  resource: any,
  tableName: string,
  withClause: Record<string, unknown> | undefined,
  override?: QueryResponseSchemaOverride,
): any {
  const table = resource.schema[tableName];
  if (!table) throw new Error(`Unknown table "${tableName}" in resource response schema`);

  const base = createSelectSchema(table, override?.columns) as any;
  const entries = { ...base.entries } as Record<string, any>;
  const relations = resource.relationGraph[tableName]?.relations ?? {};

  for (const [relationName, relationConfig] of Object.entries(withClause ?? {})) {
    const relation = relations[relationName];
    if (!relation) throw new Error(`Unknown relation "${relationName}" on table "${tableName}"`);
    const nestedWith =
      relationConfig && typeof relationConfig === "object" && "with" in relationConfig
        ? ((relationConfig as { with?: Record<string, unknown> }).with ?? undefined)
        : undefined;
    const nested = responseRowSchema(
      resource,
      relation.targetTableName,
      nestedWith,
      override?.relations?.[relationName],
    );
    entries[relationName] = relation.relationType === "many" ? v.array(nested) : v.nullable(nested);
  }

  return v.object(entries);
}

/** Build a strict transport schema from a resource's request contract. */
export function requestSchema(resource: any, override?: QueryRequestSchemaOverride): any {
  const contract = resolveQueryRequestContract(resource, override);
  const filter: any = v.lazy(() =>
    v.variant("type", [
      v.strictObject({
        type: v.literal("condition"),
        key: allowedString(contract.filters, "Filter field"),
        operator: v.picklist([
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
        ]),
        value: v.unknown(),
      }),
      v.strictObject({
        type: v.literal("group"),
        combinator: v.picklist(["and", "or"]),
        children: v.array(filter),
      }),
    ]),
  );
  const defaultPageIndex = contract.defaults.pagination?.pageIndex ?? 1;
  const defaultPageSize = contract.defaults.pagination?.pageSize ?? 25;
  const defaultMode = contract.defaults.pagination?.mode ?? "offset";
  const defaultCount =
    contract.defaults.pagination?.count ?? (defaultMode === "cursor" ? "none" : "exact");
  const defaultSorting = [...(contract.defaults.sorting ?? [])];
  const defaultSearchFields = [...resource.queryConfig.search.defaults].filter((field) =>
    contract.search.has(field),
  );

  const pageSize = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(contract.limits.maxPageSize),
  );
  const offsetPagination = v.strictObject({
    mode: v.optional(v.literal("offset"), "offset"),
    pageIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), defaultPageIndex),
    pageSize: v.optional(pageSize, defaultPageSize),
    count: v.optional(
      v.picklist(["none", "exact"]),
      defaultMode === "offset" ? defaultCount : "exact",
    ),
  });
  const cursorPagination = v.strictObject({
    mode: v.literal("cursor"),
    cursor: v.optional(
      v.nullable(v.pipe(v.string(), v.maxLength(contract.limits.maxCursorLength))),
      null,
    ),
    pageSize: v.optional(pageSize, defaultPageSize),
    count: v.optional(
      v.picklist(["none", "exact"]),
      defaultMode === "cursor" ? defaultCount : "none",
    ),
  });
  const paginationDefault =
    defaultMode === "cursor"
      ? { mode: "cursor" as const, cursor: null, pageSize: defaultPageSize, count: defaultCount }
      : {
          mode: "offset" as const,
          pageIndex: defaultPageIndex,
          pageSize: defaultPageSize,
          count: defaultCount,
        };

  return v.strictObject({
    pagination: v.optional(
      v.pipe(
        v.union([offsetPagination, cursorPagination]),
        v.check(
          (pagination) => contract.pagination.has(pagination.mode),
          "Pagination mode is not allowed",
        ),
      ),
      paginationDefault,
    ),
    sorting: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            key: allowedString(contract.sorting, "Sorting field"),
            dir: v.picklist(["asc", "desc"]),
          }),
        ),
        v.transform((value) => (value.length > 0 ? value : defaultSorting)),
      ),
      defaultSorting,
    ),
    filters: v.optional(
      v.pipe(
        v.array(filter),
        v.maxLength(contract.limits.maxFilterNodes),
        v.check(
          (value) => hasAllowedFilterDepth(value, contract.limits.maxFilterDepth),
          `Filter tree cannot exceed ${contract.limits.maxFilterDepth} levels`,
        ),
      ),
      [],
    ),
    search: v.optional(
      v.strictObject({
        value: v.optional(v.string(), ""),
        fields: v.optional(
          v.pipe(
            v.array(allowedString(contract.search, "Search field")),
            v.transform((value) => (value.length > 0 ? value : defaultSearchFields)),
          ),
          defaultSearchFields,
        ),
      }),
      { value: "", fields: defaultSearchFields },
    ),
    facets: v.optional(
      v.pipe(
        v.array(
          v.strictObject({
            key: allowedString(contract.facets, "Facet field"),
            mode: v.optional(v.picklist(["exclude-self", "include-self"])),
            search: v.optional(v.string()),
            limit: v.optional(
              v.pipe(
                v.number(),
                v.integer(),
                v.minValue(1),
                v.maxValue(contract.limits.maxFacetLimit),
              ),
            ),
            cursor: v.optional(v.nullable(v.string())),
          }),
        ),
        v.maxLength(contract.limits.maxFacetCount),
      ),
    ),
  });
}

/** Build a response schema from Drizzle select schemas and the resource relation tree. */
export function responseSchema<
  TResource extends { key: string; relations?: Record<string, unknown> },
  const TOverride extends QueryResponseSchemaOverride<ResourceRow<TResource>>,
>(
  resource: TResource,
  override: QueryResponseSchemaOverride<ResourceRow<TResource>> & TOverride,
): v.GenericSchema<QuerySchemaResponse<OverrideRow<ResourceRow<TResource>, TOverride>>>;
export function responseSchema<
  TResource extends { key: string; relations?: Record<string, unknown> },
>(resource: TResource): v.GenericSchema<QuerySchemaResponse<ResourceRow<TResource>>>;
export function responseSchema(resource: any, override?: QueryResponseSchemaOverride): any {
  const row = responseRowSchema(resource, String(resource.key), resource.relations, override);
  return v.strictObject({
    rows: v.array(row),
    pageInfo: v.union([
      v.strictObject({
        mode: v.literal("offset"),
        pageIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
        pageSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
        hasNextPage: v.boolean(),
        count: v.literal("none"),
        rowCount: v.null(),
      }),
      v.strictObject({
        mode: v.literal("offset"),
        pageIndex: v.pipe(v.number(), v.integer(), v.minValue(1)),
        pageSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
        hasNextPage: v.boolean(),
        count: v.literal("exact"),
        rowCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
      v.strictObject({
        mode: v.literal("cursor"),
        pageSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
        nextCursor: v.nullable(v.string()),
        count: v.literal("none"),
        rowCount: v.null(),
      }),
      v.strictObject({
        mode: v.literal("cursor"),
        pageSize: v.pipe(v.number(), v.integer(), v.minValue(1)),
        nextCursor: v.nullable(v.string()),
        count: v.literal("exact"),
        rowCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
      }),
    ]),
    facets: v.optional(
      v.array(
        v.strictObject({
          key: v.string(),
          options: v.array(
            v.strictObject({
              value: v.unknown(),
              count: v.pipe(v.number(), v.integer(), v.minValue(0)),
            }),
          ),
          nextCursor: v.optional(v.nullable(v.string())),
          total: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
        }),
      ),
    ),
  });
}
