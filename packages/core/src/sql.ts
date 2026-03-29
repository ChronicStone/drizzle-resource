import { and, asc, desc, eq, exists, like, not, or, sql } from "drizzle-orm";
import { getColumns } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type {
  FieldRegistryEntry,
  FieldRegistryRelationStep,
  GenericObject,
  QueryEngineConfig,
  QueryFacetRequest,
  QueryFacetsResponse,
  QueryFilterCondition,
  QueryFilterGroup,
  QueryFilterInput,
  QueryFilterNode,
  QueryRelationsConfig,
  QueryRequest,
  QueryResource,
  QueryResourceUtils,
  QueryRootKey,
  QueryWith,
} from "./types.js";

const utilsCache = new WeakMap<object, QueryResourceUtils<any>>();

function normalizeString(value: unknown) {
  return String(value ?? "").toLowerCase();
}

function isTextColumn(column: any): boolean {
  const t = column?.columnType;
  return t === "PgVarchar" || t === "PgText" || t === "PgChar" || t === "PgCitext";
}

function normalizeScopeInput<TField extends string>(
  input: QueryFilterInput<TField>,
): QueryFilterNode<TField> | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    return {
      type: "group",
      combinator: "and",
      children: input,
    };
  }
  return input;
}

export function normalizeFilters<TField extends string>(
  filters: QueryFilterInput<TField>,
): QueryFilterGroup<TField> {
  const normalized = normalizeScopeInput(filters);
  if (!normalized) {
    return {
      type: "group",
      combinator: "and",
      children: [],
    };
  }

  return normalized.type === "group" && normalized.combinator === "and"
    ? normalized
    : {
        type: "group",
        combinator: "and",
        children: [normalized],
      };
}

function mergeScopeFilters<TField extends string>(
  scopeFilters: QueryFilterInput<TField>,
  requestFilters: QueryRequest["filters"],
): QueryRequest["filters"] {
  const requestChildren = [...normalizeFilters(requestFilters).children];
  const normalizedScope = normalizeScopeInput(scopeFilters);
  if (!normalizedScope) return requestChildren;
  return [normalizedScope, ...requestChildren];
}

function eqColumns(sourceColumns: any[], targetColumns: any[]) {
  const predicates = sourceColumns.map((sourceColumn, index) =>
    eq(sourceColumn, targetColumns[index]),
  );
  return and(...predicates) ?? sql`true`;
}

function collectConditionFields(node: QueryFilterNode, fields: string[]) {
  if (node.type === "condition") {
    fields.push(node.key);
    return;
  }

  for (const child of node.children) collectConditionFields(child, fields);
}

function collectConditionFieldsFromFilters(filters: QueryRequest["filters"], fields: string[]) {
  for (const node of filters) collectConditionFields(node, fields);
}

function buildOuterJoins(
  resource: QueryResource<any, any, any, any, any, any, any>,
  request: QueryRequest,
) {
  const requestedFields: string[] = [];
  collectConditionFieldsFromFilters(request.filters, requestedFields);
  requestedFields.push(...request.search.fields, ...request.sorting.map((rule) => rule.key));

  const relationSteps = new Map<string, FieldRegistryRelationStep>();
  for (const path of requestedFields) {
    const entry = resource.fields.get(path);
    if (!entry) continue;
    for (const step of entry.outerJoinSteps) {
      relationSteps.set(step.path, step);
    }
  }

  return Array.from(relationSteps.values());
}

function getJoinPlanCacheKey(request: QueryRequest) {
  const requestedFields: string[] = [];
  collectConditionFieldsFromFilters(request.filters, requestedFields);
  requestedFields.push(...request.search.fields, ...request.sorting.map((rule) => rule.key));
  requestedFields.sort();
  return requestedFields.join("|");
}

function buildOrderByCacheKey(sorting: QueryRequest["sorting"]) {
  return sorting.map((rule) => `${rule.key}:${rule.dir}`).join("|");
}

function buildRequestCacheKey(
  request: Pick<QueryRequest, "filters" | "search" | "sorting" | "pagination">,
) {
  return JSON.stringify(request);
}

function stripFacetKeyFromNode(
  node: QueryFilterNode,
  facetKey: string,
): QueryFilterNode | undefined {
  if (node.type === "condition") {
    return node.key === facetKey ? undefined : node;
  }

  const children = node.children
    .map((child) => stripFacetKeyFromNode(child, facetKey))
    .filter((child): child is QueryFilterNode => child !== undefined);

  return {
    ...node,
    children,
  };
}

function applyFacetMode(request: QueryRequest, facet: QueryFacetRequest): QueryRequest {
  if (facet.mode !== "exclude-self") return request;

  const normalizedFilters = normalizeFilters(request.filters);
  const strippedFilters = stripFacetKeyFromNode(normalizedFilters, facet.key);

  return {
    ...request,
    filters:
      strippedFilters && strippedFilters.type === "group"
        ? strippedFilters.children
        : strippedFilters
          ? [strippedFilters]
          : [],
  };
}

function buildFacetValuePredicate(column: any, search: string | undefined) {
  const normalized = normalizeString(search);
  if (normalized.length === 0) return undefined;
  return like(sql`lower(cast(${column} as text))`, `%${normalized}%`);
}

function dedupeIds<TId>(ids: TId[]): TId[] {
  if (ids.length <= 1) return ids;

  const seen = new Set<TId>();
  const deduped: TId[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }

  return deduped;
}

function joinRelationPath(
  query: any,
  schema: QueryEngineConfig["schema"],
  relationPath: FieldRegistryRelationStep[],
) {
  for (const step of relationPath) {
    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns as any[], step.targetColumns as any[]),
    );
  }

  return query;
}

function joinRelationSteps(
  query: any,
  schema: QueryEngineConfig["schema"],
  relationSteps: FieldRegistryRelationStep[],
) {
  for (const step of relationSteps) {
    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns as any[], step.targetColumns as any[]),
    );
  }

  return query;
}

function buildExistsCondition(
  db: QueryEngineConfig["db"],
  schema: QueryEngineConfig["schema"],
  entry: FieldRegistryEntry,
  condition: QueryFilterCondition,
  scalarBuilder: (column: any, condition: QueryFilterCondition) => SQL,
) {
  if (!entry.isManyPath) return scalarBuilder(entry.column, condition);

  const manyStep = entry.relationPath[entry.firstManyIndex];
  let query: any = (db as any)
    .select({ one: sql<number>`1` })
    .from((schema as any)[manyStep.targetTableName]);

  const correlationCondition = eqColumns(
    manyStep.sourceColumns as any[],
    manyStep.targetColumns as any[],
  );

  for (let index = entry.firstManyIndex + 1; index < entry.relationPath.length; index++) {
    const step = entry.relationPath[index];
    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns as any[], step.targetColumns as any[]),
    );
  }

  query = query.where(and(correlationCondition, scalarBuilder(entry.column, condition)));
  return exists(query);
}

export function buildFieldRegistry<
  TDb extends { query: Record<string, { findMany: (args?: any) => Promise<any[]> }> },
  TSchema extends Record<string, { _: { columns: Record<string, unknown> } }>,
  TRelations extends Record<string, { relations?: Record<string, any> }>,
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends QueryRelationsConfig<TRelations, TRoot> | undefined,
>(
  config: QueryEngineConfig<TDb, TSchema, TRelations>,
  root: TRoot,
  withClause: TWith,
  options: {
    hidden?: readonly string[];
    nonFilterable?: readonly string[];
    nonSortable?: readonly string[];
  },
) {
  const hidden = new Set<string>((options.hidden ?? []) as readonly string[]);
  const nonFilterable = new Set<string>((options.nonFilterable ?? []) as readonly string[]);
  const nonSortable = new Set<string>((options.nonSortable ?? []) as readonly string[]);
  const registry = new Map<string, FieldRegistryEntry>();

  function registerColumns(
    prefix: string[],
    tableName: string,
    source: "root" | "relation",
    relationPath: FieldRegistryRelationStep[],
  ) {
    const columns = getColumns((config.schema as any)[tableName]);
    for (const columnName of Object.keys(columns)) {
      const path = [...prefix, columnName].join(".");
      if (hidden.has(path)) continue;

      const firstManyIndex = relationPath.findIndex((step) => step.relationType === "many");
      const outerJoinSteps = relationPath.slice(
        0,
        firstManyIndex === -1 ? relationPath.length : firstManyIndex,
      );

      registry.set(path, {
        path,
        source,
        column: (columns as Record<string, unknown>)[columnName],
        tableName,
        relationPath,
        firstManyIndex,
        outerJoinSteps,
        isManyPath: firstManyIndex !== -1,
        sortable: firstManyIndex === -1,
      });
    }
  }

  function walkRelations(
    prefix: string[],
    currentRoot: string,
    currentWith: Record<string, unknown> | undefined,
    relationPath: FieldRegistryRelationStep[],
  ) {
    if (!currentWith) return;

    const currentRelations = (
      config.relations as Record<string, { relations?: Record<string, any> }>
    )[currentRoot]?.relations;
    if (!currentRelations) return;

    for (const [relationName, relationConfig] of Object.entries(currentWith)) {
      const relation = currentRelations[relationName];
      if (!relation) continue;

      const targetRoot = relation.targetTableName as string;
      const relationPrefix = [...prefix, relationName];
      const nextRelationPath = [
        ...relationPath,
        {
          path: relationPrefix.join("."),
          relationName,
          relationType: relation.relationType,
          sourceTableName: currentRoot,
          targetTableName: targetRoot,
          sourceColumns: relation.sourceColumns,
          targetColumns: relation.targetColumns,
        } satisfies FieldRegistryRelationStep,
      ];

      registerColumns(relationPrefix, targetRoot, "relation", nextRelationPath);

      const nestedWith =
        relationConfig && typeof relationConfig === "object" && "with" in relationConfig
          ? ((relationConfig as { with?: Record<string, unknown> }).with ?? undefined)
          : undefined;

      walkRelations(relationPrefix, targetRoot, nestedWith, nextRelationPath);
    }
  }

  registerColumns([], root, "root", []);
  walkRelations([], root, withClause as Record<string, unknown> | undefined, []);

  for (const key of nonFilterable) {
    registry.delete(key);
  }

  for (const key of nonSortable) {
    const entry = registry.get(key);
    if (!entry) continue;
    registry.set(key, {
      ...entry,
      sortable: false,
    });
  }

  return registry;
}

export function createQueryResourceUtils<
  TDb extends QueryEngineConfig["db"],
  TSchema extends QueryEngineConfig["schema"],
  TRelations extends QueryEngineConfig["relations"],
  TRoot extends QueryRootKey<TDb, TSchema>,
  TWith extends QueryWith<TDb, TSchema, TRoot> | undefined,
  TContext extends GenericObject,
  TRow extends GenericObject,
>(
  config: QueryEngineConfig<TDb, TSchema, TRelations>,
  resource: QueryResource<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>,
): QueryResourceUtils<TRow> {
  const cached = utilsCache.get(resource);
  if (cached) return cached;

  const rootTable = (config.schema as any)[resource.key];
  const joinPlanCache = new Map<string, FieldRegistryRelationStep[]>();
  const orderByCache = new Map<
    string,
    Array<SQL | import("drizzle-orm/pg-core").PgColumn | SQL.Aliased<unknown>>
  >();

  function resolveField(path: string) {
    return resource.fields.get(path);
  }

  function buildScalarCondition(column: any, condition: QueryFilterCondition): SQL {
    const text = isTextColumn(column);
    switch (condition.operator) {
      case "contains":
        return text
          ? like(sql`lower(${column})`, `%${normalizeString(condition.value)}%`)
          : like(sql`lower(cast(${column} as text))`, `%${normalizeString(condition.value)}%`);
      case "is": {
        const scalar = Array.isArray(condition.value) ? condition.value[0] : condition.value;
        if (typeof scalar === "boolean")
          return sql`${column} = ${scalar ? sql.raw("true") : sql.raw("false")}`;
        return typeof scalar === "string"
          ? text
            ? eq(sql`lower(${column})`, normalizeString(scalar))
            : eq(column, scalar as any)
          : eq(column, scalar as any);
      }
      case "isAnyOf":
        return Array.isArray(condition.value)
          ? (or(
              ...condition.value.map((value) =>
                typeof value === "boolean"
                  ? sql`${column} = ${value ? sql.raw("true") : sql.raw("false")}`
                  : typeof value === "string"
                    ? text
                      ? eq(sql`lower(${column})`, normalizeString(value))
                      : eq(column, value as any)
                    : eq(column, value as any),
              ),
            ) ?? sql`false`)
          : typeof condition.value === "boolean"
            ? sql`${column} = ${condition.value ? sql.raw("true") : sql.raw("false")}`
            : typeof condition.value === "string"
              ? text
                ? eq(sql`lower(${column})`, normalizeString(condition.value))
                : eq(column, condition.value as any)
              : eq(column, condition.value as any);
      case "isNot": {
        const scalar = Array.isArray(condition.value) ? condition.value[0] : condition.value;
        if (typeof scalar === "boolean")
          return sql`${column} != ${scalar ? sql.raw("true") : sql.raw("false")}`;
        return typeof scalar === "string"
          ? text
            ? not(eq(sql`lower(${column})`, normalizeString(scalar)))
            : not(eq(column, scalar as any))
          : not(eq(column, scalar as any));
      }
      case "gt":
      case "after":
        return sql`${column} > ${condition.value as any}`;
      case "gte":
        return sql`${column} >= ${condition.value as any}`;
      case "lt":
      case "before":
        return sql`${column} < ${condition.value as any}`;
      case "lte":
        return sql`${column} <= ${condition.value as any}`;
      case "between": {
        if (
          !condition.value ||
          typeof condition.value !== "object" ||
          Array.isArray(condition.value)
        ) {
          return sql`false`;
        }

        const from = (condition.value as Record<string, unknown>).from;
        const to = (condition.value as Record<string, unknown>).to;
        if (from !== undefined && to !== undefined)
          return sql`${column} between ${from as any} and ${to as any}`;
        if (from !== undefined) return sql`${column} >= ${from as any}`;
        if (to !== undefined) return sql`${column} <= ${to as any}`;
        return sql`true`;
      }
      default:
        return sql`true`;
    }
  }

  function compileCondition(condition: QueryFilterCondition): SQL {
    const entry = resolveField(condition.key);
    if (!entry) return sql`true`;
    return buildExistsCondition(config.db, config.schema, entry, condition, buildScalarCondition);
  }

  function compileFilterNode(node: QueryFilterNode): SQL {
    if (node.type === "condition") return compileCondition(node);
    if (node.children.length === 0) return sql`true`;

    const children = node.children.map(compileFilterNode);
    return node.combinator === "and"
      ? (and(...children) ?? sql`true`)
      : (or(...children) ?? sql`false`);
  }

  function compileSearch(search: QueryRequest["search"]) {
    if (search.value.length === 0) return undefined;

    const predicates = search.fields.map((field) =>
      compileCondition({
        type: "condition",
        key: field,
        operator: "contains",
        value: search.value,
      }),
    );

    return predicates.length > 0 ? (or(...predicates) ?? undefined) : undefined;
  }

  function compileOrderBy(
    sorting: QueryRequest["sorting"],
  ): Array<SQL | import("drizzle-orm/pg-core").PgColumn | SQL.Aliased<unknown>> {
    const cacheKey = buildOrderByCacheKey(sorting);
    const cachedOrderBy = orderByCache.get(cacheKey);
    if (cachedOrderBy) return cachedOrderBy;

    const compiled = sorting.flatMap((rule) => {
      const entry = resolveField(rule.key);
      if (!entry || !entry.sortable) return [];
      const direction = rule.dir === "desc" ? desc : asc;
      return [direction(entry.column as any)];
    });

    orderByCache.set(cacheKey, compiled);
    return compiled;
  }

  function buildWhereClause(request: QueryRequest) {
    const searchPredicate = compileSearch(request.search);
    const filterPredicate = compileFilterNode(normalizeFilters(request.filters));
    return and(searchPredicate, filterPredicate);
  }

  function applyOuterJoins(query: any, request: QueryRequest) {
    const cacheKey = getJoinPlanCacheKey(request);
    const joins = joinPlanCache.get(cacheKey) ?? buildOuterJoins(resource, request);
    joinPlanCache.set(cacheKey, joins);

    for (const step of joins) {
      query = query.innerJoin(
        (config.schema as any)[step.targetTableName],
        eqColumns(step.sourceColumns as any[], step.targetColumns as any[]),
      );
    }
    return query;
  }

  function buildMatchingIdsSelect(request: QueryRequest) {
    const whereClause = buildWhereClause(request);

    let matchingIdsQuery: any = (config.db as any)
      .selectDistinct({
        id: rootTable.id,
      })
      .from(rootTable);

    matchingIdsQuery = applyOuterJoins(matchingIdsQuery, request).where(whereClause);
    return matchingIdsQuery;
  }

  async function executeIdsQuery({ request }: { request: QueryRequest }) {
    const pageIndex = request.pagination.pageIndex <= 0 ? 1 : request.pagination.pageIndex;
    const pageSize = request.pagination.pageSize <= 0 ? 25 : request.pagination.pageSize;
    const offset = (pageIndex - 1) * pageSize;
    const orderBy = compileOrderBy(request.sorting);
    const matchingIds = (config.db as any)
      .$with("matching_ids")
      .as(buildMatchingIdsSelect(request));

    const countQuery: any = (config.db as any)
      .with(matchingIds)
      .select({
        rowCount: sql<number>`count(*)`,
      })
      .from(matchingIds);

    const [{ rowCount }] = await countQuery;
    const normalizedRowCount = Number(rowCount ?? 0);

    if (normalizedRowCount === 0) {
      return { ids: [], rowCount: 0 };
    }

    let idsQuery: any = (config.db as any)
      .with(matchingIds)
      .select({ id: matchingIds.id })
      .from(matchingIds)
      .innerJoin(rootTable, eq(rootTable.id, matchingIds.id));

    idsQuery = applyOuterJoins(idsQuery, request)
      .orderBy(...(orderBy.length > 0 ? orderBy : [asc(rootTable.id)]))
      .limit(pageSize)
      .offset(offset);

    const pageIds = await idsQuery;
    if (pageIds.length === 0) {
      return { ids: [], rowCount: normalizedRowCount };
    }

    return {
      ids: pageIds.map((row: any) => row.id),
      rowCount: normalizedRowCount,
    };
  }

  async function executeRowsQuery({ ids }: { ids: unknown[]; request?: QueryRequest }) {
    const orderedIds = dedupeIds(ids);
    if (orderedIds.length === 0) return [];

    const rows = await (config.db.query as any)[resource.key].findMany({
      where: {
        id: {
          in: orderedIds,
        },
      },
      with: resource.relations,
    });

    const orderIndex = new Map(orderedIds.map((id: unknown, index: number) => [id, index]));
    rows.sort(
      (left: any, right: any) =>
        Number(orderIndex.get(left.id) ?? 0) - Number(orderIndex.get(right.id) ?? 0),
    );

    return rows;
  }

  async function executeHydratedPage({ request }: { request: QueryRequest }) {
    const { ids, rowCount } = await executeIdsQuery({ request });
    if (ids.length === 0) {
      return { rows: [], rowCount };
    }

    const rows = await executeRowsQuery({ ids, request });
    return { rows, rowCount };
  }

  async function resolveFacets({
    request,
    facets,
  }: {
    request: QueryRequest;
    facets: QueryFacetRequest[];
  }): Promise<QueryFacetsResponse> {
    const groupedFacets = new Map<
      string,
      Array<{ facet: QueryFacetRequest; scopedRequest: QueryRequest }>
    >();
    for (const facet of facets) {
      const scopedRequest = applyFacetMode(request, {
        ...facet,
        mode: facet.mode ?? "exclude-self",
      });
      const cacheKey = buildRequestCacheKey({
        filters: scopedRequest.filters,
        search: scopedRequest.search,
        sorting: scopedRequest.sorting,
        pagination: scopedRequest.pagination,
      });
      const group = groupedFacets.get(cacheKey) ?? [];
      group.push({ facet, scopedRequest });
      groupedFacets.set(cacheKey, group);
    }

    const facetResults = await Promise.all(
      Array.from(groupedFacets.values()).map(async (group, groupIndex) => {
        const matchingIds = (config.db as any)
          .$with(`facet_matching_ids_${groupIndex}`)
          .as(buildMatchingIdsSelect(group[0].scopedRequest));

        return Promise.all(
          group.map(async ({ facet }) => {
            const entry = resolveField(facet.key);
            const limit = facet.limit && facet.limit > 0 ? facet.limit : undefined;
            const cursor =
              facet.cursor === null || facet.cursor === undefined
                ? undefined
                : Number(facet.cursor);
            const offset =
              cursor !== undefined && Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;

            if (!entry) {
              return {
                key: facet.key,
                options: [],
                nextCursor: null,
                total: 0,
              };
            }

            const valuePredicate = buildFacetValuePredicate(entry.column, facet.search);
            const facetBuckets = (config.db as any)
              .$with(`facet_buckets_${groupIndex}_${facet.key.replaceAll(".", "_")}`)
              .as(() => {
                let bucketsQuery: any;

                if (entry.isManyPath && entry.firstManyIndex === 0) {
                  const manyStep = entry.relationPath[0];
                  bucketsQuery = (config.db as any)
                    .with(matchingIds)
                    .select({
                      value: entry.column,
                      count: sql<number>`count(distinct ${matchingIds.id})`.as("count"),
                    })
                    .from(matchingIds)
                    .innerJoin(
                      (config.schema as any)[manyStep.targetTableName],
                      eqColumns([matchingIds.id], manyStep.targetColumns as any[]),
                    );

                  bucketsQuery = joinRelationSteps(
                    bucketsQuery,
                    config.schema,
                    entry.relationPath.slice(1),
                  );
                } else {
                  bucketsQuery = (config.db as any)
                    .with(matchingIds)
                    .select({
                      value: entry.column,
                      count: sql<number>`count(distinct ${matchingIds.id})`.as("count"),
                    })
                    .from(rootTable)
                    .innerJoin(matchingIds, eq(matchingIds.id, rootTable.id));

                  bucketsQuery = joinRelationPath(bucketsQuery, config.schema, entry.relationPath);
                }

                if (valuePredicate) {
                  bucketsQuery = bucketsQuery.where(valuePredicate);
                }

                return bucketsQuery.groupBy(entry.column as any);
              });

            let facetQuery: any = (config.db as any)
              .with(matchingIds, facetBuckets)
              .select({
                value: facetBuckets.value,
                count: facetBuckets.count,
                total: sql<number>`count(*) over ()`.as("total"),
              })
              .from(facetBuckets)
              .orderBy(desc(facetBuckets.count), asc(facetBuckets.value));

            if (limit !== undefined) {
              facetQuery = facetQuery.limit(limit);
              if (offset > 0) {
                facetQuery = facetQuery.offset(offset);
              }
            }

            const rows = await facetQuery;
            const total = rows.length > 0 ? Number(rows[0].total ?? 0) : 0;

            return {
              key: facet.key,
              options: rows
                .filter((row: any) => row.value !== null && row.value !== undefined)
                .map((row: any) => ({
                  value: row.value,
                  count: Number(row.count ?? 0),
                })),
              nextCursor:
                limit !== undefined
                  ? offset + limit < total
                    ? String(offset + limit)
                    : null
                  : undefined,
              total: Number(total),
            };
          }),
        );
      }),
    );

    return {
      facets: facetResults.flat(),
    };
  }

  const utils = {
    normalizeString,
    compileCondition,
    compileFilterNode,
    normalizeFilters,
    compileSearch,
    compileOrderBy,
    buildWhereClause,
    executeIdsQuery,
    executeRowsQuery,
    executeHydratedPage,
    resolveFacets,
    resolveField,
  } satisfies QueryResourceUtils<TRow>;

  utilsCache.set(resource, utils);
  return utils;
}

export { mergeScopeFilters };
