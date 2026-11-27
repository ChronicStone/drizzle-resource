import vine from "@vinejs/vine";
import { describe, expect, it } from "vite-plus/test";
import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { createQueryEngine } from "../../core/index.js";
import { requestSchema } from "../index.js";

const items = pgTable("items", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 120 }).notNull(),
});
const db = { query: { items: { findMany: async (): Promise<Array<{ id: string }>> => [] } } };
const resource = createQueryEngine({
  db,
  schema: { items },
  relations: { items: {} },
}).defineResource("items", {
  query: {
    pagination: { modes: ["offset", "cursor"] },
    validation: { maxPageIndex: 20 },
  },
});
const validator = vine.compile(requestSchema(resource));
const limited = vine.compile(requestSchema(resource, { limits: { maxPageIndex: 5 } }));

describe("Vine count modes and page limits", () => {
  it.each(["none", "exact", "capped", "estimated"])("accepts count %s", async (count) => {
    const offset = await validator.validate({ pagination: { pageIndex: 1, pageSize: 5, count } });
    expect(offset.pagination.count).toBe(count);
    const cursor = await validator.validate({ pagination: { mode: "cursor", pageSize: 5, count } });
    expect(cursor.pagination.count).toBe(count);
  });

  it("rejects an unknown count mode", async () => {
    await expect(
      validator.validate({ pagination: { pageIndex: 1, pageSize: 5, count: "approx" } }),
    ).rejects.toThrow("Validation failure");
  });

  it("enforces maxPageIndex and lets an override only narrow it", async () => {
    await expect(
      validator.validate({ pagination: { pageIndex: 20, pageSize: 5 } }),
    ).resolves.toBeDefined();
    await expect(
      validator.validate({ pagination: { pageIndex: 21, pageSize: 5 } }),
    ).rejects.toThrow("Validation failure");
    await expect(
      limited.validate({ pagination: { pageIndex: 5, pageSize: 5 } }),
    ).resolves.toBeDefined();
    await expect(limited.validate({ pagination: { pageIndex: 6, pageSize: 5 } })).rejects.toThrow(
      "Validation failure",
    );
  });
});
