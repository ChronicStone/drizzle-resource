import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";

export type QueryZodIntegrationConfig = { readonly package: "zod" };

export const queryZodIntegration: QueryZodIntegrationConfig = { package: "zod" };

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

type OverrideOutput<TSchema> = TSchema extends z.ZodType<infer TOutput> ? TOutput : never;

type OverrideColumns<TRow extends Record<string, unknown>, TColumns> = TColumns extends object
  ? Omit<TRow, keyof TColumns> & {
      [TKey in keyof TColumns & keyof TRow]: TColumns[TKey] extends (
        schema: z.ZodType<TRow[TKey]>,
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
    [TKey in ColumnKey<TRow>]?: (schema: z.ZodType<TRow[TKey]>) => z.ZodType;
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
  return z.string().refine((value) => values.has(value), `${label} is not allowed`);
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
  const shape = { ...base.shape } as Record<string, any>;
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
    shape[relationName] = relation.relationType === "many" ? z.array(nested) : nested.nullable();
  }

  return z.object(shape);
}

/** Build a strict transport schema from a resource's request contract. */
export function requestSchema(resource: any, override?: QueryRequestSchemaOverride): any {
  const contract = resolveQueryRequestContract(resource, override);
  const filter: z.ZodType<any> = z.lazy(() =>
    z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("condition"),
        key: allowedString(contract.filters, "Filter field"),
        operator: z.enum([
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
        value: z.unknown(),
      }),
      z.strictObject({
        type: z.literal("group"),
        combinator: z.enum(["and", "or"]),
        children: z.array(filter),
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

  const pageSize = z.number().int().positive().max(contract.limits.maxPageSize);
  const offsetPagination = z.strictObject({
    mode: z.literal("offset").default("offset"),
    pageIndex: z.number().int().positive().default(defaultPageIndex),
    pageSize: pageSize.default(defaultPageSize),
    count: z.enum(["none", "exact"]).default(defaultMode === "offset" ? defaultCount : "exact"),
  });
  const cursorPagination = z.strictObject({
    mode: z.literal("cursor"),
    cursor: z.string().max(contract.limits.maxCursorLength).nullable().default(null),
    pageSize: pageSize.default(defaultPageSize),
    count: z.enum(["none", "exact"]).default(defaultMode === "cursor" ? defaultCount : "none"),
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

  return z.strictObject({
    pagination: z
      .union([offsetPagination, cursorPagination])
      .refine(
        (pagination) => contract.pagination.has(pagination.mode),
        "Pagination mode is not allowed",
      )
      .default(paginationDefault),
    sorting: z
      .array(
        z.strictObject({
          key: allowedString(contract.sorting, "Sorting field"),
          dir: z.enum(["asc", "desc"]),
        }),
      )
      .transform((value) => (value.length > 0 ? value : defaultSorting))
      .default(defaultSorting),
    filters: z
      .array(filter)
      .max(contract.limits.maxFilterNodes)
      .refine(
        (value) => hasAllowedFilterDepth(value, contract.limits.maxFilterDepth),
        `Filter tree cannot exceed ${contract.limits.maxFilterDepth} levels`,
      )
      .default([]),
    search: z
      .object({
        value: z.string().default(""),
        fields: z
          .array(allowedString(contract.search, "Search field"))
          .transform((value) => (value.length > 0 ? value : defaultSearchFields))
          .default(defaultSearchFields),
      })
      .default({ value: "", fields: defaultSearchFields }),
    facets: z
      .array(
        z.strictObject({
          key: allowedString(contract.facets, "Facet field"),
          mode: z.enum(["exclude-self", "include-self"]).optional(),
          search: z.string().optional(),
          limit: z.number().int().positive().max(contract.limits.maxFacetLimit).optional(),
          cursor: z.string().nullable().optional(),
        }),
      )
      .max(contract.limits.maxFacetCount)
      .optional(),
  });
}

/** Build a response schema from Drizzle select schemas and the resource relation tree. */
export function responseSchema<
  TResource extends { key: string; relations?: Record<string, unknown> },
  const TOverride extends QueryResponseSchemaOverride<ResourceRow<TResource>>,
>(
  resource: TResource,
  override: QueryResponseSchemaOverride<ResourceRow<TResource>> & TOverride,
): z.ZodType<QuerySchemaResponse<OverrideRow<ResourceRow<TResource>, TOverride>>>;
export function responseSchema<
  TResource extends { key: string; relations?: Record<string, unknown> },
>(resource: TResource): z.ZodType<QuerySchemaResponse<ResourceRow<TResource>>>;
export function responseSchema(resource: any, override?: QueryResponseSchemaOverride): any {
  const row = responseRowSchema(resource, String(resource.key), resource.relations, override);
  return z.strictObject({
    rows: z.array(row),
    pageInfo: z.union([
      z.strictObject({
        mode: z.literal("offset"),
        pageIndex: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        hasNextPage: z.boolean(),
        count: z.literal("none"),
        rowCount: z.null(),
      }),
      z.strictObject({
        mode: z.literal("offset"),
        pageIndex: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        hasNextPage: z.boolean(),
        count: z.literal("exact"),
        rowCount: z.number().int().nonnegative(),
      }),
      z.strictObject({
        mode: z.literal("cursor"),
        pageSize: z.number().int().positive(),
        nextCursor: z.string().nullable(),
        count: z.literal("none"),
        rowCount: z.null(),
      }),
      z.strictObject({
        mode: z.literal("cursor"),
        pageSize: z.number().int().positive(),
        nextCursor: z.string().nullable(),
        count: z.literal("exact"),
        rowCount: z.number().int().nonnegative(),
      }),
    ]),
    facets: z
      .array(
        z.strictObject({
          key: z.string(),
          options: z.array(
            z.strictObject({ value: z.unknown(), count: z.number().int().nonnegative() }),
          ),
          nextCursor: z.string().nullable().optional(),
          total: z.number().int().nonnegative().optional(),
        }),
      )
      .optional(),
  });
}
