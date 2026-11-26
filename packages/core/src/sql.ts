import type { Projection } from "./models.js";
import { resolveSummarySelection } from "./summary.js";
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
  SQL,
  isSQLWrapper,
  is,
  inArray,
} from "drizzle-orm";
import { getColumns, getTableName } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgColumn, PgDialect, PgTable } from "drizzle-orm/pg-core";
import type { SQLWrapper } from "drizzle-orm";

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
  QueryPageCount,
  QueryPageInfo,
  QueryResource,
  QueryResourceUtils,
  QueryRootKey,
  QueryWith,
} from "./types.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import {
  estimatePostgresQuery,
  isPostgresDatabase,
  probePostgresSearch,
  scanPostgresCursor,
  withStatementTimeout,
} from "./postgres.js";
import { isAboveCap, skippedFacets, timedOutFacet } from "./capped.js";

/** Indexed search matches below this many rows are cheaper to fetch than to walk the sort index. */
const searchProbeRows = 10_000;

function isExactCount(count: QueryPageCount) {
  return count.count === "exact" || (count.count === "capped" && count.exact);
}

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

function isArrayColumn(column: any): boolean {
  return column?.columnType === "PgArray" || (column?.dimensions ?? 0) > 0;
}

/** Null, `''` on text, or an empty array. */
function buildEmptyPredicate(column: any, text: boolean): SQL {
  if (isArrayColumn(column)) return sql`(${column} is null or cardinality(${column}) = 0)`;
  if (text) return sql`(${column} is null or ${column} = '')`;
  return sql`${column} is null`;
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

function isEmptinessOperator(operator: QueryFilterCondition["operator"]) {
  return operator === "isEmpty" || operator === "isNotEmpty";
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

/**
 * Relations (by first step) that a filter tests for emptiness. Rows with no related row are the
 * ones `isEmpty` looks for, so every condition on such a relation reads it through EXISTS:
 * a join would drop those rows before an `or` could keep them.
 */
function collectEmptinessRelations(
  resource: QueryResource<any, any, any, any, any, any, any>,
  node: QueryFilterNode,
  relations = new Set<string>(),
) {
  if (node.type === "group") {
    for (const child of node.children) collectEmptinessRelations(resource, child, relations);
    return relations;
  }
  const first = isEmptinessOperator(node.operator)
    ? resource.fields.get(node.key)?.relationPath[0]
    : undefined;
  if (first) relations.add(first.path);
  return relations;
}

function readsThroughExists(entry: FieldRegistryEntry, relations: ReadonlySet<string>) {
  const first = entry.relationPath[0];
  return first !== undefined && relations.has(first.path);
}

function buildOuterJoins(
  resource: QueryResource<any, any, any, any, any, any, any>,
  request: QueryRequest,
) {
  const filterFields: string[] = [];
  collectConditionFieldsFromFilters(request.filters, filterFields);
  const emptiness = new Set<string>();
  for (const node of request.filters) collectEmptinessRelations(resource, node, emptiness);
  const requestedFields = [
    ...filterFields.filter((path) => {
      const entry = resource.fields.get(path);
      return !entry || !readsThroughExists(entry, emptiness);
    }),
    ...request.sorting.map((rule) => rule.key),
  ];

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

/**
 * Joins a relation path. To-one steps are LEFT joins: sorting or selecting an optional linked
 * field never hides the rows that have no linked row. `inner` lists the steps that must match,
 * such as a facet's own path, whose buckets only count rows that hold the relation.
 */
function joinRelationSteps(
  query: any,
  schema: QueryEngineConfig["schema"],
  relationSteps: FieldRegistryRelationStep[],
  inner: ReadonlySet<string> = new Set(),
) {
  for (const step of relationSteps) {
    const join = step.relationType === "many" || inner.has(step.path) ? "innerJoin" : "leftJoin";
    query = query[join](
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
  predicate: SQL,
  firstRelationIndex = entry.firstManyIndex,
) {
  if (firstRelationIndex < 0) return predicate;

  const firstStep = entry.relationPath[firstRelationIndex];
  if (!firstStep) {
    throw new Error(`Invalid relation path for field "${entry.path}"`);
  }

  let query: any = (db as any)
    .select({ one: sql<number>`1` })
    .from((schema as any)[firstStep.targetTableName]);

  const correlationCondition = eqColumns(firstStep.sourceColumns, firstStep.targetColumns);

  for (let index = firstRelationIndex + 1; index < entry.relationPath.length; index++) {
    const step = entry.relationPath[index];
    if (!step) {
      throw new Error(`Invalid relation step while resolving field "${entry.path}"`);
    }

    query = query.innerJoin(
      (schema as any)[step.targetTableName],
      eqColumns(step.sourceColumns, step.targetColumns),
    );
  }

  query = query.where(and(correlationCondition, predicate));
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
    const virtuals = config.models?.[tableName]?.virtual ?? {};
    const fields = {
      ...columns,
      ...Object.fromEntries(
        Object.entries(virtuals).map(([key, field]) => [
          key,
          field.resolve((config.schema as any)[tableName], { db: config.db }),
        ]),
      ),
    };
    for (const columnName of Object.keys(fields)) {
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
        column: fields[columnName],
        virtual: virtuals[columnName],
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

  if (database !== config.db && config.models) {
    resource = {
      ...resource,
      fields: new Map(
        [...resource.fields].map(([key, entry]) => [
          key,
          entry.virtual
            ? {
                ...entry,
                column: entry.virtual.resolve((config.schema as any)[entry.tableName], {
                  db: database,
                }),
              }
            : entry,
        ]),
      ),
    };
  }
  const rootTable = (config.schema as any)[resource.key];
  const uniqueRootId = columnsAreUnique(rootTable, [rootTable.id]) && rootTable.id.notNull;
  const indexedSearchColumns = new Set<PgColumn>();
  const searchPlans = new WeakMap<QueryRequest, Promise<void>>();
  const indexedSearchRequests = new WeakSet<QueryRequest>();

  function resolveField(path: string) {
    return resource.fields.get(path);
  }

  function buildScalarCondition(column: any, condition: QueryFilterCondition): SQL {
    const text = isTextColumn(column) || resolveField(condition.key)?.virtual?.kind === "text";
    const caseSensitiveFields: ReadonlySet<string> = resource.queryConfig.filters.caseSensitive;
    const caseSensitive = caseSensitiveFields.has(condition.key);
    function matchValues(values: unknown[]): SQL {
      if (values.length > 1 && values.every((value) => typeof value === "string")) {
        return text && !caseSensitive
          ? inArray(sql`lower(${column})`, values.map(normalizeString))
          : inArray(column, values);
      }
      if (values.length > 1 && values.every((value) => typeof value === "number"))
        return inArray(column, values);
      return (
        or(
          ...values.map((value) => {
            if (typeof value === "boolean")
              return sql`${column} = ${value ? sql`true` : sql`false`}`;
            if (typeof value === "string" && text && !caseSensitive)
              return eq(sql`lower(${column})`, normalizeString(value));
            return eq(column, value);
          }),
        ) ?? sql`false`
      );
    }
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
        return matchValues(Array.isArray(condition.value) ? condition.value : [condition.value]);
      case "isNot": {
        // Every listed value is excluded; a listed null also excludes empty rows.
        const values = Array.isArray(condition.value) ? condition.value : [condition.value];
        const listed = values.filter((value) => value !== null && value !== undefined);
        const excludesNull = listed.length < values.length;
        if (!listed.length) return isNotNull(column as any);
        const matches = matchValues(listed);
        const excluded = sql`not (${matches})`;
        return excludesNull ? (and(isNotNull(column as any), excluded) as SQL) : excluded;
      }
      case "isEmpty":
        return buildEmptyPredicate(column, text);
      case "isNotEmpty":
        return sql`not (${buildEmptyPredicate(column, text)})`;
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

  function compileCondition(
    condition: QueryFilterCondition,
    emptiness: ReadonlySet<string> = collectEmptinessRelations(resource, condition),
  ): SQL {
    const entry = resolveField(condition.key);
    if (!entry) return sql`true`;
    if (condition.operator === "isNot" && entry.isManyPath) {
      // A to-many path is « has none of the values », not « has one row with another value ».
      const holdsValue = buildExistsCondition(
        database,
        config.schema,
        entry,
        buildScalarCondition(entry.column, { ...condition, operator: "isAnyOf" }),
        readsThroughExists(entry, emptiness) ? 0 : entry.firstManyIndex,
      );
      return sql`not ${holdsValue}`;
    }
    if (readsThroughExists(entry, emptiness)) {
      // The whole relation path, to-one or to-many, inside one EXISTS from the root.
      if (!isEmptinessOperator(condition.operator)) {
        return buildExistsCondition(
          database,
          config.schema,
          entry,
          buildScalarCondition(entry.column, condition),
          0,
        );
      }
      const holdsValue = buildExistsCondition(
        database,
        config.schema,
        entry,
        buildScalarCondition(entry.column, { ...condition, operator: "isNotEmpty" }),
        0,
      );
      return condition.operator === "isEmpty" ? sql`not ${holdsValue}` : holdsValue;
    }
    return buildExistsCondition(
      database,
      config.schema,
      entry,
      buildScalarCondition(entry.column, condition),
    );
  }

  function compileFilterNode(
    node: QueryFilterNode,
    emptiness: ReadonlySet<string> = collectEmptinessRelations(resource, node),
  ): SQL {
    if (node.type === "condition") return compileCondition(node, emptiness);
    if (node.children.length === 0) return sql`true`;

    const children = node.children.map((child) => compileFilterNode(child, emptiness));
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
    if (
      entries.length !== search.fields.length ||
      !entries.some((entry) => entry.source === "root") ||
      new Set(entries.map((entry) => entry.tableName)).size < 2
    )
      return;
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
    if (request.pagination.count !== "exact") {
      // Without an exact count PostgreSQL's estimate cannot tell a rare term from a common one
      // (it assumes millions of matches for both), so it walks the sort index for a rare term.
      // A bounded probe of the indexed matches tells them apart.
      if (await hasFewIndexedMatches(request)) indexedSearchRequests.add(request);
      return;
    }
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

  async function hasFewIndexedMatches(request: QueryRequest) {
    const branches = compileIndexedBranches(request, searchProbeRows + 1);
    if (!branches) return false;
    try {
      const [row] = await (database as any).execute(
        sql`select count(*) as matches from (${sql.join(branches, sql` union `)}) as probe`,
        "objects",
      );
      return Number(row?.matches ?? Number.POSITIVE_INFINITY) <= searchProbeRows;
    } catch {
      // a probe only picks between equivalent plans, so any failure keeps the ordinary one
      return false;
    }
  }

  function compileSearch(search: QueryRequest["search"], request?: QueryRequest) {
    if (search.value.length === 0) return undefined;
    if (request && indexedSearchRequests.has(request)) return compileIndexedSearch(request);
    const predicates: SQL[] = [];
    const related = new Map<string, { entry: FieldRegistryEntry; predicates: SQL[] }>();
    for (const field of search.fields) {
      const entry = resolveField(field);
      if (!entry) return sql`true`;
      const predicate = buildSearchCondition(entry, search.value);
      const path = entry.relationPath.at(-1)?.path;
      if (path === undefined) predicates.push(predicate);
      else {
        const group = related.get(path);
        if (group) group.predicates.push(predicate);
        else related.set(path, { entry, predicates: [predicate] });
      }
    }
    for (const { entry, predicates: conditions } of related.values()) {
      predicates.push(buildExistsCondition(database, config.schema, entry, or(...conditions)!, 0));
    }
    return or(...predicates);
  }

  function buildSearchCondition(entry: FieldRegistryEntry, value: string) {
    return buildScalarCondition(entry.column, {
      type: "condition",
      key: entry.path,
      operator: "contains",
      value,
    });
  }

  function compileIndexedSearch(request: QueryRequest) {
    const branches = compileIndexedBranches(request);
    return branches ? inArray(rootTable.id, sql`(${sql.join(branches, sql` union `)})`) : undefined;
  }

  function compileIndexedBranches(request: QueryRequest, limit?: number) {
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
      ).where(
        and(
          filter,
          buildExistsCondition(
            database,
            config.schema,
            entry!,
            buildSearchCondition(entry!, search.value),
            entry!.relationPath.length ? 0 : -1,
          ),
        ),
      );
      return sql`(${limit === undefined ? query : query.limit(limit)})`;
    });
    return branches;
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
    // Sort-only joins are LEFT joins: they never restrict which rows match, so the count skips them.
    return {
      joins: [...required.values()],
      where: buildWhereClause(request),
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

  let lookupKeys: Set<string> | undefined;
  // An AND condition on one unique key bounds the entire result, including tenant scope.
  // Case-folded text, NULL equality and to-many joins do not have that property.
  function fitsUniqueLookup(node: QueryFilterNode, pageSize: number): boolean {
    if (node.type === "group")
      return (
        node.combinator === "and" &&
        node.children.some((child) => fitsUniqueLookup(child, pageSize))
      );
    if (node.operator !== "is" && node.operator !== "isAnyOf") return false;
    const field = resolveField(node.key);
    if (field?.source !== "root" || field.virtual || !is(field.column, PgColumn)) return false;
    const caseSensitive: ReadonlySet<string> = resource.queryConfig.filters.caseSensitive;
    if (isTextColumn(field.column) && !caseSensitive.has(node.key)) return false;
    const values = Array.isArray(node.value) ? node.value : [node.value];
    return (
      values.length <= pageSize &&
      values.every(
        (value) =>
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          typeof value === "bigint",
      ) &&
      columnsAreUnique(rootTable, [field.column])
    );
  }

  function startsLookupIndex(column: PgColumn) {
    lookupKeys ??= new Set([
      ...getUniqueKeys(rootTable).map((key) => key[0]!),
      ...getTableConfig(rootTable).indexes.flatMap(({ config: index }) => {
        const first = index.columns[0];
        return !index.where && index.method === "btree" && is(first, IndexedColumn)
          ? [first.name]
          : [];
      }),
    ]);
    return lookupKeys.has(column.name);
  }

  function buildCountQuery(request: QueryRequest, db: QueryEngineDb = database) {
    const countPlan = buildAggregatePlan(request);
    return preservesRootCardinality(countPlan.joins)
      ? joinRelationSteps(
          (db as any).select({ rowCount: sql<number>`count(*)` }).from(rootTable),
          config.schema,
          countPlan.joins,
        ).where(countPlan.where)
      : (db as any).select({ rowCount: sql<number>`count(*)` }).from(
          joinRelationSteps(
            (db as any).selectDistinct({ id: rootTable.id }).from(rootTable),
            config.schema,
            countPlan.joins,
          )
            .where(countPlan.where)
            .as("count_matching_ids"),
        );
  }

  function countCap() {
    return resource.queryConfig.pagination.countCap;
  }

  /** Counts at most `cap + 1` matching rows: the extra row tells "exactly cap" from "more". */
  function buildCappedCountQuery(request: QueryRequest, db: QueryEngineDb = database) {
    const countPlan = buildAggregatePlan(request);
    const matching = preservesRootCardinality(countPlan.joins)
      ? joinRelationSteps(
          (db as any).select({ one: sql<number>`1`.as("one") }).from(rootTable),
          config.schema,
          countPlan.joins,
        )
      : joinRelationSteps(
          (db as any).selectDistinct({ id: rootTable.id }).from(rootTable),
          config.schema,
          countPlan.joins,
        );
    return (db as any).select({ rowCount: sql<number>`count(*)` }).from(
      matching
        .where(countPlan.where)
        .limit(countCap() + 1)
        .as("capped_matching_ids"),
    );
  }

  /**
   * PostgreSQL's row estimate for the request, or `undefined` when it is not trustworthy: filters
   * or search through relations or virtual fields, another database, or a failed EXPLAIN.
   */
  async function estimateRowCount(request: QueryRequest) {
    if (!isPostgresDatabase(database)) return undefined;
    const paths: string[] = [];
    collectConditionFieldsFromFilters(request.filters, paths);
    if (request.search.value.length > 0) paths.push(...request.search.fields);
    for (const path of paths) {
      const entry = resolveField(path);
      if (!entry || entry.source !== "root" || entry.virtual || entry.isManyPath) return undefined;
    }
    const plan = buildAggregatePlan(request);
    if (plan.joins.length > 0) return undefined;
    const query = (database as any).select({ id: rootTable.id }).from(rootTable).where(plan.where);
    return estimatePostgresQuery(database, query.getSQL(), "Plan Rows");
  }

  /** Resolve the request's count mode into the count a page reports. */
  async function resolveCount(request: QueryRequest): Promise<QueryPageCount> {
    const mode = request.pagination.count;
    if (mode === "none") return { count: "none", rowCount: null };
    await prepareSearch(request);
    const cap = countCap();
    if (mode === "estimated") {
      const estimate = await estimateRowCount(request);
      // A small estimate is cheap to confirm, and the planner is least reliable there.
      if (estimate !== undefined && estimate > cap) {
        return { count: "estimated", rowCount: Math.round(estimate) };
      }
    }
    const outcome = await withStatementTimeout(
      database,
      resource.queryConfig.timeouts.count,
      async (db): Promise<QueryPageCount> => {
        if (mode === "exact") {
          const [total] = await buildCountQuery(request, db);
          return { count: "exact", rowCount: Number(total?.rowCount ?? 0) };
        }
        const [total] = await buildCappedCountQuery(request, db);
        const found = Number(total?.rowCount ?? 0);
        return { count: "capped", rowCount: Math.min(found, cap), exact: found <= cap };
      },
    );
    return outcome.timedOut ? { count: "none", rowCount: null, reason: "timeout" } : outcome.value;
  }

  function buildCursorBoundary(request: QueryRequest, cursor: string) {
    const cursorValues = decodeCursor(cursor, String(resource.key), request.sorting);
    const fields = request.sorting.map(({ key }) => resolveField(key));
    const direction = request.sorting[0]?.dir;
    // A same-direction, non-null prefix can seek in one B-tree range. A LEFT JOIN
    // can introduce NULL even when the related column itself is declared NOT NULL.
    const prefix: PgColumn[] = [];
    for (const [index, field] of fields.entries()) {
      if (
        request.sorting[index]?.dir !== direction ||
        cursorValues[index] === null ||
        field?.source !== "root" ||
        field.virtual ||
        !is(field.column, PgColumn) ||
        !field.column.notNull ||
        field.column.columnType === "PgCustomColumn"
      )
        break;
      prefix.push(field.column);
    }
    let range: SQL | undefined;
    if (prefix.length && (prefix.length === fields.length || startsLookupIndex(prefix[0]!))) {
      const values = prefix.map((column, index) => sql.param(cursorValues[index], column));
      const left = sql`(${sql.join(prefix, sql`, `)})`;
      const right = sql`(${sql.join(values, sql`, `)})`;
      if (prefix.length === fields.length)
        return direction === "asc" ? sql`${left} > ${right}` : sql`${left} < ${right}`;
      // Keep ties on the prefix until the remaining sort keys decide which side they fall on.
      range = direction === "asc" ? sql`${left} >= ${right}` : sql`${left} <= ${right}`;
    }
    const branches = request.sorting.map((rule, index) => {
      const previousEqualities = request.sorting.slice(0, index).map((_, priorIndex) => {
        const column = fields[priorIndex]?.column;
        const value = cursorValues[priorIndex];
        return value === null ? isNull(column as any) : eq(column as any, value as any);
      });
      const column = fields[index]?.column;
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
    return and(range, or(...branches) ?? sql`false`);
  }

  async function executeIdsQuery({
    request,
    rowCount: knownRowCount,
    pageCount,
  }: {
    request: QueryRequest;
    rowCount?: number;
    pageCount?: QueryPageCount;
  }) {
    await prepareSearch(request);
    const pageSize = request.pagination.pageSize <= 0 ? 25 : request.pagination.pageSize;
    const sorting = compileOrderBy(request.sorting);
    const orderBy = sorting.length ? sorting : [asc(rootTable.id)];
    const direct = preservesRootCardinality(buildOuterJoins(resource, request));
    const whereClause = buildWhereClause(request);

    const firstPage =
      request.pagination.mode === "cursor"
        ? !request.pagination.cursor
        : request.pagination.pageIndex === 1;
    const mode = request.pagination.count;
    const inferCount =
      mode === "exact" &&
      knownRowCount === undefined &&
      pageCount === undefined &&
      firstPage &&
      direct &&
      request.filters.some((node) => fitsUniqueLookup(node, pageSize));
    let count: QueryPageCount =
      pageCount ??
      (mode === "exact" && knownRowCount !== undefined
        ? { count: "exact", rowCount: knownRowCount }
        : { count: "none", rowCount: null });
    const countKnown = pageCount !== undefined || (mode === "exact" && knownRowCount !== undefined);
    if (!countKnown && mode !== "none" && !inferCount) count = await resolveCount(request);
    if (isExactCount(count) && count.rowCount === 0) {
      return {
        ids: [],
        pageInfo:
          request.pagination.mode === "cursor"
            ? { mode: "cursor" as const, pageSize, nextCursor: null, ...count }
            : {
                mode: "offset" as const,
                pageIndex: request.pagination.pageIndex,
                pageSize,
                hasNextPage: false,
                ...count,
              },
      };
    }

    const cursorSelection =
      request.pagination.mode === "cursor"
        ? Object.fromEntries(
            request.sorting.map((rule, index) => [
              `__cursor_${index}`,
              resolveField(rule.key)?.column,
            ]),
          )
        : {};

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

    const cursorPredicate =
      request.pagination.mode === "cursor" && request.pagination.cursor
        ? buildCursorBoundary(request, request.pagination.cursor)
        : undefined;
    idsQuery = idsQuery.where(and(direct ? whereClause : undefined, cursorPredicate));

    const offset =
      request.pagination.mode === "offset"
        ? (Math.max(request.pagination.pageIndex, 1) - 1) * pageSize
        : 0;
    // Only a count that is exact tells whether a next page exists; every other page looks ahead.
    const needsLookahead =
      request.pagination.mode === "cursor" || (!isExactCount(count) && !inferCount);
    idsQuery = idsQuery
      .orderBy(...orderBy)
      .limit(pageSize + (needsLookahead ? 1 : 0))
      .offset(offset);

    const queriedRows = await idsQuery;
    if (inferCount) count = { count: "exact", rowCount: queriedRows.length };
    const hasNextPage =
      request.pagination.mode === "offset" && isExactCount(count)
        ? offset + Math.min(queriedRows.length, pageSize) < (count.rowCount ?? 0)
        : queriedRows.length > pageSize;
    const pageRows = queriedRows.slice(0, pageSize);
    const countInfo = count;
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
    projection,
  }: {
    projection?: Projection;
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
      ...projection?.config(database, true),
    });

    const orderIndex = new Map(orderedIds.map((id: unknown, index: number) => [id, index]));
    rows.sort(
      (left: any, right: any) =>
        Number(orderIndex.get(left.id) ?? 0) - Number(orderIndex.get(right.id) ?? 0),
    );

    return projection ? rows.map((row: any) => projection.project(row)) : rows;
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

  async function executeSummaryQuery({
    request,
    summary,
    includeCount = false,
  }: {
    request: QueryRequest;
    summary: (fields: Record<string, any>) => Record<string, SQL | SQL.Aliased>;
    includeCount?: boolean;
  }) {
    const aggregateRequest = { ...request, sorting: [] };
    await prepareSearch(aggregateRequest);
    const selection = resolveSummarySelection(
      rootTable,
      config.models?.[resource.key],
      summary,
      database,
    );
    let countKey = "__resource_count";
    while (countKey in selection) countKey += "_";
    const selected = includeCount
      ? { ...selection, [countKey]: sql`count(*)`.mapWith(Number) }
      : selection;
    const joins = buildOuterJoins(resource, aggregateRequest);
    const direct = preservesRootCardinality(joins);
    const outcome = await withStatementTimeout(
      database,
      resource.queryConfig.timeouts.summary,
      async (db) => {
        const query = (db as any).select(selected).from(rootTable);
        return (await (direct
          ? joinRelationSteps(query, config.schema, joins).where(buildWhereClause(aggregateRequest))
          : query.where(inArray(rootTable.id, buildMatchingIdsSelect(aggregateRequest))))) as Array<
          Record<string, unknown>
        >;
      },
    );
    if (outcome.timedOut) {
      return {
        summary: Object.fromEntries(Object.keys(selection).map((key) => [key, null])),
        rowCount: undefined,
        status: "timeout" as const,
      };
    }
    const rows = outcome.value;
    if (rows.length !== 1) throw new Error("Summary query must return exactly one aggregate row");
    const row = rows[0]!;
    const rowCount = includeCount ? (row[countKey] as number) : undefined;
    if (includeCount) delete row[countKey];
    return { summary: row, rowCount, status: "ok" as const };
  }

  async function executeHydratedPage({
    request,
    relations,
    projection,
    rowCount,
  }: {
    projection?: Projection;
    rowCount?: number;
    request: QueryRequest;
    relations?: QueryRelationsSubset<TWith>;
  }) {
    const mode = request.pagination.count;
    const approximate = mode === "capped" || mode === "estimated";
    const facets = request.facets ?? [];
    let pageCount: QueryPageCount | undefined;
    let aggregates: (QueryFacetsResponse & { rowCount?: number }) | undefined;
    if (facets.length === 0) {
      aggregates = undefined;
    } else if (!approximate) {
      aggregates = await resolveAggregates({
        request,
        facets,
        knownRowCount: rowCount,
        includeCount: mode === "exact" && rowCount === undefined,
      });
    } else if (resource.queryConfig.facets.whenCapped === "skip") {
      // Facets are the expensive part, so the count decides first whether they run at all.
      pageCount = await resolveCount(request);
      aggregates = isAboveCap(pageCount, countCap())
        ? { facets: skippedFacets(facets) }
        : await resolveAggregates({ request, facets });
    } else {
      [pageCount, aggregates] = await Promise.all([
        resolveCount(request),
        resolveAggregates({ request, facets }),
      ]);
    }
    const { ids, pageInfo } = await executeIdsQuery({
      request,
      rowCount: rowCount ?? aggregates?.rowCount,
      pageCount,
    });
    const rows =
      ids.length === 0 ? [] : await executeRowsQuery({ ids, request, relations, projection });
    return { rows, pageInfo, ...(aggregates ? { facets: aggregates.facets } : {}) };
  }

  async function resolveAggregates({
    request,
    facets,
    knownRowCount,
    includeCount = false,
  }: {
    request: QueryRequest;
    facets: QueryFacetRequest[];
    knownRowCount?: number;
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
          status: "ok",
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
          // Buckets count the rows that hold the faceted relation; `missing` counts the others.
          inner: new Set(entry.relationPath.map((step) => step.path)),
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
        status: "ok" as const,
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

    // Only broad reports with an existing exact total pay for a plan estimate. An EXPLAIN
    // never reads the fact rows. Facets sharing the same foreign key share that estimate.
    const distinctEstimates = new Map<PgColumn, Promise<number | undefined>>();
    async function facetSource(plan: (typeof plans)[number]) {
      const ordinary = {
        count: plan.unique ? sql<number>`count(*)` : sql<number>`count(distinct ${rootTable.id})`,
        from: (query: any, inner: ReadonlySet<string>) =>
          joinRelationSteps(query.from(rootTable), config.schema, plan.joins, inner),
      };
      const { entry } = plan;
      const [head, ...tail] = entry.relationPath;
      if (
        knownRowCount === undefined ||
        knownRowCount < 8_192 ||
        !isPostgresDatabase(database) ||
        request.filters.length ||
        request.search.value ||
        !head ||
        !plan.unique ||
        entry.isManyPath ||
        !is(entry.column, PgColumn) ||
        entry.virtual ||
        plan.facet.search ||
        head.sourceColumns.length !== 1 ||
        head.targetColumns.length !== 1
      )
        return ordinary;
      const key = head.sourceColumns[0];
      const target = head.targetColumns[0];
      if (!is(key, PgColumn) || !is(target, PgColumn)) return ordinary;
      let estimate = distinctEstimates.get(key);
      if (!estimate) {
        const distinct = (database as any).select({ key }).from(rootTable).groupBy(key);
        estimate = estimatePostgresQuery(database, distinct.getSQL(), "Plan Rows");
        distinctEstimates.set(key, estimate);
      }
      const groups = await estimate;
      if (groups === undefined || groups <= 0 || groups * 8 > knownRowCount) return ordinary;
      if (
        entry.relationPath.some(
          (step) =>
            getTableName(config.schema[step.targetTableName] as PgTable) === "facet_weights",
        )
      )
        return ordinary;
      const weights = (database as any)
        .select({
          key: sql`${key}`.as("facet_key"),
          weight: sql`count(*)`.as("weight"),
        })
        .from(rootTable)
        .groupBy(key)
        .as("facet_weights");
      return {
        count: sql<number>`sum(${weights.weight})`,
        from: (query: any, inner: ReadonlySet<string>) =>
          joinRelationSteps(
            query
              .from(weights)
              .innerJoin(config.schema[head.targetTableName], eq(weights.key, target)),
            config.schema,
            tail,
            inner,
          ),
      };
    }

    async function resolveSingle(plan: (typeof plans)[number], db: QueryEngineDb) {
      const { entry, index, limit, offset, facet } = plan;
      const column = is(entry.column, PgColumn);
      const source = await facetSource(plan);
      const bucketsQuery = source
        .from(
          (db as any).select({
            value: column ? entry.column : (entry.column as SQL).as("value"),
            count: source.count.as("count"),
          }),
          plan.inner,
        )
        .where(and(plan.where, buildFacetValuePredicate(entry.column, facet.search)))
        .groupBy(column ? (entry.column as any) : sql`1`);
      const facetBuckets = (db as any).$with(`facet_buckets_${index}`).as(bucketsQuery);
      let facetQuery: any = (db as any)
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

    async function resolveGroupingSets(group: typeof plans, db: QueryEngineDb, count = false) {
      const first = group[0]!;
      const columns = group.map(({ entry }) => entry.column as PgColumn);
      const selections = Object.fromEntries(
        columns.map((column, index) => [
          `value_${index}`,
          sql`${column}`.mapWith(column).as(`value_${index}`),
        ]),
      );
      const source = await facetSource(first);
      const aggregate = source
        .from(
          (db as any).select({
            ...selections,
            mask: sql<number>`grouping(${sql.join(columns, sql`, `)})`.as("mask"),
            count: source.count.as("count"),
          }),
          new Set(group.flatMap((plan) => [...plan.inner])),
        )
        .where(first.where)
        .groupBy(
          sql`grouping sets (${sql.join(
            [...columns.map((column) => sql`(${column})`), ...(count ? [sql`() `] : [])],
            sql`, `,
          )})`,
        );
      const buckets = (db as any).$with(`facet_groups_${first.index}`).as(aggregate);
      const values = Object.fromEntries(
        columns.map((_, index) => [`value_${index}`, buckets[`value_${index}`]]),
      );
      const ordering = sql.join(
        [desc(buckets.count), ...Object.values(values).map((value) => asc(value as SQL))],
        sql`, `,
      );
      const ranked = (db as any).$with(`facet_ranked_${first.index}`).as(
        (db as any)
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
      const rows = await (db as any)
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
    /** `missing`: one count of the facet's own scope with the field empty, as `isEmpty` reads it. */
    async function resolveMissing(plan: (typeof plans)[number], db: QueryEngineDb) {
      const { entry } = plan;
      if (
        entry.source === "root" &&
        !entry.virtual &&
        is(entry.column, PgColumn) &&
        entry.column.notNull &&
        !isArrayColumn(entry.column) &&
        !isTextColumn(entry.column)
      )
        return 0;
      const scoped = applyFacetMode(request, {
        ...plan.facet,
        mode: plan.facet.mode ?? "exclude-self",
      });
      const empty: QueryRequest = {
        ...scoped,
        filters: [
          ...scoped.filters,
          { type: "condition", key: plan.facet.key, operator: "isEmpty", value: null },
        ],
      };
      const [row] = await applyOuterJoins(
        (db as any).select({ count: sql<number>`count(*)` }).from(rootTable),
        empty,
      ).where(buildWhereClause(empty));
      return Number(row?.count ?? 0);
    }

    // A facet that exceeds `timeouts.facets` degrades alone; the others keep their buckets.
    const timedOut = new Set<number>();
    async function timedFacets(
      members: typeof plans,
      run: (db: QueryEngineDb) => Promise<void>,
    ): Promise<void> {
      const outcome = await withStatementTimeout(
        database,
        resource.queryConfig.timeouts.facets,
        run,
      );
      if (outcome.timedOut) for (const member of members) timedOut.add(member.index);
    }
    const missing = new Map<number, number>();
    await Promise.all([
      ...groups.map((group) =>
        timedFacets(group, (db) =>
          group === countGroup
            ? resolveGroupingSets(group, db, true)
            : group.length === 1
              ? resolveSingle(group[0]!, db)
              : resolveGroupingSets(group, db),
        ),
      ),
      ...plans
        .filter((plan) => plan.facet.missing)
        .map((plan) =>
          timedFacets([plan], async (db) => {
            missing.set(plan.index, await resolveMissing(plan, db));
          }),
        ),
    ]);
    for (const [index, value] of missing) {
      if (results[index]) results[index] = { ...results[index]!, missing: value };
    }
    for (const index of timedOut) results[index] = timedOutFacet(String(facets[index]!.key));

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
    executeSummaryQuery,
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
