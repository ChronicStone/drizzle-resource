/**
 * Databases that `checkIndexes({ live: true })` hands to a resource to find out which statement
 * it would run for a page. The page query goes to the hook instead of the database, and the
 * hook answers with the rows it would have returned. Keyed by database object, so a request
 * made with any other database object is never affected.
 */
export const pageQueryHooks = new WeakMap<object, (query: unknown) => Promise<unknown[]>>();
