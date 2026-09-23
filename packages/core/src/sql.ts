import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
  isSQLWrapper,
  is,
  inArray,
} from "drizzle-orm";
import { getColumns } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgColumn, PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { SQL, SQLWrapper } from "drizzle-orm";

import type {
  FieldRegistryEntry,
  FieldRegistryRelationStep,
  GenericObject,
  QueryEngineConfig,
  QueryEngineDb,
  QueryEngineSchema,
  QueryFacetRequest,
  QueryFacetsResponse,
  QueryFilterCondition,
  QueryFilterGroup,
  QueryFilterInput,
  QueryFilterNode,
  QueryRelationsConfig,
  QueryRelationsSubset,
  QueryRequest,
  QueryPageInfo,
  QueryResource,
  QueryResourceUtils,
  QueryRootKey,
  QueryWith,
} from "./types.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { estimatePostgresQuery, probePostgresSearch, scanPostgresCursor } from "./postgres.js";

const utilsCache = new WeakMap<object, unknown>();
const scopeFilterNodes = new WeakSet<QueryFilterNode>();
const uniqueKeysCache = new WeakMap<PgTable, string[][]>();
const postgresDialect = new PgDialect();

function getUniqueKeys(table: unknown): string[][] {
  if (!is(table, PgTable)) return [];
  const cached = uniqueKeysCache.get(table);
  if (cached) return cached;
  const metadata = getTableConfig(table);
  const keys = [
    ...metadata.columns
      .filter((column) => column.primary || column.isUnique)
      .map((column) => [column.name]),
    ...metadata.primaryKeys.map((key) => key.columns.map((column) => column.name)),
    ...metadata.uniqueConstraints.map((key) => key.columns.map((column) => column.name)),
    ...metadata.indexes.flatMap(({ config: index }) =>
      index.unique &&
      !index.where &&
      !index.only &&
      index.columns.every((column) => is(column, IndexedColumn))
        ? [index.columns.map((column) => (column as IndexedColumn).name)]
        : [],
    ),
  ];
  uniqueKeysCache.set(table, keys);
  return keys;
}

function columnsAreUnique(table: unknown, columns: readonly unknown[]) {
  const names = new Set(
    columns.filter((column) => is(column, PgColumn)).map((column) => column.name),
  );
  return getUniqueKeys(table).some((key) => key.length > 0 && key.every((name) => names.has(name)));
}

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
  const scope = { ...normalizedScope };
  scopeFilterNodes.add(scope);
  return [scope, ...requestChildren];
}

function resolveRelationColumn(value: unknown): SQLWrapper {
  if (isSQLWrapper(value)) return value;

  if (value === null || typeof value !== "object" || !("_" in value)) {
    throw new TypeError("Drizzle relation metadata did not resolve to a SQL wrapper");
  }

  const metadata = value._;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("column" in metadata) ||
    !isSQLWrapper(metadata.column)
  ) {
    throw new TypeError("Drizzle relation metadata did not resolve to a SQL wrapper");
  }

  return metadata.column;
}

function resolveRelationColumns(columns: readonly unknown[]) {
  return columns.map(resolveRelationColumn);
}

function eqColumns(sourceColumns: readonly unknown[], targetColumns: readonly unknown[]) {
  const source = resolveRelationColumns(sourceColumns);
  const target = resolveRelationColumns(targetColumns);
  const predicates = source.map((sourceColumn, index) => eq(sourceColumn, target[index]!));
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
  requestedFields.push(...request.sorting.map((rule) => rule.key));

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

function stripFacetKeyFromNode(
  node: QueryFilterNode,
  facetKey: string,
): QueryFilterNode | undefined {
  if (scopeFilterNodes.has(node)) return node;
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

function joinRelationSteps(
  query: any,
  schema: QueryEngineConfig["schema"],
  relationSteps: FieldRegistryRelationStep[],
) {
  for (const step of relationSteps) {
    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns, step.targetColumns),
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
  firstRelationIndex = entry.firstManyIndex,
) {
  if (firstRelationIndex < 0) return scalarBuilder(entry.column, condition);

  const firstStep = entry.relationPath[firstRelationIndex];
  if (!firstStep) {
    throw new Error(`Invalid relation path for field "${condition.key}"`);
  }

  let query: any = (db as any)
    .select({ one: sql<number>`1` })
    .from((schema as any)[firstStep.targetTableName]);

  const correlationCondition = eqColumns(firstStep.sourceColumns, firstStep.targetColumns);

  for (let index = firstRelationIndex + 1; index < entry.relationPath.length; index++) {
    const step = entry.relationPath[index];
    if (!step) {
      throw new Error(`Invalid relation step while resolving field "${condition.key}"`);
    }

    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns, step.targetColumns),
    );
  }

  query = query.where(and(correlationCondition, scalarBuilder(entry.column, condition)));
  return exists(query);
}

export function buildFieldRegistry<
  TDb extends { query: Record<string, { findMany: (args?: any) => Promise<any[]> }> },
  TSchema extends QueryEngineSchema,
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
          sourceColumns: resolveRelationColumns(relation.sourceColumns),
          targetColumns: resolveRelationColumns(relation.targetColumns),
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
  {
    resource,
    db: database = config.db,
  }: {
    resource: QueryResource<TDb, TSchema, TRelations, TRoot, TWith, TContext, TRow>;
    db?: QueryEngineDb;
  },
): QueryResourceUtils<TRow, TWith> {
  const cached = database === config.db ? utilsCache.get(resource) : undefined;
  if (cached) return cached as QueryResourceUtils<TRow, TWith>;

  const rootTable = (config.schema as any)[resource.key];
  const uniqueRootId = columnsAreUnique(rootTable, [rootTable.id]) && rootTable.id.notNull;
  const indexedSearchColumns = new Set<PgColumn>();
  const searchPlans = new WeakMap<QueryRequest, Promise<void>>();
  const indexedSearchRequests = new WeakSet<QueryRequest>();

  function resolveField(path: string) {
    return resource.fields.get(path);
  }

  function buildScalarCondition(column: any, condition: QueryFilterCondition): SQL {
    const text = isTextColumn(column);
    const caseSensitiveFields: ReadonlySet<string> = resource.queryConfig.filters.caseSensitive;
    const caseSensitive = caseSensitiveFields.has(condition.key);
    switch (condition.operator) {
      case "contains":
        return text
          ? like(sql`lower(${column})`, `%${normalizeString(condition.value)}%`)
          : like(sql`lower(cast(${column} as text))`, `%${normalizeString(condition.value)}%`);
      case "is": {
        const scalar = Array.isArray(condition.value) ? condition.value[0] : condition.value;
        if (typeof scalar === "boolean")
          return sql`${column} = ${scalar ? sql.raw("true") : sql.raw("false")}`;
        if (scalar === null) return isNull(column as any);
        return typeof scalar === "string"
          ? text && !caseSensitive
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
                    ? text && !caseSensitive
                      ? eq(sql`lower(${column})`, normalizeString(value))
                      : eq(column, value as any)
                    : eq(column, value as any),
              ),
            ) ?? sql`false`)
          : typeof condition.value === "boolean"
            ? sql`${column} = ${condition.value ? sql.raw("true") : sql.raw("false")}`
            : typeof condition.value === "string"
              ? text && !caseSensitive
                ? eq(sql`lower(${column})`, normalizeString(condition.value))
                : eq(column, condition.value as any)
              : eq(column, condition.value as any);
      case "isNot": {
        const scalar = Array.isArray(condition.value) ? condition.value[0] : condition.value;
        if (scalar === null) return isNotNull(column as any);
        if (typeof scalar === "boolean")
          return sql`${column} != ${scalar ? sql.raw("true") : sql.raw("false")}`;
        const comparison =
          typeof scalar === "string"
            ? text && !caseSensitive
              ? eq(sql`lower(${column})`, normalizeString(scalar))
              : eq(column, scalar as any)
            : eq(column, scalar as any);
        return sql`not (${comparison})`;
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
    return buildExistsCondition(database, config.schema, entry, condition, buildScalarCondition);
  }

  function compileFilterNode(node: QueryFilterNode): SQL {
    if (node.type === "condition") return compileCondition(node);
    if (node.children.length === 0) return sql`true`;

    const children = node.children.map(compileFilterNode);
    return node.combinator === "and"
      ? (and(...children) ?? sql`true`)
      : (or(...children) ?? sql`false`);
  }

  async function prepareSearch(request: QueryRequest) {
    if (!/[\p{L}\p{N}]{3}/u.test(request.search.value)) return;
    const prepared = searchPlans.get(request);
    if (prepared) return prepared;
    const pending = planSearch(request);
    searchPlans.set(request, pending);
    return pending;
  }

  async function planSearch(request: QueryRequest) {
    const { search } = request;
    const entries = search.fields.flatMap((field) => {
      const entry = resolveField(field);
      return entry && !entry.isManyPath && is(entry.column, PgColumn) && isTextColumn(entry.column)
        ? [entry]
        : [];
    });
    if (new Set(search.fields.map((field) => resolveField(field)?.tableName)).size < 2) return;
    const tables = new Set(
      entries.map((entry) => config.schema[entry.tableName]).filter((table) => is(table, PgTable)),
    );
    await Promise.all(
      [...tables].map(async (table) => {
        const indexed = await probePostgresSearch(database, table);
        for (const entry of entries) {
          const column = entry.column as PgColumn;
          if (config.schema[entry.tableName] === table && indexed.has(column.name))
            indexedSearchColumns.add(column);
        }
      }),
    );
    const indexed = compileIndexedSearch(request);
    if (!indexed) return;
    const filter = compileFilterNode(normalizeFilters(request.filters));
    const queries = [compileSearch(search), indexed].map((predicate) => {
      const where = and(filter, predicate);
      const matching = applyOuterJoins(
        (database as any).select({ id: rootTable.id }).from(rootTable),
        request,
      ).where(where);
      const page = matching
        .orderBy(...compileOrderBy(request.sorting))
        .limit(request.pagination.pageSize)
        .offset(
          request.pagination.mode === "offset"
            ? (request.pagination.pageIndex - 1) * request.pagination.pageSize
            : 0,
        );
      if (request.pagination.count === "none") return page.getSQL();
      const count = applyOuterJoins(
        (database as any).select({ count: sql`count(*)` }).from(rootTable),
        request,
      ).where(where);
      return sql`select (${count}) as total, array(select id from (${page}) as page) as ids`;
    });
    const [ordinaryCost, indexedCost] = await Promise.all(
      queries.map((query) => estimatePostgresQuery(database, query)),
    );
    if (ordinaryCost !== undefined && indexedCost !== undefined && indexedCost < ordinaryCost) {
      indexedSearchRequests.add(request);
    }
  }

  function compileSearch(search: QueryRequest["search"], request?: QueryRequest) {
    if (search.value.length === 0) return undefined;
    if (request && indexedSearchRequests.has(request)) return compileIndexedSearch(request);
    const predicates = search.fields.map((field) => compileSearchField(field, search.value));
    return predicates.length > 0 ? (or(...predicates) ?? undefined) : undefined;
  }

  function compileSearchField(field: string, value: string) {
    const entry = resolveField(field);
    if (!entry) return sql`true`;
    return buildExistsCondition(
      database,
      config.schema,
      entry,
      { type: "condition", key: field, operator: "contains", value },
      buildScalarCondition,
      entry.relationPath.length > 0 ? 0 : -1,
    );
  }

  function compileIndexedSearch(request: QueryRequest) {
    const { search } = request;
    const entries = search.fields.map(resolveField);
    const indexed =
      uniqueRootId &&
      /[\p{L}\p{N}]{3}/u.test(search.value) &&
      new Set(entries.map((entry) => entry?.tableName)).size > 1 &&
      entries.some((entry) => entry?.tableName === resource.key) &&
      entries.every(
        (entry) =>
          entry &&
          !entry.isManyPath &&
          is(entry.column, PgColumn) &&
          indexedSearchColumns.has(entry.column) &&
          preservesRootCardinality(entry.outerJoinSteps),
      );
    if (!indexed) return undefined;
    const filter = compileFilterNode(normalizeFilters(request.filters));
    const branches = entries.map((entry) => {
      const joins = buildOuterJoins(resource, {
        ...request,
        sorting: [],
        search: { ...search, fields: [entry!.path] },
      });
      const query = joinRelationSteps(
        (database as any).select({ id: rootTable.id }).from(rootTable),
        config.schema,
        joins,
      ).where(and(filter, compileSearchField(entry!.path, search.value)));
      return sql`(${query})`;
    });
    return inArray(rootTable.id, sql`(${sql.join(branches, sql` union `)})`);
  }

  function compileOrderBy(
    sorting: QueryRequest["sorting"],
  ): Array<SQL | import("drizzle-orm/pg-core").PgColumn | SQL.Aliased<unknown>> {
    return sorting.flatMap((rule) => {
      const entry = resolveField(rule.key);
      if (!entry || !entry.sortable) return [];
      const direction = rule.dir === "desc" ? desc : asc;
      return [direction(entry.column as any)];
    });
  }

  function buildWhereClause(request: QueryRequest) {
    const searchPredicate = compileSearch(request.search, request);
    const filterPredicate = compileFilterNode(normalizeFilters(request.filters));
    return and(searchPredicate, filterPredicate);
  }

  function applyOuterJoins(query: any, request: QueryRequest) {
    const joins = buildOuterJoins(resource, request);

    return joinRelationSteps(query, config.schema, joins);
  }

  function buildAggregatePlan(request: QueryRequest, extra: FieldRegistryRelationStep[] = []) {
    const required = new Map(
      [...buildOuterJoins(resource, { ...request, sorting: [] }), ...extra].map((step) => [
        step.path,
        step,
      ]),
    );
    const membership = buildOuterJoins(resource, request).filter(
      (step) => !required.has(step.path),
    );
    const first = membership[0];
    const membershipPredicate = first
      ? exists(
          joinRelationSteps(
            (database as any)
              .select({ one: sql<number>`1` })
              .from(config.schema[first.targetTableName]),
            config.schema,
            membership.slice(1),
          ).where(eqColumns(first.sourceColumns, first.targetColumns)),
        )
      : undefined;
    return {
      joins: [...required.values()],
      where: and(buildWhereClause(request), membershipPredicate),
    };
  }

  function preservesRootCardinality(joins: FieldRegistryRelationStep[]) {
    return (
      uniqueRootId &&
      joins.every((step) =>
        columnsAreUnique(config.schema[step.targetTableName], step.targetColumns),
      )
    );
  }

  function buildMatchingIdsSelect(request: QueryRequest) {
    const whereClause = buildWhereClause(request);

    let matchingIdsQuery: any = (database as any)
      .selectDistinct({
        id: rootTable.id,
      })
      .from(rootTable);

    matchingIdsQuery = applyOuterJoins(matchingIdsQuery, request).where(whereClause);
    return matchingIdsQuery;
  }

  async function executeIdsQuery({
    request,
    rowCount: knownRowCount,
  }: {
    request: QueryRequest;
    rowCount?: number;
  }) {
    await prepareSearch(request);
    const pageSize = request.pagination.pageSize <= 0 ? 25 : request.pagination.pageSize;
    const orderBy = compileOrderBy(request.sorting);
    const direct = preservesRootCardinality(buildOuterJoins(resource, request));
    const whereClause = buildWhereClause(request);

    let rowCount: number | null = null;
    if (request.pagination.count === "exact") {
      if (knownRowCount !== undefined) {
        rowCount = knownRowCount;
      } else {
        const countPlan = buildAggregatePlan(request);
        const countQuery = preservesRootCardinality(countPlan.joins)
          ? joinRelationSteps(
              (database as any).select({ rowCount: sql<number>`count(*)` }).from(rootTable),
              config.schema,
              countPlan.joins,
            ).where(countPlan.where)
          : (database as any).select({ rowCount: sql<number>`count(*)` }).from(
              joinRelationSteps(
                (database as any).selectDistinct({ id: rootTable.id }).from(rootTable),
                config.schema,
                countPlan.joins,
              )
                .where(countPlan.where)
                .as("count_matching_ids"),
            );
        const [countResult] = await countQuery;
        rowCount = Number(countResult?.rowCount ?? 0);
      }

      if (rowCount === 0) {
        return {
          ids: [],
          pageInfo:
            request.pagination.mode === "cursor"
              ? {
                  mode: "cursor" as const,
                  pageSize,
                  nextCursor: null,
                  count: "exact" as const,
                  rowCount,
                }
              : {
                  mode: "offset" as const,
                  pageIndex: request.pagination.pageIndex,
                  pageSize,
                  hasNextPage: false,
                  count: "exact" as const,
                  rowCount,
                },
        };
      }
    }

    const cursorSelection = Object.fromEntries(
      request.sorting.map((rule, index) => [`__cursor_${index}`, resolveField(rule.key)?.column]),
    );

    let idsQuery: any;
    if (direct) {
      idsQuery = (database as any).select({ id: rootTable.id, ...cursorSelection }).from(rootTable);
    } else {
      const matchingIds = (database as any)
        .$with("matching_ids")
        .as(buildMatchingIdsSelect(request));
      idsQuery = (database as any)
        .with(matchingIds)
        .select({ id: matchingIds.id, ...cursorSelection })
        .from(matchingIds)
        .innerJoin(rootTable, eq(rootTable.id, matchingIds.id));
    }

    idsQuery = applyOuterJoins(idsQuery, request);

    let cursorPredicate: SQL | undefined;
    if (request.pagination.mode === "cursor" && request.pagination.cursor) {
      const cursorValues = decodeCursor(
        request.pagination.cursor,
        String(resource.key),
        request.sorting,
      );
      const branches = request.sorting.map((rule, index) => {
        const previousEqualities = request.sorting
          .slice(0, index)
          .map((previousRule, priorIndex) => {
            const column = resolveField(previousRule.key)?.column;
            const value = cursorValues[priorIndex];
            return value === null ? isNull(column as any) : eq(column as any, value as any);
          });
        const column = resolveField(rule.key)?.column;
        const value = cursorValues[index];
        const comparison =
          rule.dir === "asc"
            ? value === null
              ? sql`false`
              : or(gt(column as any, value as any), isNull(column as any))
            : value === null
              ? isNotNull(column as any)
              : lt(column as any, value as any);
        return and(...previousEqualities, comparison);
      });
      cursorPredicate = or(...branches) ?? sql`false`;
    }
    idsQuery = idsQuery.where(and(direct ? whereClause : undefined, cursorPredicate));

    const offset =
      request.pagination.mode === "offset"
        ? (Math.max(request.pagination.pageIndex, 1) - 1) * pageSize
        : 0;
    const needsLookahead =
      request.pagination.mode === "cursor" || request.pagination.count === "none";
    idsQuery = idsQuery
      .orderBy(...(orderBy.length > 0 ? orderBy : [asc(rootTable.id)]))
      .limit(pageSize + (needsLookahead ? 1 : 0))
      .offset(offset);

    const queriedRows = await idsQuery;
    const hasNextPage =
      request.pagination.count === "exact" && request.pagination.mode === "offset"
        ? offset + Math.min(queriedRows.length, pageSize) < (rowCount ?? 0)
        : queriedRows.length > pageSize;
    const pageRows = queriedRows.slice(0, pageSize);
    const countInfo =
      request.pagination.count === "exact"
        ? ({ count: "exact", rowCount: rowCount ?? 0 } as const)
        : ({ count: "none", rowCount: null } as const);
    let pageInfo: QueryPageInfo;

    if (request.pagination.mode === "cursor") {
      const lastRow = pageRows.at(-1);
      pageInfo = {
        mode: "cursor",
        pageSize,
        nextCursor:
          hasNextPage && lastRow
            ? encodeCursor(
                String(resource.key),
                request.sorting,
                request.sorting.map((_, index) => lastRow[`__cursor_${index}`]),
              )
            : null,
        ...countInfo,
      };
    } else {
      pageInfo = {
        mode: "offset",
        pageIndex: request.pagination.pageIndex,
        pageSize,
        hasNextPage,
        ...countInfo,
      };
    }

    return {
      ids: pageRows.map((row: any) => row.id),
      pageInfo,
    };
  }

  async function executeRowsQuery({
    ids,
    relations = resource.relations as QueryRelationsSubset<TWith> | undefined,
  }: {
    ids: unknown[];
    request?: QueryRequest;
    relations?: QueryRelationsSubset<TWith>;
  }) {
    const orderedIds = dedupeIds(ids);
    if (orderedIds.length === 0) return [];

    const rows = await (database.query as any)[resource.key].findMany({
      where: {
        id: {
          in: orderedIds,
        },
      },
      with: relations,
    });

    const orderIndex = new Map(orderedIds.map((id: unknown, index: number) => [id, index]));
    rows.sort(
      (left: any, right: any) =>
        Number(orderIndex.get(left.id) ?? 0) - Number(orderIndex.get(right.id) ?? 0),
    );

    return rows;
  }

  async function scanIds<TResult>(
    options: {
      request: QueryRequest;
      batchSize: number;
      count: "exact" | "none";
      signal?: AbortSignal;
    },
    consume: (batches: AsyncIterable<{ ids: unknown[]; totalRows?: number }>) => Promise<TResult>,
  ) {
    const { request } = options;
    await prepareSearch(request);
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1) {
      throw new Error("Scan batch size must be a positive safe integer");
    }
    const sortJoins = buildOuterJoins(resource, {
      ...request,
      filters: [],
      search: { value: "", fields: [] },
    });
    if (!preservesRootCardinality(sortJoins)) {
      throw new Error(
        "A PostgreSQL scan requires a unique root ID and unique sorting relation keys",
      );
    }
    const selection = {
      id: sql`${rootTable.id}`.as("resourceId"),
      ...(options.count === "exact" ? { totalRows: sql`count(*) over ()`.as("totalRows") } : {}),
    };
    const direct = preservesRootCardinality(buildOuterJoins(resource, request));
    const matching = (database as any)
      .$with("scan_matching_ids")
      .as(buildMatchingIdsSelect(request));
    const query = (
      direct
        ? applyOuterJoins((database as any).select(selection).from(rootTable), request).where(
            buildWhereClause(request),
          )
        : joinRelationSteps(
            (database as any)
              .with(matching)
              .select(selection)
              .from(matching)
              .innerJoin(rootTable, eq(rootTable.id, matching.id)),
            config.schema,
            sortJoins,
          )
    ).orderBy(...compileOrderBy(request.sorting));
    return scanPostgresCursor(
      {
        db: database,
        query: query.getSQL(),
        batchSize: options.batchSize,
        signal: options.signal,
      },
      async (batches) => {
        async function* decode() {
          for await (const rows of batches) {
            yield {
              ids: rows.map((row) => rootTable.id.mapFromDriverValue(row.resourceId)),
              ...(options.count === "exact" ? { totalRows: Number(rows[0]?.totalRows ?? 0) } : {}),
            };
          }
        }
        const decoded = decode();
        try {
          return await consume(decoded);
        } finally {
          await decoded.return();
        }
      },
    );
  }

  async function executeHydratedPage({
    request,
    relations,
  }: {
    request: QueryRequest;
    relations?: QueryRelationsSubset<TWith>;
  }) {
    const aggregates = request.facets?.length
      ? await resolveAggregates({
          request,
          facets: request.facets,
          includeCount: request.pagination.count === "exact",
        })
      : undefined;
    const { ids, pageInfo } = await executeIdsQuery({ request, rowCount: aggregates?.rowCount });
    const rows = ids.length === 0 ? [] : await executeRowsQuery({ ids, request, relations });
    return { rows, pageInfo, ...(aggregates ? { facets: aggregates.facets } : {}) };
  }

  async function resolveAggregates({
    request,
    facets,
    includeCount = false,
  }: {
    request: QueryRequest;
    facets: QueryFacetRequest[];
    includeCount?: boolean;
  }): Promise<QueryFacetsResponse & { rowCount?: number }> {
    await prepareSearch(request);
    let rowCount: number | undefined;
    const results: QueryFacetsResponse["facets"] = [];
    const plans = facets.flatMap((facet, index) => {
      const scopedRequest = applyFacetMode(request, {
        ...facet,
        mode: facet.mode ?? "exclude-self",
      });
      const entry = resolveField(facet.key);
      const limit = facet.limit && facet.limit > 0 ? facet.limit : undefined;
      const cursor =
        facet.cursor === null || facet.cursor === undefined ? undefined : Number(facet.cursor);
      const offset = cursor !== undefined && Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;

      if (!entry) {
        results[index] = {
          key: facet.key,
          options: [],
          nextCursor: null,
          total: 0,
        };
        return [];
      }

      const { joins: steps, where } = buildAggregatePlan(scopedRequest, entry.relationPath);
      const unique = preservesRootCardinality(steps);
      return [
        {
          facet,
          index,
          entry,
          limit,
          offset,
          joins: steps,
          unique,
          where,
          predicate:
            unique && is(entry.column, PgColumn) && !facet.search
              ? postgresDialect.sqlToQuery(where ?? sql`true`)
              : undefined,
        },
      ];
    });

    function formatResult(
      plan: (typeof plans)[number],
      rows: Array<{ value: unknown; count: unknown; total: unknown }>,
    ) {
      const total = Number(rows[0]?.total ?? 0);
      return {
        key: plan.facet.key,
        options: rows
          .filter((row) => row.value !== null && row.value !== undefined)
          .map((row) => ({ value: row.value, count: Number(row.count ?? 0) })),
        nextCursor:
          plan.limit === undefined
            ? undefined
            : plan.offset + plan.limit < total
              ? String(plan.offset + plan.limit)
              : null,
        total,
      };
    }

    async function resolveSingle(plan: (typeof plans)[number]) {
      const { entry, index, limit, offset, facet } = plan;
      let bucketsQuery: any = (database as any)
        .select({
          value: entry.column,
          count: (plan.unique
            ? sql<number>`count(*)`
            : sql<number>`count(distinct ${rootTable.id})`
          ).as("count"),
        })
        .from(rootTable);
      bucketsQuery = joinRelationSteps(bucketsQuery, config.schema, plan.joins)
        .where(and(plan.where, buildFacetValuePredicate(entry.column, facet.search)))
        .groupBy(entry.column as any);

      const facetBuckets = (database as any).$with(`facet_buckets_${index}`).as(bucketsQuery);
      let facetQuery: any = (database as any)
        .with(facetBuckets)
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

      results[index] = formatResult(plan, await facetQuery);
    }

    async function resolveGroupingSets(group: typeof plans, count = false) {
      const first = group[0]!;
      const columns = group.map(({ entry }) => entry.column as PgColumn);
      const selections = Object.fromEntries(
        columns.map((column, index) => [
          `value_${index}`,
          sql`${column}`.mapWith(column).as(`value_${index}`),
        ]),
      );
      const aggregate = joinRelationSteps(
        (database as any)
          .select({
            ...selections,
            mask: sql<number>`grouping(${sql.join(columns, sql`, `)})`.as("mask"),
            count: sql<number>`count(*)`.as("count"),
          })
          .from(rootTable),
        config.schema,
        first.joins,
      )
        .where(first.where)
        .groupBy(
          sql`grouping sets (${sql.join(
            [...columns.map((column) => sql`(${column})`), ...(count ? [sql`() `] : [])],
            sql`, `,
          )})`,
        );
      const buckets = (database as any).$with(`facet_groups_${first.index}`).as(aggregate);
      const values = Object.fromEntries(
        columns.map((_, index) => [`value_${index}`, buckets[`value_${index}`]]),
      );
      const ordering = sql.join(
        [desc(buckets.count), ...Object.values(values).map((value) => asc(value as SQL))],
        sql`, `,
      );
      const ranked = (database as any).$with(`facet_ranked_${first.index}`).as(
        (database as any)
          .select({
            ...values,
            mask: buckets.mask,
            count: buckets.count,
            total: sql<number>`count(*) over (partition by ${buckets.mask})`.as("total"),
            position:
              sql<number>`row_number() over (partition by ${buckets.mask} order by ${ordering})`.as(
                "position",
              ),
          })
          .from(buckets),
      );
      const masks = group.map(
        (_, index) => 2 ** group.length - 1 - 2 ** (group.length - index - 1),
      );
      const rows = await (database as any)
        .with(buckets, ranked)
        .select()
        .from(ranked)
        .where(
          or(
            count ? eq(ranked.mask, 2 ** group.length - 1) : undefined,
            ...group.map((plan, index) =>
              and(
                eq(ranked.mask, masks[index]),
                plan.limit === undefined
                  ? undefined
                  : and(
                      gt(ranked.position, plan.offset),
                      sql`${ranked.position} <= ${plan.offset + plan.limit}`,
                    ),
              ),
            ),
          ),
        )
        .orderBy(asc(ranked.mask), asc(ranked.position));
      if (count) {
        rowCount = Number(
          rows.find((row: any) => Number(row.mask) === 2 ** group.length - 1)?.count ?? 0,
        );
      }
      for (const [index, plan] of group.entries()) {
        results[plan.index] = formatResult(
          plan,
          rows
            .filter((row: any) => Number(row.mask) === masks[index])
            .map((row: any) => ({
              value: row[`value_${index}`],
              count: row.count,
              total: row.total,
            })),
        );
      }
    }

    const groups: Array<typeof plans> = [];
    for (const plan of plans) {
      const predicate = plan.predicate;
      const group =
        predicate &&
        groups.find((candidate) => {
          const first = candidate[0]!;
          return (
            candidate.length < 30 &&
            first.predicate &&
            first.predicate.sql === predicate.sql &&
            first.predicate.params.length === predicate.params.length &&
            first.predicate.params.every((value, index) =>
              Object.is(value, predicate.params[index]),
            ) &&
            first.joins.length === plan.joins.length &&
            first.joins.every((step) => plan.joins.some((other) => step.path === other.path)) &&
            candidate.every(({ entry }) => entry.column !== plan.entry.column)
          );
        });
      if (group) group.push(plan);
      else groups.push([plan]);
    }
    const countPlan = includeCount ? buildAggregatePlan(request) : undefined;
    const countPredicate = countPlan
      ? postgresDialect.sqlToQuery(countPlan.where ?? sql`true`)
      : undefined;
    const countGroup =
      countPredicate &&
      groups.find(
        ([first]) =>
          first?.predicate &&
          first.predicate.sql === countPredicate.sql &&
          first.predicate.params.length === countPredicate.params.length &&
          first.predicate.params.every((value, index) =>
            Object.is(value, countPredicate.params[index]),
          ) &&
          first.joins.length === countPlan!.joins.length &&
          first.joins.every((step) => countPlan!.joins.some((other) => step.path === other.path)),
      );
    await Promise.all(
      groups.map((group) =>
        group === countGroup
          ? resolveGroupingSets(group, true)
          : group.length === 1
            ? resolveSingle(group[0]!)
            : resolveGroupingSets(group),
      ),
    );

    return {
      facets: results,
      rowCount,
    };
  }

  async function resolveFacets(args: { request: QueryRequest; facets: QueryFacetRequest[] }) {
    const { facets } = await resolveAggregates(args);
    return { facets };
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
    scanIds,
    executeRowsQuery,
    executeHydratedPage,
    resolveFacets,
    resolveField,
  } satisfies QueryResourceUtils<TRow, TWith>;

  if (database === config.db) {
    utilsCache.set(resource, utils);
  }
  return utils;
}

export { mergeScopeFilters };
