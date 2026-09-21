import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vite-plus/test";
import { createQueryEngine } from "../index.js";
import type { QueryRequest, QueryScanBatch } from "../index.js";

const items = pgTable("items", { id: integer().primaryKey(), name: text().notNull() });
const db = { query: { items: { findMany: async () => [{ id: 1, name: "One" }] } } };

describe("portable resource scans", () => {
  it("preserves custom strategies, scopes once and requests an exact count only once", async () => {
    const requests: QueryRequest[] = [];
    let scopes = 0;
    const resource = createQueryEngine({ db, schema: { items }, relations: {} }).defineResource(
      "items",
      {
        query: {
          scope: (filters) => {
            scopes += 1;
            return filters.gt("id", 0);
          },
        },
        strategy: {
          query: async ({ request }) => {
            requests.push(request);
            const pageIndex =
              request.pagination.mode === "offset" ? request.pagination.pageIndex : 1;
            return {
              rows: [{ id: pageIndex, name: String(pageIndex) }],
              pageInfo: {
                mode: "offset",
                pageIndex,
                pageSize: 1,
                hasNextPage: pageIndex < 3,
                ...(request.pagination.count === "exact"
                  ? ({ count: "exact", rowCount: 3 } as const)
                  : ({ count: "none", rowCount: null } as const)),
              },
            };
          },
        },
      },
    );
    const ids = await resource.scan({ batchSize: 1, count: "exact" }, async (batches) => {
      const selected: number[] = [];
      for await (const batch of batches) {
        expect(batch.totalRows).toBe(3);
        selected.push(...batch.rows.map(({ id }) => id));
      }
      return selected;
    });
    expect(ids).toEqual([1, 2, 3]);
    expect(scopes).toBe(1);
    expect(requests.map(({ pagination }) => pagination.count)).toEqual(["exact", "none", "none"]);
    expect(requests.every(({ filters }) => filters.length === 1)).toBe(true);
  });

  it("does not fetch ahead and closes an iterator retained after the callback", async () => {
    let requests = 0;
    const resource = createQueryEngine({ db, schema: { items }, relations: {} }).defineResource(
      "items",
      {
        strategy: {
          query: async () => {
            requests += 1;
            return {
              rows: [{ id: 1, name: "One" }],
              pageInfo: {
                mode: "offset",
                pageSize: 1,
                pageIndex: 1,
                hasNextPage: true,
                count: "none",
                rowCount: null,
              },
            };
          },
        },
      },
    );
    const iterator = await resource.scan({}, async (batches) => {
      expect(requests).toBe(0);
      const selected = batches[Symbol.asyncIterator]();
      expect((await selected.next()).done).toBe(false);
      expect(requests).toBe(1);
      return selected;
    });
    expect((await iterator.next()).done).toBe(true);
    expect(requests).toBe(1);
  });

  it("rejects invalid batches and already-aborted scans before starting work", async () => {
    const resource = createQueryEngine({ db, schema: { items }, relations: {} }).defineResource(
      "items",
      {},
    );
    async function consume(_batches: AsyncIterable<QueryScanBatch<{ id: number; name: string }>>) {
      throw new Error("Must not consume");
    }
    for (const batchSize of [0, -1, 1.5, Infinity, NaN]) {
      await expect(resource.scan({ batchSize }, consume)).rejects.toThrow("positive safe integer");
    }
    await expect(
      resource.scan({ signal: AbortSignal.abort(new Error("Cancelled")) }, consume),
    ).rejects.toThrow("Cancelled");
    await expect(
      resource.scan({ request: { sorting: [{ key: "missing", dir: "asc" }] } }, consume),
    ).rejects.toThrow(/missing/);
  });
});
