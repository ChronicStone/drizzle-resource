import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";

export type QueryZodIntegrationConfig = { readonly package: "zod" };

export const queryZodIntegration: QueryZodIntegrationConfig = { package: "zod" };

export interface QueryResponseSchemaOverride {
  columns?: Record<string, (schema: any) => any>;
  relations?: Record<string, QueryResponseSchemaOverride>;
}

interface QueryRequestSchemaOverride {
  defaults?: { pagination?: { pageIndex?: number; pageSize?: number }; sorting?: readonly any[] };
  limits?: Partial<ReturnType<typeof defaultLimits>>;
  allow?: Partial<Record<"filters" | "sorting" | "search" | "facets", readonly string[]>>;
}

const defaultLimits = () => ({
  maxPageSize: 100,
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
      stack.push(...filter.children.map((child) => ({ filter: child, depth: depth + 1 })));
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
  const filter = z.lazy(() =>
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
  const defaultSorting = [...(contract.defaults.sorting ?? [])];
  const defaultSearchFields = [...resource.queryConfig.search.defaults].filter((field) =>
    contract.search.has(field),
  );

  return z.strictObject({
    pagination: z
      .object({
        pageIndex: z.number().int().positive().default(defaultPageIndex),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(contract.limits.maxPageSize)
          .default(defaultPageSize),
      })
      .default({ pageIndex: defaultPageIndex, pageSize: defaultPageSize }),
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
export function responseSchema(resource: any, override?: QueryResponseSchemaOverride): any {
  const row = responseRowSchema(resource, String(resource.key), resource.relations, override);
  return z.strictObject({
    rows: z.array(row),
    rowCount: z.number().int().nonnegative(),
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
