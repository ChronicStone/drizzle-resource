import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

export type QueryValibotIntegrationConfig = { readonly package: "valibot" };

export const queryValibotIntegration: QueryValibotIntegrationConfig = { package: "valibot" };

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
  const defaultSorting = [...(contract.defaults.sorting ?? [])];
  const defaultSearchFields = [...resource.queryConfig.search.defaults].filter((field) =>
    contract.search.has(field),
  );

  return v.strictObject({
    pagination: v.optional(
      v.strictObject({
        pageIndex: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), defaultPageIndex),
        pageSize: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(contract.limits.maxPageSize)),
          defaultPageSize,
        ),
      }),
      { pageIndex: defaultPageIndex, pageSize: defaultPageSize },
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
export function responseSchema(resource: any, override?: QueryResponseSchemaOverride): any {
  const row = responseRowSchema(resource, String(resource.key), resource.relations, override);
  return v.strictObject({
    rows: v.array(row),
    rowCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
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
