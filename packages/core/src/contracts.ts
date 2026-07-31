import type {
  QueryRequestContract,
  QueryRequestSchemaOverride,
  QueryResource,
  ResourceQueryDefaultsConfig,
  ResourceQueryValidationConfig,
} from "./types.js";

export const defaultQueryValidation: Required<ResourceQueryValidationConfig> = {
  maxPageSize: 100,
  maxCursorLength: 2048,
  maxFilterDepth: 5,
  maxFilterNodes: 50,
  maxFacetCount: 10,
  maxFacetLimit: 50,
};

function resolveLimits(
  resourceLimits: Required<ResourceQueryValidationConfig>,
  override?: ResourceQueryValidationConfig,
): Required<ResourceQueryValidationConfig> {
  return {
    maxPageSize: Math.min(resourceLimits.maxPageSize, override?.maxPageSize ?? Infinity),
    maxCursorLength: Math.min(
      resourceLimits.maxCursorLength,
      override?.maxCursorLength ?? Infinity,
    ),
    maxFilterDepth: Math.min(resourceLimits.maxFilterDepth, override?.maxFilterDepth ?? Infinity),
    maxFilterNodes: Math.min(resourceLimits.maxFilterNodes, override?.maxFilterNodes ?? Infinity),
    maxFacetCount: Math.min(resourceLimits.maxFacetCount, override?.maxFacetCount ?? Infinity),
    maxFacetLimit: Math.min(resourceLimits.maxFacetLimit, override?.maxFacetLimit ?? Infinity),
  };
}

function restrict<T extends string>(base: Iterable<T>, allowed?: readonly string[]): Set<T> {
  const baseSet = new Set(base);
  return allowed === undefined
    ? baseSet
    : new Set(allowed.filter((field): field is T => baseSet.has(field as T)));
}

function mergeDefaults(
  defaults: ResourceQueryDefaultsConfig,
  override?: ResourceQueryDefaultsConfig,
): ResourceQueryDefaultsConfig {
  return {
    ...defaults,
    ...override,
    pagination: {
      ...defaults.pagination,
      ...override?.pagination,
    },
    sorting: override?.sorting ?? defaults.sorting,
  };
}

/** Resolve the validator-facing contract for a resource without widening its policy. */
export function resolveQueryRequestContract(
  resource: QueryResource<any, any, any, any, any, any, any>,
  override?: QueryRequestSchemaOverride,
): QueryRequestContract {
  const filters = restrict(resource.fields.keys(), override?.allow?.filters);
  const sorting = restrict(
    Array.from(resource.fields.values())
      .filter((entry) => entry.sortable)
      .map((entry) => entry.path),
    override?.allow?.sorting,
  );
  const search = restrict(resource.queryConfig.search.allowed, override?.allow?.search);
  const facets = restrict(resource.queryConfig.facets.allowed, override?.allow?.facets);
  const pagination = restrict(resource.queryConfig.pagination.modes, override?.allow?.pagination);
  const defaults = mergeDefaults(resource.queryConfig.defaults, override?.defaults);

  for (const descriptor of defaults.sorting ?? []) {
    if (!sorting.has(descriptor.key)) {
      throw new Error(
        `Default sorting field "${descriptor.key}" is not allowed for resource "${String(resource.key)}"`,
      );
    }
  }
  const defaultPaginationMode = defaults.pagination?.mode ?? "offset";
  if (!pagination.has(defaultPaginationMode)) {
    throw new Error(
      `Default pagination mode "${defaultPaginationMode}" is not allowed for resource "${String(resource.key)}"`,
    );
  }

  return {
    filters,
    sorting,
    search,
    facets,
    pagination,
    defaults,
    limits: resolveLimits(resource.queryConfig.validation, override?.limits),
  };
}
