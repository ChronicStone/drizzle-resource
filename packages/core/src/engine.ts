import type { ConfiguredEngine, ModelDefinitions } from "./model-types.js";
import { compileProjection, hasModelPolicies, resolveModels, validateModels } from "./models.js";
import type { Projection } from "./models.js";
import { resolveSummarySelection, resolveSummaryShape } from "./summary.js";
import type {
  DefineResourceOptions,
  GenericObject,
  QueryEngine,
  QueryEngineConfig,
  QueryEngineDb,
  QueryFacetsResponse,
  QueryFacetRequest,
  QueryFilterNode,
  QueryRequest,
  QueryRequestInput,
  QueryRelationsConfig,
  QueryResultRowShape,
  QueryResponse,
  QueryResource,
  QueryRootKey,
  ResourceQueryExecutionOptions,
  ResourceHydrationConfig,
  ResourceHydrationProfiles,
  ResourceQueryDefaultsConfig,
  QueryScanRequest,
  QueryScanBatch,
  QueryCountMode,
} from "./types.js";
import { buildFieldRegistry, createQueryResourceUtils, mergeScopeFilters } from "./sql.js";
import { createQueryFilterBuilder } from "./filters.js";
import { defaultQueryValidation } from "./contracts.js";
import { isPostgresDatabase, withScanDatabase } from "./postgres.js";

function normalizeRequest(
  request: QueryRequestInput,
  defaultSearchFields: readonly string[],
  defaults?: ResourceQueryDefaultsConfig,
): QueryRequest {
  const searchFields =
    request.search.fields.length > 0 ? request.search.fields : defaultSearchFields;
  const defaultPageIndex = defaults?.pagination?.pageIndex ?? 1;
  const defaultPageSize = defaults?.pagination?.pageSize ?? 25;
  const requestedMode = request.pagination.mode ?? "offset";
  const defaultCount =
    defaults?.pagination?.mode === requestedMode ? defaults.pagination.count : undefined;
  const pagination =
    request.pagination.mode === "cursor"
      ? {
          mode: "cursor" as const,
          cursor: request.pagination.cursor ?? null,
          pageSize: request.pagination.pageSize > 0 ? request.pagination.pageSize : defaultPageSize,
          count: request.pagination.count ?? defaultCount ?? ("none" as const),
        }
      : {
          mode: "offset" as const,
          pageIndex:
            request.pagination.pageIndex > 0 ? request.pagination.pageIndex : defaultPageIndex,
          pageSize: request.pagination.pageSize > 0 ? request.pagination.pageSize : defaultPageSize,
          count: request.pagination.count ?? defaultCount ?? ("exact" as const),
        };
  const requestedSorting =
    request.sorting.length > 0 ? request.sorting : [...(defaults?.sorting ?? [])];
  const sorting = !requestedSorting.some(({ key }) => key === "id")
    ? [...requestedSorting, { key: "id", dir: requestedSorting.at(-1)?.dir ?? ("asc" as const) }]
    : requestedSorting;

  return {
    ...request,
    context: {},
    pagination,
    sorting,
    search: {
      ...request.search,
      value: typeof request.search.value === "string" ? request.search.value : "",
      fields: [...searchFields],
    },
  };
}

function assertRequestLimits(
  request: QueryRequest,
  limits: {
    maxPageSize: number;
    maxCursorLength: number;
    maxFilterDepth: number;
    maxFilterNodes: number;
    maxFacetCount: number;
    maxFacetLimit: number;
  },
) {
  if (request.pagination.pageSize > limits.maxPageSize) {
    throw new Error(`Page size cannot exceed ${limits.maxPageSize}`);
  }
  if (
    request.pagination.mode === "cursor" &&
    (request.pagination.cursor?.length ?? 0) > limits.maxCursorLength
  ) {
    throw new Error(`Cursor cannot exceed ${limits.maxCursorLength} characters`);
  }

  let filterNodes = 0;
  const stack = request.filters.map((node) => ({ node, depth: 1 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    filterNodes += 1;
    if (filterNodes > limits.maxFilterNodes) {
      throw new Error(`Filter tree cannot exceed ${limits.maxFilterNodes} nodes`);
    }
    if (depth > limits.maxFilterDepth) {
      throw new Error(`Filter tree cannot exceed ${limits.maxFilterDepth} levels`);
    }
    if (node.type === "group") {
      stack.push(...node.children.map((child) => ({ node: child, depth: depth + 1 })));
    }
  }

  if ((request.facets?.length ?? 0) > limits.maxFacetCount) {
    throw new Error(`A request cannot contain more than ${limits.maxFacetCount} facets`);
  }
  for (const facet of request.facets ?? []) {
    if ((facet.limit ?? 0) > limits.maxFacetLimit) {
      throw new Error(`Facet limit cannot exceed ${limits.maxFacetLimit}`);
    }
  }
}

function resolveExecutionLimits(
  resourceLimits: Required<ResourceQueryExecutionOptions> & {
    maxCursorLength: number;
    maxFilterDepth: number;
    maxFilterNodes: number;
    maxFacetCount: number;
    maxFacetLimit: number;
  },
  execution?: ResourceQueryExecutionOptions,
) {
  if (execution?.maxPageSize === undefined) return resourceLimits;

  if (!Number.isSafeInteger(execution.maxPageSize) || execution.maxPageSize < 1) {
    throw new Error("Execution max page size must be a positive safe integer");
  }

  return {
    ...resourceLimits,
    maxPageSize: execution.maxPageSize,
  };
}

function assertKnownFields(
  resource: QueryResource<any, any, any, any, any, any, any>,
  request: QueryRequest,
) {
  if (!resource.queryConfig.pagination.modes.has(request.pagination.mode)) {
    throw new Error(
      `Pagination mode "${request.pagination.mode}" is not allowed for resource "${String(resource.key)}"`,
    );
  }
  const invalidSort = request.sorting.find(({ key }) => !resource.fields.has(key));
  if (invalidSort) {
    throw new Error(
      `Unknown sorting field "${invalidSort.key}" for resource "${String(resource.key)}"`,
    );
  }

  const disabledSort = request.sorting.find(({ key }) => !resource.fields.get(key)?.sortable);
  if (disabledSort) {
    throw new Error(
      `Sorting field "${disabledSort.key}" is not allowed for resource "${String(resource.key)}"`,
    );
  }

  for (const field of request.search.fields) {
    if (!resource.queryConfig.search.allowed.has(field as never)) {
      throw new Error(`Unknown search field "${field}" for resource "${String(resource.key)}"`);
    }
  }

  const stack: QueryFilterNode[] = [...request.filters];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "condition") {
      if (!resource.fields.has(node.key)) {
        throw new Error(
          `Unknown filter field "${node.key}" for resource "${String(resource.key)}"`,
        );
      }
      continue;
    }
    stack.push(...node.children);
  }
}

function resolveQueryStrategy(
  options: DefineResourceOptions<any, any, any, any, any, any, any, any>,
) {
  return options.strategy?.query;
}

function assertHydrationRelations(
  available: Record<string, unknown> | undefined,
  selected: Record<string, unknown>,
  location: string,
) {
  for (const [relation, selection] of Object.entries(selected)) {
    const availableSelection = available?.[relation];

    if (availableSelection === undefined) {
      throw new Error(`Unknown hydration relation "${location}${relation}"`);
    }

    if (selection === true) continue;

    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      throw new Error(`Invalid hydration relation "${location}${relation}"`);
    }

    const nested = "with" in selection ? (selection as { with?: unknown }).with : undefined;
    if (nested === undefined) continue;
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
      throw new Error(`Invalid hydration relation "${location}${relation}.with"`);
    }

    const availableNested =
      availableSelection && typeof availableSelection === "object" && "with" in availableSelection
        ? ((availableSelection as { with?: Record<string, unknown> }).with ?? undefined)
        : undefined;

    assertHydrationRelations(
      availableNested,
      nested as Record<string, unknown>,
      `${location}${relation}.`,
    );
  }
}

function assertKnownFacetFields(
  resource: QueryResource<any, any, any, any, any, any, any>,
  facets: QueryFacetRequest[],
) {
  for (const facet of facets) {
    if (!resource.queryConfig.facets.allowed.has(facet.key as never)) {
      throw new Error(`Unknown facet field "${facet.key}" for resource "${String(resource.key)}"`);
    }
  }
}

async function executeFacetsForResource(
  options: DefineResourceOptions<any, any, any, any, any, any, any, any>,
  resource: QueryResource<any, any, any, any, any, any, any>,
  utils: ReturnType<typeof createQueryResourceUtils>,
  request: QueryRequest,
  facets: QueryFacetRequest[],
  limits: Parameters<typeof assertRequestLimits>[1],
  context?: unknown,
): Promise<QueryFacetsResponse> {
  assertRequestLimits(request, limits);
  assertKnownFacetFields(resource, facets);

  if (options.strategy?.facets) {
    return options.strategy.facets({
      request,
      facets,
      context,
      resource,
      utils,
    });
  }

  return utils.resolveFacets({
    request,
    facets,
  });
}

/**
 * Create a typed query engine bound to one Drizzle database, schema, and relations graph.
 *
 * The returned engine is the entry point for defining release-ready query resources:
 *
 * ```ts
 * const engine = createQueryEngine({ db, schema, relations }).withContext<{ orgId: string }>()
 *
 * const employees = engine.defineResource('employees', {
 *   relations: {
 *     department: {
 *       with: {
 *         company: true,
 *       },
 *     },
 *   },
 *   query: {
 *     scope: (filters, ctx) => filters.and([filters.is('department.company.country', ctx.orgId)]),
 *   },
 * })
 * ```
 */
export function createQueryEngine<
  TDb extends QueryEngineConfig["db"],
  TSchema extends QueryEngineConfig["schema"],
  TRelations extends QueryEngineConfig["relations"],
  const TModels extends object = {},
>(inputConfig: {
  db: TDb;
  schema: TSchema;
  relations: TRelations;
  models?: ModelDefinitions<TSchema, TDb> &
    TModels &
    Record<Exclude<keyof TModels, keyof TSchema>, never>;
}): ConfiguredEngine<TDb, TSchema, TRelations, TModels> {
  const config = {
    ...inputConfig,
    models: inputConfig.models
      ? resolveModels(inputConfig.schema, inputConfig.db, inputConfig.models)
      : undefined,
  } as QueryEngineConfig<TDb, TSchema, TRelations>;
  validateModels(config.schema, config.models ?? {}, config.relations);
  function buildEngine<TEngineContext extends GenericObject>(): QueryEngine<
    TDb,
    TSchema,
    TRelations,
    TEngineContext
  > {
    function defineScope(root: any, relationsOrHandler: any, maybeHandler?: any) {
      const handler = typeof relationsOrHandler === "function" ? relationsOrHandler : maybeHandler;
      return (filters: any, context: any) => handler(context, filters);
    }

    function defineResource<
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
    function defineResource<
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
      const THydration extends
        | ResourceHydrationConfig<TRelationsConfig, ResourceHydrationProfiles<TRelationsConfig>>
        | undefined = undefined,
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
        TRow,
        THydration
      > & {
        relations: TRelationsConfig;
      },
    ): QueryResource<TDb, TSchema, TRelations, TRoot, TRelationsConfig, TContext, TRow, THydration>;
    function defineResource(root: any, options: any): any {
      const relationsClause = options.relations as any;
      const hydrationClause = options.hydration as
        | {
            profiles: Record<string, Record<string, unknown>>;
            defaults?: { query?: string; findById?: string };
          }
        | undefined;

      for (const [profile, profileRelations] of Object.entries(hydrationClause?.profiles ?? {})) {
        assertHydrationRelations(relationsClause, profileRelations, `${profile}.`);
      }
      for (const operation of ["query", "findById"] as const) {
        const profile = hydrationClause?.defaults?.[operation];
        if (profile && !(profile in hydrationClause!.profiles)) {
          throw new Error(
            `Unknown default hydration profile "${profile}" for resource "${String(root)}"`,
          );
        }
      }

      function resolveHydrationRelations(
        operation: "query" | "findById",
        load?: string | Record<string, unknown>,
      ) {
        if (typeof load === "string") {
          const profileRelations = hydrationClause?.profiles[load];
          if (!profileRelations) {
            throw new Error(`Unknown hydration profile "${load}" for resource "${String(root)}"`);
          }
          return profileRelations;
        }

        if (load) {
          assertHydrationRelations(relationsClause, load, "");
          return load;
        }

        const defaultProfile = hydrationClause?.defaults?.[operation];
        return defaultProfile ? hydrationClause!.profiles[defaultProfile] : relationsClause;
      }

      const viewProjections = new Map<string, Projection>();
      for (const [name, view] of Object.entries(options.views ?? {})) {
        viewProjections.set(name, compileProjection(config, root, relationsClause, view as any));
      }
      const defaultProjections = new WeakMap<object, Projection | undefined>();
      const emptyRelations = {};
      function resolveProjection(relations: any, view?: string) {
        if (view !== undefined) {
          const projection = viewProjections.get(view);
          if (!projection) throw new Error(`Unknown view "${view}" for resource "${root}"`);
          return projection;
        }
        if (!config.models || !Object.keys(config.models).length) return undefined;
        const key = relations ?? emptyRelations;
        if (defaultProjections.has(key)) return defaultProjections.get(key);
        const projection = hasModelPolicies(config, root, relations)
          ? compileProjection(config, root, relations)
          : undefined;
        defaultProjections.set(key, projection);
        return projection;
      }
      if (options.summary && (options.strategy?.query || options.strategy?.ids)) {
        throw new Error("Summaries require the built-in matching-row strategy");
      }
      resolveProjection(relationsClause);

      const trustedFieldRegistry = buildFieldRegistry(config, root, relationsClause, {
        nonFilterable: options.query?.filters?.disabled,
        nonSortable: options.query?.sort?.disabled,
      });
      const hiddenFields = new Set<string>(options.query?.filters?.hidden ?? []);
      const fieldRegistry = new Map(
        Array.from(trustedFieldRegistry).filter(
          ([field, entry]) =>
            !hiddenFields.has(field) &&
            !config.models?.[entry.tableName]?.private?.includes(field.split(".").at(-1)!),
        ),
      );
      const allFields = Array.from(fieldRegistry.keys()).sort();
      const allowedSearchFields = new Set(
        (options.query?.search?.allowed ?? allFields).filter((field: any) =>
          fieldRegistry.has(field),
        ),
      ) as Set<any>;
      const defaultFields = (
        options.query?.search?.defaults ?? Array.from(allowedSearchFields)
      ).filter((field: any) => allowedSearchFields.has(field));
      const allowedFacetFields = new Set(
        (options.query?.facets?.allowed ?? allFields).filter((field: any) =>
          fieldRegistry.has(field),
        ),
      ) as Set<any>;
      const disabledSortFields = new Set(
        (options.query?.sort?.disabled ?? []).filter((field: any) => fieldRegistry.has(field)),
      ) as Set<any>;
      const hiddenFilterFields = new Set(
        (options.query?.filters?.hidden ?? []).filter((field: any) =>
          trustedFieldRegistry.has(field),
        ),
      ) as Set<any>;
      const disabledFilterFields = new Set(
        (options.query?.filters?.disabled ?? []).filter((field: any) => fieldRegistry.has(field)),
      ) as Set<any>;
      const caseSensitiveFilterFields = new Set(
        (options.query?.filters?.caseSensitive ?? []).filter((field: any) =>
          trustedFieldRegistry.has(field),
        ),
      ) as Set<any>;
      const paginationModes = new Set<"offset" | "cursor">(
        options.query?.pagination?.modes ?? ["offset"],
      );
      const defaultPaginationMode = options.query?.defaults?.pagination?.mode ?? "offset";
      if (paginationModes.size === 0) {
        throw new Error(`Resource "${String(root)}" must allow at least one pagination mode`);
      }
      if (!paginationModes.has(defaultPaginationMode)) {
        throw new Error(
          `Default pagination mode "${defaultPaginationMode}" is not allowed for resource "${String(root)}"`,
        );
      }
      if (paginationModes.has("cursor") && !fieldRegistry.get("id")?.sortable) {
        throw new Error(`Cursor pagination requires a visible, sortable root "id" field`);
      }

      const filterBuilder = createQueryFilterBuilder<any>();

      let trustedResource: QueryResource<any, any, any, any, any, any, any, any>;
      let summaryShape: ReturnType<typeof resolveSummaryShape> | undefined;
      const resource = {
        $infer: undefined as never,
        key: root,
        schema: config.schema,
        relationGraph: config.relations,
        relations: relationsClause,
        hydration: hydrationClause,
        views: options.views,
        models: config.models,
        getSummaryShape() {
          if (!options.summary) return undefined;
          return (summaryShape ??= resolveSummaryShape(
            resolveSummarySelection(
              config.schema[root],
              config.models?.[root],
              options.summary,
              config.db,
            ),
          ));
        },
        fields: fieldRegistry,
        queryConfig: {
          search: {
            allowed: allowedSearchFields,
            defaults: defaultFields as any[],
          },
          sort: {
            disabled: disabledSortFields,
          },
          filters: {
            hidden: hiddenFilterFields,
            disabled: disabledFilterFields,
            caseSensitive: caseSensitiveFilterFields,
          },
          facets: {
            allowed: allowedFacetFields,
          },
          pagination: {
            modes: paginationModes,
          },
          defaults: {
            pagination: options.query?.defaults?.pagination,
            sorting: options.query?.sort?.defaults,
          },
          validation: {
            maxPageSize:
              options.query?.validation?.maxPageSize ?? defaultQueryValidation.maxPageSize,
            maxCursorLength:
              options.query?.validation?.maxCursorLength ?? defaultQueryValidation.maxCursorLength,
            maxFilterDepth:
              options.query?.validation?.maxFilterDepth ?? defaultQueryValidation.maxFilterDepth,
            maxFilterNodes:
              options.query?.validation?.maxFilterNodes ?? defaultQueryValidation.maxFilterNodes,
            maxFacetCount:
              options.query?.validation?.maxFacetCount ?? defaultQueryValidation.maxFacetCount,
            maxFacetLimit:
              options.query?.validation?.maxFacetLimit ?? defaultQueryValidation.maxFacetLimit,
          },
        },
        querySummary: async ({
          request,
          context,
          db,
          execution,
        }: {
          request: QueryRequestInput;
          context?: any;
          db?: QueryEngineDb;
          execution?: ResourceQueryExecutionOptions;
        }) => {
          if (!options.summary) throw new Error(`No summary defined for resource "${root}"`);
          const normalizedRequest = prepareRequest(request, context, { execution });
          const utils = createQueryResourceUtils(config, { resource: trustedResource, db });
          return (
            await utils.executeSummaryQuery({
              request: normalizedRequest,
              summary: options.summary,
            })
          ).summary;
        },
        query: async ({
          request,
          context,
          db,
          execution,
          load,
          view,
          summary,
        }: {
          view?: string;
          summary?: boolean;
          request: QueryRequestInput;
          context?: any;
          db?: QueryEngineDb;
          execution?: ResourceQueryExecutionOptions;
          load?: string | Record<string, unknown>;
        }): Promise<any> => executeQuery({ request, context, db, execution, load, view, summary }),
        scan: executeScan,
        findById: async ({
          id,
          context,
          db,
          load,
          view,
        }: {
          view?: string;
          id: unknown;
          context?: any;
          db?: QueryEngineDb;
          load?: string | Record<string, unknown>;
        }): Promise<any> => {
          const pagination = paginationModes.has("offset")
            ? { mode: "offset" as const, pageIndex: 1, pageSize: 1, count: "none" as const }
            : { mode: "cursor" as const, cursor: null, pageSize: 1, count: "none" as const };
          const response = await executeQuery({
            request: {
              pagination,
              sorting: [{ key: "id", dir: "asc" }],
              filters: [{ type: "condition", key: "id", operator: "is", value: id }],
              search: { value: "", fields: [] },
            },
            context,
            db,
            load,
            view,
            operation: "findById",
            trustedInput: true,
          });

          return response.rows[0] ?? null;
        },
        queryIds: async ({
          request,
          context,
          db,
          execution,
        }: {
          request: QueryRequestInput;
          context?: any;
          db?: QueryEngineDb;
          execution?: ResourceQueryExecutionOptions;
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context, { execution });
          const utils = createQueryResourceUtils(config, {
            resource: trustedResource,
            db,
          });
          return executeIds(normalizedRequest, context, utils);
        },
        queryRows: async ({
          request,
          ids,
          context,
          db,
          execution,
          load,
          view,
        }: {
          view?: string;
          request: QueryRequestInput;
          ids: unknown[];
          context?: any;
          db?: QueryEngineDb;
          execution?: ResourceQueryExecutionOptions;
          load?: string | Record<string, unknown>;
        }): Promise<any> => {
          if (view !== undefined && load !== undefined)
            throw new Error("Use either view or load, not both");
          const normalizedRequest = prepareRequest(request, context, { execution });
          const hydrationRelations = resolveHydrationRelations("query", load);
          const utils = createQueryResourceUtils(config, {
            resource: trustedResource,
            db,
          });
          return executeRows(
            normalizedRequest,
            ids,
            context,
            utils,
            hydrationRelations,
            resolveProjection(hydrationRelations, view),
          );
        },
        queryFacets: async ({
          request,
          facets,
          context,
          db,
          execution,
        }: {
          request: QueryRequestInput;
          facets: QueryFacetRequest[];
          context?: any;
          db?: QueryEngineDb;
          execution?: ResourceQueryExecutionOptions;
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context, { execution });
          const limits = resolveExecutionLimits(resource.queryConfig.validation, execution);
          const utils = createQueryResourceUtils(config, {
            resource: trustedResource,
            db,
          });
          return executeFacetsForResource(
            options,
            resource as QueryResource<any, any, any, any, any, any, any>,
            utils,
            normalizedRequest,
            facets,
            limits,
            context,
          );
        },
      } as unknown as QueryResource<any, any, any, any, any, any, any, any>;

      trustedResource = {
        ...resource,
        fields: trustedFieldRegistry,
      };

      async function executeScan<TResult>(
        args: {
          request?: QueryScanRequest;
          context?: any;
          db?: QueryEngineDb;
          batchSize?: number;
          count?: QueryCountMode;
          signal?: AbortSignal;
          view?: string;
          load?: string | Record<string, unknown>;
        },
        consume: (batches: AsyncIterable<QueryScanBatch<GenericObject>>) => Promise<TResult>,
      ): Promise<TResult> {
        if (args.view !== undefined && args.load !== undefined)
          throw new Error("Use either view or load, not both");
        const batchSize = args.batchSize ?? 1000;
        if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
          throw new Error("Scan batch size must be a positive safe integer");
        }
        args.signal?.throwIfAborted();
        const count = args.count ?? "none";
        const request = prepareRequest(
          {
            filters: args.request?.filters ?? [],
            sorting: args.request?.sorting ?? [],
            search: args.request?.search ?? { value: "", fields: [] },
            pagination: paginationModes.has("cursor")
              ? { mode: "cursor", cursor: null, pageSize: batchSize, count }
              : { mode: "offset", pageIndex: 1, pageSize: batchSize, count },
          },
          args.context,
          { execution: { maxPageSize: batchSize } },
        );
        const hydrationRelations = resolveHydrationRelations("query", args.load);
        const projection = resolveProjection(hydrationRelations, args.view);
        return withScanDatabase(args.db ?? config.db, async (database) => {
          const utils = createQueryResourceUtils(config, {
            resource: trustedResource,
            db: database,
          });
          if (isPostgresDatabase(database) && !options.strategy?.query && !options.strategy?.ids) {
            return utils.scanIds(
              { request, count, batchSize, signal: args.signal },
              async (batches) => {
                async function* hydrate() {
                  for await (const batch of batches) {
                    args.signal?.throwIfAborted();
                    const rows = await executeRows(
                      request,
                      batch.ids,
                      args.context,
                      utils,
                      hydrationRelations,
                      projection,
                    );
                    args.signal?.throwIfAborted();
                    yield {
                      rows,
                      ...(batch.totalRows === undefined ? {} : { totalRows: batch.totalRows }),
                    };
                  }
                }
                const pages = hydrate();
                try {
                  const result = await consume(pages);
                  args.signal?.throwIfAborted();
                  return result;
                } finally {
                  await pages.return();
                }
              },
            );
          }
          async function* paginate() {
            let current = request;
            let totalRows: number | undefined;
            while (true) {
              args.signal?.throwIfAborted();
              let response: QueryResponse<any>;
              if (options.strategy?.query) {
                response = await options.strategy.query({
                  request: current,
                  context: args.context,
                  resource,
                  utils,
                  relations: hydrationRelations,
                });
              } else {
                const { ids, pageInfo } = await executeIds(current, args.context, utils);
                response = {
                  rows: ids.length
                    ? await executeRows(
                        current,
                        ids,
                        args.context,
                        utils,
                        hydrationRelations,
                        projection,
                      )
                    : [],
                  pageInfo,
                };
              }
              if (options.strategy?.query && projection)
                response.rows = response.rows.map((row) => projection.project(row));
              args.signal?.throwIfAborted();
              if (response.pageInfo.rowCount !== null) totalRows = response.pageInfo.rowCount;
              if (!response.rows.length) return;
              yield { rows: response.rows, ...(totalRows === undefined ? {} : { totalRows }) };
              const info = response.pageInfo;
              if (info.mode === "cursor") {
                if (!info.nextCursor) return;
                if (
                  current.pagination.mode === "cursor" &&
                  info.nextCursor === current.pagination.cursor
                ) {
                  throw new Error("Scan pagination did not advance");
                }
                current = {
                  ...current,
                  pagination: {
                    mode: "cursor",
                    cursor: info.nextCursor,
                    pageSize: batchSize,
                    count: "none",
                  },
                };
              } else {
                if (!info.hasNextPage) return;
                current = {
                  ...current,
                  pagination: {
                    mode: "offset",
                    pageIndex: info.pageIndex + 1,
                    pageSize: batchSize,
                    count: "none",
                  },
                };
              }
            }
          }
          const pages = paginate();
          try {
            const result = await consume(pages);
            args.signal?.throwIfAborted();
            return result;
          } finally {
            await pages.return();
          }
        });
      }

      async function executeQuery({
        request,
        context,
        db,
        execution,
        load,
        view,
        summary,
        operation = "query",
        trustedInput = false,
      }: {
        view?: string;
        summary?: boolean;
        request: QueryRequestInput;
        context?: any;
        db?: QueryEngineDb;
        execution?: ResourceQueryExecutionOptions;
        load?: string | Record<string, unknown>;
        operation?: "query" | "findById";
        trustedInput?: boolean;
      }) {
        if (view !== undefined && load !== undefined)
          throw new Error("Use either view or load, not both");
        const normalizedRequest = prepareRequest(request, context, { execution, trustedInput });
        const limits = resolveExecutionLimits(resource.queryConfig.validation, execution);
        const hydrationRelations = resolveHydrationRelations(operation, load);
        const utils = createQueryResourceUtils(config, {
          resource: trustedResource,
          db,
        });
        const projection = resolveProjection(hydrationRelations, view);
        if (summary && !options.summary)
          throw new Error(`No summary defined for resource "${root}"`);
        const aggregate = summary
          ? await utils.executeSummaryQuery({
              request: normalizedRequest,
              summary: options.summary,
              includeCount: normalizedRequest.pagination.count === "exact",
            })
          : undefined;
        const customQueryStrategy = resolveQueryStrategy(options);
        let response: QueryResponse<any>;

        if (customQueryStrategy) {
          response = await customQueryStrategy({
            request: normalizedRequest,
            context,
            resource,
            utils,
            relations: hydrationRelations,
          });
          if (projection) response.rows = response.rows.map((row) => projection.project(row));
        } else if (!options.strategy?.ids && !options.strategy?.rows && !options.strategy?.facets) {
          response = await utils.executeHydratedPage({
            request: normalizedRequest,
            relations: hydrationRelations,
            projection,
            rowCount: aggregate?.rowCount,
          });
        } else {
          const idsResponse = await executeIds(
            normalizedRequest,
            context,
            utils,
            aggregate?.rowCount,
          );
          const rows =
            idsResponse.ids.length > 0
              ? await executeRows(
                  normalizedRequest,
                  idsResponse.ids,
                  context,
                  utils,
                  hydrationRelations,
                  projection,
                )
              : [];

          response = {
            rows,
            pageInfo: idsResponse.pageInfo,
          };
        }

        if (aggregate) Object.assign(response, { summary: aggregate.summary });

        if (
          !normalizedRequest.facets ||
          normalizedRequest.facets.length === 0 ||
          response.facets !== undefined
        ) {
          return response;
        }

        const facetsResponse = await executeFacetsForResource(
          options,
          resource as QueryResource<any, any, any, any, any, any, any>,
          utils,
          normalizedRequest,
          normalizedRequest.facets,
          limits,
          context,
        );

        return {
          ...response,
          facets: facetsResponse.facets,
        };
      }

      function prepareRequest(
        request: QueryRequestInput,
        context: any,
        executionOptions: {
          execution?: ResourceQueryExecutionOptions;
          trustedInput?: boolean;
        } = {},
      ) {
        const normalizedRequest = normalizeRequest(request, defaultFields as readonly string[], {
          pagination: options.query?.defaults?.pagination,
          sorting: options.query?.sort?.defaults,
        });

        const limits = resolveExecutionLimits(
          resource.queryConfig.validation,
          executionOptions.execution,
        );

        assertRequestLimits(normalizedRequest, limits);

        const inputResource = executionOptions.trustedInput ? trustedResource : resource;

        const suppliedSorting = request.sorting.length
          ? request.sorting
          : (options.query?.sort?.defaults ?? []);
        // The normalizer's ID tie-breaker is internal; explicit client ID sorts remain public input.
        const validationRequest =
          !inputResource.fields.has("id") &&
          !suppliedSorting.some(({ key }: { key: string }) => key === "id")
            ? {
                ...normalizedRequest,
                sorting: normalizedRequest.sorting.filter(({ key }) => key !== "id"),
              }
            : normalizedRequest;
        assertKnownFields(inputResource, validationRequest);
        assertKnownFacetFields(inputResource, normalizedRequest.facets ?? []);

        const scopedRequest = {
          ...normalizedRequest,
          filters: mergeScopeFilters(
            options.query?.scope?.(filterBuilder, context),
            normalizedRequest.filters,
          ),
        };

        assertRequestLimits(scopedRequest, limits);
        assertKnownFields(trustedResource, scopedRequest);
        return scopedRequest;
      }

      async function executeIds(
        request: QueryRequest,
        context: any,
        utils: ReturnType<typeof createQueryResourceUtils>,
        rowCount?: number,
      ) {
        if (options.strategy?.ids) {
          return options.strategy.ids({
            request,
            context,
            resource,
            utils,
          });
        }

        return utils.executeIdsQuery({ request, rowCount });
      }

      async function executeRows(
        request: QueryRequest,
        ids: unknown[],
        context: any,
        utils: ReturnType<typeof createQueryResourceUtils>,
        hydrationRelations: Record<string, unknown> | undefined,
        projection?: Projection,
      ) {
        if (options.strategy?.rows) {
          const rows = await options.strategy.rows({
            request,
            ids,
            context,
            resource,
            utils,
            relations: hydrationRelations,
          });
          return projection ? rows.map((row: any) => projection.project(row)) : rows;
        }

        return utils.executeRowsQuery({ ids, request, relations: hydrationRelations, projection });
      }

      return resource;
    }

    function defineQueryResource(root: any, options: any): any {
      return defineResource(root, options);
    }

    return {
      withContext<TContext extends GenericObject>() {
        return buildEngine<TContext>();
      },
      defineScope,
      defineResource,
      defineQueryResource,
    } as QueryEngine<TDb, TSchema, TRelations, TEngineContext>;
  }

  return buildEngine<Record<string, unknown>>() as unknown as ConfiguredEngine<
    TDb,
    TSchema,
    TRelations,
    TModels
  >;
}
