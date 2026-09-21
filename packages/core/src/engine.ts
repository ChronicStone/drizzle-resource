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
  ResourceHydrationConfig,
  ResourceHydrationProfiles,
  ResourceQueryDefaultsConfig,
} from "./types.js";
import { buildFieldRegistry, createQueryResourceUtils, mergeScopeFilters } from "./sql.js";
import { createQueryFilterBuilder } from "./filters.js";
import { defaultQueryValidation } from "./contracts.js";

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
  const sorting =
    pagination.mode === "cursor" && !requestedSorting.some(({ key }) => key === "id")
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
  context?: unknown,
): Promise<QueryFacetsResponse> {
  assertRequestLimits(request, resource.queryConfig.validation);
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
>(
  config: QueryEngineConfig<TDb, TSchema, TRelations>,
): QueryEngine<TDb, TSchema, TRelations, Record<string, unknown>> {
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

      const trustedFieldRegistry = buildFieldRegistry(config, root, relationsClause, {
        nonFilterable: options.query?.filters?.disabled,
        nonSortable: options.query?.sort?.disabled,
      });
      const hiddenFields = new Set<string>(options.query?.filters?.hidden ?? []);
      const fieldRegistry = new Map(
        Array.from(trustedFieldRegistry).filter(([field]) => !hiddenFields.has(field)),
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
      const resource: QueryResource<any, any, any, any, any, any, any, any> = {
        $infer: undefined as never,
        key: root,
        schema: config.schema,
        relationGraph: config.relations,
        relations: relationsClause,
        hydration: hydrationClause,
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
        query: async ({
          request,
          context,
          db,
          load,
        }: {
          request: QueryRequestInput;
          context?: any;
          db?: QueryEngineDb;
          load?: string | Record<string, unknown>;
        }): Promise<any> => executeQuery({ request, context, db, load }),
        findById: async ({
          id,
          context,
          db,
          load,
        }: {
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
            operation: "findById",
            trustedInput: true,
          });

          return response.rows[0] ?? null;
        },
        queryIds: async ({
          request,
          context,
          db,
        }: {
          request: QueryRequestInput;
          context?: any;
          db?: QueryEngineDb;
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context);
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
          load,
        }: {
          request: QueryRequestInput;
          ids: unknown[];
          context?: any;
          db?: QueryEngineDb;
          load?: string | Record<string, unknown>;
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context);
          const hydrationRelations = resolveHydrationRelations("query", load);
          const utils = createQueryResourceUtils(config, {
            resource: trustedResource,
            db,
          });
          return executeRows(normalizedRequest, ids, context, utils, hydrationRelations);
        },
        queryFacets: async ({
          request,
          facets,
          context,
          db,
        }: {
          request: QueryRequestInput;
          facets: QueryFacetRequest[];
          context?: any;
          db?: QueryEngineDb;
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context);
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
            context,
          );
        },
      };

      trustedResource = {
        ...resource,
        fields: trustedFieldRegistry,
      };

      async function executeQuery({
        request,
        context,
        db,
        load,
        operation = "query",
        trustedInput = false,
      }: {
        request: QueryRequestInput;
        context?: any;
        db?: QueryEngineDb;
        load?: string | Record<string, unknown>;
        operation?: "query" | "findById";
        trustedInput?: boolean;
      }) {
        const normalizedRequest = prepareRequest(request, context, trustedInput);
        const hydrationRelations = resolveHydrationRelations(operation, load);
        const utils = createQueryResourceUtils(config, {
          resource: trustedResource,
          db,
        });
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
        } else {
          const idsResponse = await executeIds(normalizedRequest, context, utils);
          const rows =
            idsResponse.ids.length > 0
              ? await executeRows(
                  normalizedRequest,
                  idsResponse.ids,
                  context,
                  utils,
                  hydrationRelations,
                )
              : [];

          response = {
            rows,
            pageInfo: idsResponse.pageInfo,
          };
        }

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
          context,
        );

        return {
          ...response,
          facets: facetsResponse.facets,
        };
      }

      function prepareRequest(request: QueryRequestInput, context: any, trustedInput = false) {
        const normalizedRequest = normalizeRequest(request, defaultFields as readonly string[], {
          pagination: options.query?.defaults?.pagination,
          sorting: options.query?.sort?.defaults,
        });

        assertRequestLimits(normalizedRequest, resource.queryConfig.validation);

        const inputResource = trustedInput ? trustedResource : resource;

        assertKnownFields(inputResource, normalizedRequest);
        assertKnownFacetFields(inputResource, normalizedRequest.facets ?? []);

        const scopedRequest = {
          ...normalizedRequest,
          filters: mergeScopeFilters(
            options.query?.scope?.(filterBuilder, context),
            normalizedRequest.filters,
          ),
        };

        assertRequestLimits(scopedRequest, resource.queryConfig.validation);
        assertKnownFields(trustedResource, scopedRequest);
        return scopedRequest;
      }

      async function executeIds(
        request: QueryRequest,
        context: any,
        utils: ReturnType<typeof createQueryResourceUtils>,
      ) {
        if (options.strategy?.ids) {
          return options.strategy.ids({
            request,
            context,
            resource,
            utils,
          });
        }

        return utils.executeIdsQuery({ request });
      }

      async function executeRows(
        request: QueryRequest,
        ids: unknown[],
        context: any,
        utils: ReturnType<typeof createQueryResourceUtils>,
        hydrationRelations: Record<string, unknown> | undefined,
      ) {
        if (options.strategy?.rows) {
          return options.strategy.rows({
            request,
            ids,
            context,
            resource,
            utils,
            relations: hydrationRelations,
          });
        }

        return utils.executeRowsQuery({ ids, request, relations: hydrationRelations });
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

  return buildEngine<Record<string, unknown>>();
}
