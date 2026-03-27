import type {
  DefineResourceOptions,
  GenericObject,
  QueryEngine,
  QueryEngineConfig,
  QueryFacetsResponse,
  QueryFacetRequest,
  QueryFilterNode,
  QueryRequest,
  QueryRelationsConfig,
  QueryResultRowShape,
  QueryResponse,
  QueryResource,
  QueryRootKey,
  QueryWith,
} from './types.js'
import { buildFieldRegistry, createQueryResourceUtils, mergeScopeFilters } from './sql.js'
import { createQueryFilterBuilder } from './filters.js'

function normalizeRequest(
  request: QueryRequest,
  defaultSearchFields: readonly string[],
  defaults?: {
    pagination?: Partial<QueryRequest['pagination']>
    sorting?: Readonly<QueryRequest['sorting']>
  },
): QueryRequest {
  const searchFields =
    request.search.fields.length > 0 ? request.search.fields : defaultSearchFields
  const defaultPageIndex = defaults?.pagination?.pageIndex ?? 1
  const defaultPageSize = defaults?.pagination?.pageSize ?? 25
  const sorting = request.sorting.length > 0 ? request.sorting : [...(defaults?.sorting ?? [])]

  return {
    ...request,
    pagination: {
      pageIndex: request.pagination.pageIndex > 0 ? request.pagination.pageIndex : defaultPageIndex,
      pageSize: request.pagination.pageSize > 0 ? request.pagination.pageSize : defaultPageSize,
    },
    sorting,
    search: {
      ...request.search,
      fields: [...searchFields],
    },
  }
}

function assertKnownFields(
  resource: QueryResource<any, any, any, any, any, any, any>,
  request: QueryRequest,
) {
  const invalidSort = request.sorting.find(({ key }) => !resource.fields.has(key))
  if (invalidSort) {
    throw new Error(
      `Unknown sorting field "${invalidSort.key}" for resource "${String(resource.key)}"`,
    )
  }

  for (const field of request.search.fields) {
    if (!resource.queryConfig.search.allowed.has(field as never)) {
      throw new Error(`Unknown search field "${field}" for resource "${String(resource.key)}"`)
    }
  }

  const stack: QueryFilterNode[] = [request.filters]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'condition') {
      if (!resource.fields.has(node.key)) {
        throw new Error(`Unknown filter field "${node.key}" for resource "${String(resource.key)}"`)
      }
      continue
    }
    stack.push(...node.children)
  }
}

function resolveQueryStrategy(
  options: DefineResourceOptions<any, any, any, any, any, any, any, any>,
) {
  return options.strategy?.query
}

function assertKnownFacetFields(
  resource: QueryResource<any, any, any, any, any, any, any>,
  facets: QueryFacetRequest[],
) {
  for (const facet of facets) {
    if (!resource.queryConfig.facets.allowed.has(facet.key as never)) {
      throw new Error(`Unknown facet field "${facet.key}" for resource "${String(resource.key)}"`)
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
  assertKnownFacetFields(resource, facets)

  if (options.strategy?.facets) {
    return options.strategy.facets({
      request,
      facets,
      context,
      resource,
      utils,
    })
  }

  return utils.resolveFacets({
    request,
    facets,
  })
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
 *     scope: (ctx, filters) => filters.and([filters.is('department.company.country', ctx.orgId)]),
 *   },
 * })
 * ```
 */
export function createQueryEngine<
  TDb extends QueryEngineConfig['db'],
  TSchema extends QueryEngineConfig['schema'],
  TRelations extends QueryEngineConfig['relations'],
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
      if (typeof relationsOrHandler === 'function') return relationsOrHandler
      return maybeHandler
    }

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
        TRow
      > & {
        relations: TRelationsConfig
      },
    ): QueryResource<TDb, TSchema, TRelations, TRoot, TRelationsConfig, TContext, TRow>
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
        relations?: undefined
      },
    ): QueryResource<TDb, TSchema, TRelations, TRoot, undefined, TContext, TRow>
    function defineResource(root: any, options: any): any {
      const relationsClause = options.relations as any
      const fieldRegistry = buildFieldRegistry(config, root, relationsClause, {
        hidden: options.query?.filters?.hidden,
        nonFilterable: options.query?.filters?.disabled,
        nonSortable: options.query?.sort?.disabled,
      })
      const allFields = Array.from(fieldRegistry.keys()).sort()
      const allowedSearchFields = new Set(
        (options.query?.search?.allowed ?? allFields).filter((field: any) =>
          fieldRegistry.has(field),
        ),
      ) as Set<any>
      const defaultFields = (
        options.query?.search?.defaults ?? Array.from(allowedSearchFields)
      ).filter((field: any) => allowedSearchFields.has(field))
      const allowedFacetFields = new Set(
        (options.query?.facets?.allowed ?? allFields).filter((field: any) =>
          fieldRegistry.has(field),
        ),
      ) as Set<any>
      const disabledSortFields = new Set(
        (options.query?.sort?.disabled ?? []).filter((field: any) => fieldRegistry.has(field)),
      ) as Set<any>
      const hiddenFilterFields = new Set(
        (options.query?.filters?.hidden ?? []).filter((field: any) => fieldRegistry.has(field)),
      ) as Set<any>
      const disabledFilterFields = new Set(
        (options.query?.filters?.disabled ?? []).filter((field: any) => fieldRegistry.has(field)),
      ) as Set<any>

      const filterBuilder = createQueryFilterBuilder<any>()

      const resource: QueryResource<any, any, any, any, any, any, any> = {
        key: root,
        relations: relationsClause,
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
          },
          facets: {
            allowed: allowedFacetFields,
          },
          defaults: {
            pagination: options.query?.defaults?.pagination,
            sorting: options.query?.sort?.defaults,
          },
        },
        query: async ({
          request,
          context,
        }: {
          request: QueryRequest
          context?: any
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context)
          const utils = createQueryResourceUtils(
            config,
            resource as QueryResource<any, any, any, any, any, any, any>,
          )
          const customQueryStrategy = resolveQueryStrategy(options)
          let response: QueryResponse<any>

          if (customQueryStrategy) {
            response = await customQueryStrategy({
              request: normalizedRequest,
              context,
              resource,
              utils,
            })
          } else {
            const idsResponse = await executeIds(normalizedRequest, context, utils)
            const rows =
              idsResponse.ids.length > 0
                ? await executeRows(normalizedRequest, idsResponse.ids, context, utils)
                : []

            response = {
              rows,
              rowCount: idsResponse.rowCount,
            }
          }

          if (
            !normalizedRequest.facets ||
            normalizedRequest.facets.length === 0 ||
            response.facets !== undefined
          ) {
            return response
          }

          const facetsResponse = await executeFacetsForResource(
            options,
            resource as QueryResource<any, any, any, any, any, any, any>,
            utils,
            normalizedRequest,
            normalizedRequest.facets,
            context,
          )

          return {
            ...response,
            facets: facetsResponse.facets,
          }
        },
        queryIds: async ({
          request,
          context,
        }: {
          request: QueryRequest
          context?: any
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context)
          const utils = createQueryResourceUtils(
            config,
            resource as QueryResource<any, any, any, any, any, any, any>,
          )
          return executeIds(normalizedRequest, context, utils)
        },
        queryRows: async ({
          request,
          ids,
          context,
        }: {
          request: QueryRequest
          ids: unknown[]
          context?: any
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context)
          const utils = createQueryResourceUtils(
            config,
            resource as QueryResource<any, any, any, any, any, any, any>,
          )
          return executeRows(normalizedRequest, ids, context, utils)
        },
        queryFacets: async ({
          request,
          facets,
          context,
        }: {
          request: QueryRequest
          facets: QueryFacetRequest[]
          context?: any
        }): Promise<any> => {
          const normalizedRequest = prepareRequest(request, context)
          const utils = createQueryResourceUtils(
            config,
            resource as QueryResource<any, any, any, any, any, any, any>,
          )
          return executeFacetsForResource(
            options,
            resource as QueryResource<any, any, any, any, any, any, any>,
            utils,
            normalizedRequest,
            facets,
            context,
          )
        },
      }

      function prepareRequest(request: QueryRequest, context: any) {
        const scopedFilters = options.query?.scope?.(context, filterBuilder)
        const normalizedRequest = normalizeRequest(
          {
            ...request,
            filters: mergeScopeFilters(scopedFilters, request.filters),
          },
          defaultFields as readonly string[],
          {
            pagination: options.query?.defaults?.pagination,
            sorting: options.query?.sort?.defaults,
          },
        )

        assertKnownFields(
          resource as QueryResource<any, any, any, any, any, any, any>,
          normalizedRequest,
        )
        return normalizedRequest
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
          })
        }

        return utils.executeIdsQuery({ request })
      }

      async function executeRows(
        request: QueryRequest,
        ids: unknown[],
        context: any,
        utils: ReturnType<typeof createQueryResourceUtils>,
      ) {
        if (options.strategy?.rows) {
          return options.strategy.rows({
            request,
            ids,
            context,
            resource,
            utils,
          })
        }

        return utils.executeRowsQuery({ ids, request })
      }

      return resource
    }

    function defineQueryResource(root: any, options: any): any {
      return defineResource(root, options)
    }

    return {
      withContext<TContext extends GenericObject>() {
        return buildEngine<TContext>()
      },
      defineScope,
      defineResource,
      defineQueryResource,
    } as QueryEngine<TDb, TSchema, TRelations, TEngineContext>
  }

  return buildEngine<Record<string, unknown>>()
}
