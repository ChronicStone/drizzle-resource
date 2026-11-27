import type {
  QueryFacetRequest,
  QueryFacetResult,
  QueryFacetsResponse,
  QueryFacetsStrategyResponse,
  QueryPageCount,
} from "./types.js";

/** Whether a count says "more rows match than the cap reads", which `facets.whenCapped` acts on. */
export function isAboveCap(count: QueryPageCount, cap: number): boolean {
  // A count that timed out is at least as big as one that hit the cap.
  if (count.count === "none") return count.reason === "timeout";
  if (count.count === "capped") return !count.exact;
  if (count.count === "estimated") return count.rowCount > cap;
  return false;
}

/** Facets that were not computed because the count hit the cap. */
export function skippedFacets(facets: readonly QueryFacetRequest[]): QueryFacetResult[] {
  return facets.map((facet) => ({
    key: facet.key,
    status: "skipped" as const,
    reason: "above-cap" as const,
    options: [],
  }));
}

/** Facets whose statement exceeded `timeouts.facets`. */
export function timedOutFacet(key: string): QueryFacetResult {
  return { key, status: "timeout", options: [] };
}

/** Give a custom strategy's facets the `status` every facet result carries. */
export function withFacetStatus(response: QueryFacetsStrategyResponse): QueryFacetsResponse {
  return {
    ...response,
    facets: response.facets.map((facet) => ({ ...facet, status: facet.status ?? "ok" })),
  } as QueryFacetsResponse;
}
