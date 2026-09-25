import { getColumns } from "drizzle-orm";
import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";

export type QueryZodIntegrationConfig = { readonly package: "zod" };

export const queryZodIntegration: QueryZodIntegrationConfig = { package: "zod" };

type ResourceRow<TResource> = TResource extends { $infer: { query: infer TRow } }
  ? Extract<TRow, Record<string, unknown>>
  : never;

type ResourceProfileKey<TResource> = TResource extends {
  $infer: { profiles: infer TProfiles };
}
  ? Extract<keyof TProfiles, string>
  : never;

type ResourceProfileRow<TResource, TProfile extends PropertyKey> = TResource extends {
  $infer: { profiles: infer TProfiles };
}
  ? TProfile extends keyof TProfiles
    ? Extract<TProfiles[TProfile], Record<string, unknown>>
    : never
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

type OverrideColumns<TRow extends Record<string, unknown>, TColumns> = [TColumns] extends [never]
  ? TRow
  : TColumns extends object
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

type OverrideRow<TRow extends Record<string, unknown>, TRowOverride> = [TRowOverride] extends [
  undefined,
]
  ? TRow
  : OverrideRelations<TRow, TRowOverride>;

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
  view?: { select: Record<string, any> },
): any {
  const table = resource.schema[tableName];
  if (!table) throw new Error(`Unknown table "${tableName}" in resource response schema`);
  const base = createSelectSchema(table, override?.columns) as any;
  const shape = { ...base.shape } as Record<string, any>;
  const model = resource.models?.[tableName];
  const relations = resource.relationGraph[tableName]?.relations ?? {};
  for (const key of Object.keys(shape)) {
    if (
      model?.private?.includes(key) ||
      (view ? view.select[key] !== true : model?.hidden?.includes(key))
    )
      delete shape[key];
  }
  for (const [key, selection] of Object.entries(view?.select ?? {})) {
    if (model?.private?.includes(key))
      throw new Error(`Cannot select private field "${tableName}.${key}"`);
    if (selection !== true || !model?.virtual?.[key]) continue;
    const field = model.virtual[key];
    const overridden = (override?.columns as any)?.[key];
    let validator;
    switch (field.kind) {
      case "text":
        validator = z.string();
        break;
      case "number":
        validator = z.number();
        break;
      case "boolean":
        validator = z.boolean();
        break;
      case "timestamp":
        validator = z.date();
        break;
      default:
        if (!overridden)
          throw new Error(
            `Provide a response schema override for scalar virtual "${tableName}.${key}"`,
          );
        validator = z.unknown();
    }
    if (field.nullable) validator = validator.nullable();
    if (typeof overridden === "function") validator = overridden(validator);
    shape[key] = validator;
  }
  const selectedRelations = view
    ? Object.fromEntries(Object.entries(view.select).filter(([key]) => key in relations))
    : (withClause ?? {});
  for (const [relationName, selection] of Object.entries(selectedRelations)) {
    const relation = relations[relationName];
    if (!relation) throw new Error(`Unknown relation "${relationName}" on table "${tableName}"`);
    const nestedWith = view ? undefined : (selection as any)?.with;
    const nestedView =
      view && selection !== true ? (selection as { select: Record<string, any> }) : undefined;
    const nested = responseRowSchema(
      resource,
      relation.targetTableName,
      nestedWith,
      override?.relations?.[relationName],
      nestedView,
    );
    shape[relationName] =
      relation.relationType === "many"
        ? z.array(nested)
        : relation.optional === false
          ? nested
          : nested.nullable();
  }
  return z.object(shape);
}

function responseRelations(resource: any, load?: string) {
  if (load) {
    const profile = resource.hydration?.profiles?.[load];
    if (!profile) {
      throw new Error(`Unknown hydration profile "${load}" for resource "${String(resource.key)}"`);
    }
    return profile;
  }

  const defaultProfile = resource.hydration?.defaults?.query;
  return defaultProfile ? resource.hydration.profiles[defaultProfile] : resource.relations;
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

function summaryResponseSchema(resource: any): any {
  const fields = resource.getSummaryShape?.();
  if (!fields) throw new Error("No summary defined for this resource");
  const entries: Record<string, any> = {};
  for (const [name, field] of Object.entries(fields) as Array<[string, any]>) {
    let validator;
    if (field.kind === "column") {
      const key = Object.entries(getColumns(field.column.table)).find(
        ([, column]) => column === field.column,
      )?.[0];
      if (!key) throw new Error(`Unknown summary column for "${name}"`);
      validator = (createSelectSchema(field.column.table) as any).shape[key];
    } else {
      switch (field.kind) {
        case "number":
          validator = z.number();
          break;
        case "string":
          validator = z.string();
          break;
        case "boolean":
          validator = z.boolean();
          break;
        case "date":
          validator = z.date();
          break;
        default:
          throw new Error(`Unknown summary value kind for "${name}"`);
      }
    }
    entries[name] = field.nullable ? validator.nullable() : validator;
  }
  return z.object(entries);
}

interface ResourceWithViews {
  $infer: {
    query: Record<string, unknown>;
    views: Record<string, Record<string, unknown>>;
    summary: Record<string, unknown>;
  };
}

type SummaryOption<R extends ResourceWithViews> = keyof R["$infer"]["summary"] extends never
  ? never
  : boolean | z.ZodType<R["$infer"]["summary"]>;

/** Build a response schema from Drizzle select schemas and the resource relation tree. */
export function responseSchema<
  R extends ResourceWithViews,
  const N extends Extract<keyof R["$infer"]["views"], string>,
  const O extends QueryResponseSchemaOverride<R["$infer"]["views"][N]>,
  const S extends SummaryOption<R> | undefined = undefined,
>(
  resource: R,
  options: { view: N; summary?: S; override: O },
): z.ZodType<
  QuerySchemaResponse<OverrideRow<R["$infer"]["views"][N], O>> &
    (S extends false | undefined ? {} : { summary: R["$infer"]["summary"] })
>;
export function responseSchema<
  R extends ResourceWithViews,
  const N extends Extract<keyof R["$infer"]["views"], string>,
  const S extends SummaryOption<R> | undefined = undefined,
>(
  resource: R,
  options: { view: N; summary?: S },
): z.ZodType<
  QuerySchemaResponse<R["$infer"]["views"][N]> &
    (S extends false | undefined ? {} : { summary: R["$infer"]["summary"] })
>;
export function responseSchema<
  R extends ResourceWithViews,
  const O extends QueryResponseSchemaOverride<R["$infer"]["query"]>,
  const S extends SummaryOption<R>,
>(
  resource: R,
  options: { summary: S; override: O },
): z.ZodType<
  QuerySchemaResponse<OverrideRow<R["$infer"]["query"], O>> &
    (S extends false ? {} : { summary: R["$infer"]["summary"] })
>;
export function responseSchema<R extends ResourceWithViews, const S extends SummaryOption<R>>(
  resource: R,
  options: { summary: S },
): z.ZodType<
  QuerySchemaResponse<R["$infer"]["query"]> &
    (S extends false ? {} : { summary: R["$infer"]["summary"] })
>;
export function responseSchema<
  TResource extends {
    key: string;
    relations?: Record<string, unknown>;
    $infer: { query: Record<string, unknown>; profiles: Record<string, Record<string, unknown>> };
  },
  const TProfile extends ResourceProfileKey<TResource>,
  const TOverride extends QueryResponseSchemaOverride<ResourceProfileRow<TResource, TProfile>>,
>(
  resource: TResource,
  options: {
    load: TProfile;
    override: QueryResponseSchemaOverride<ResourceProfileRow<TResource, TProfile>> & TOverride;
  },
): z.ZodType<QuerySchemaResponse<OverrideRow<ResourceProfileRow<TResource, TProfile>, TOverride>>>;
export function responseSchema<
  TResource extends {
    key: string;
    relations?: Record<string, unknown>;
    $infer: { query: Record<string, unknown>; profiles: Record<string, Record<string, unknown>> };
  },
  const TProfile extends ResourceProfileKey<TResource>,
>(
  resource: TResource,
  options: { load: TProfile },
): z.ZodType<QuerySchemaResponse<ResourceProfileRow<TResource, TProfile>>>;
export function responseSchema<
  TResource extends {
    key: string;
    relations?: Record<string, unknown>;
    $infer: { query: Record<string, unknown> };
  },
  const TOverride extends QueryResponseSchemaOverride<ResourceRow<TResource>>,
>(
  resource: TResource,
  override: QueryResponseSchemaOverride<ResourceRow<TResource>> & TOverride,
): z.ZodType<QuerySchemaResponse<OverrideRow<ResourceRow<TResource>, TOverride>>>;
export function responseSchema<
  TResource extends {
    key: string;
    relations?: Record<string, unknown>;
    $infer: { query: Record<string, unknown> };
  },
>(resource: TResource): z.ZodType<QuerySchemaResponse<ResourceRow<TResource>>>;
export function responseSchema(
  resource: any,
  options?:
    | QueryResponseSchemaOverride
    | {
        load?: string;
        view?: string;
        summary?: boolean | z.ZodType;
        override?: QueryResponseSchemaOverride;
      },
): any {
  const hydrationOptions =
    options &&
    ("load" in options || "view" in options || "summary" in options || "override" in options)
      ? options
      : undefined;
  const override = hydrationOptions
    ? hydrationOptions.override
    : (options as QueryResponseSchemaOverride | undefined);
  const view =
    hydrationOptions?.view === undefined ? undefined : resource.views?.[hydrationOptions.view];
  if (hydrationOptions?.view !== undefined && !view)
    throw new Error(`Unknown view "${hydrationOptions.view}"`);
  const row = responseRowSchema(
    resource,
    String(resource.key),
    responseRelations(resource, hydrationOptions?.load),
    override,
    view,
  );
  return z.strictObject({
    ...(hydrationOptions?.summary
      ? {
          summary:
            hydrationOptions.summary === true
              ? summaryResponseSchema(resource)
              : hydrationOptions.summary,
        }
      : {}),
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
