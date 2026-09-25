import vine from "@vinejs/vine";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { pgEnum, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { defineRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { createQueryEngine } from "../../core/index.js";
import {
  requestSchema,
  type QueryRequestVineOutput,
  type QueryRequestVineInput,
  type QueryRequestVineSchema,
} from "../index.js";

const itemStatus = pgEnum("item_status", ["active", "archived"]);
const items = pgTable("items", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 120 }).notNull(),
  status: itemStatus().notNull(),
});

const databaseSchema = { items, itemStatus };
const relations = { items: {} };
const db = {
  query: {
    items: {
      findMany: async (): Promise<Array<{ id: string; name: string; status: string }>> => [],
    },
  },
};

const engine = createQueryEngine({ db, schema: databaseSchema, relations });
const resource = engine.defineResource("items", {
  query: {
    search: { allowed: ["name", "status"], defaults: ["name"] },
    sort: { defaults: [{ key: "id", dir: "asc" }] },
    pagination: { modes: ["offset", "cursor"] },
    defaults: { pagination: { mode: "cursor", pageSize: 7, count: "none" } },
    validation: {
      maxPageSize: 20,
      maxCursorLength: 12,
      maxFilterDepth: 2,
      maxFilterNodes: 3,
      maxFacetCount: 2,
      maxFacetLimit: 4,
    },
  },
});

function validationMessages(input: unknown, vineSchema: QueryRequestVineSchema) {
  const validator = vine.compile(vineSchema);
  return validator.validate(input).then(
    () => [],
    (error: { messages?: Array<{ message: string }> }) =>
      (error.messages ?? []).map(({ message }) => message),
  );
}

describe("Vine request schema", () => {
  it("accepts a native Drizzle database and a context-scoped resource", async () => {
    const nativeRelations = defineRelations(databaseSchema);
    const nativeDatabase = drizzle.mock({ relations: nativeRelations });
    const nativeEngine = createQueryEngine({
      db: nativeDatabase,
      schema: databaseSchema,
      relations: nativeRelations,
    }).withContext<{ requesterId: string }>();
    const nativeResource = nativeEngine.defineResource("items", {
      query: { scope: (filters, context) => filters.is("id", context.requesterId) },
    });
    const validator = vine.compile(requestSchema(nativeResource));

    expect((await validator.validate({})).pagination.pageSize).toBeGreaterThan(0);
  });

  it("keeps required nested fields required in transport input types", () => {
    expectTypeOf<{ sorting: [{}] }>().not.toMatchTypeOf<QueryRequestVineInput>();
    expectTypeOf<{ filters: [{}] }>().not.toMatchTypeOf<QueryRequestVineInput>();
    expectTypeOf<{ pagination: { cursor: string } }>().not.toMatchTypeOf<QueryRequestVineInput>();
    expectTypeOf<{ pagination: { mode: "cursor" } }>().toMatchTypeOf<QueryRequestVineInput>();
    expectTypeOf<QueryRequestVineOutput["pagination"]["count"]>().toEqualTypeOf<"none" | "exact">();
  });
  it("returns a composable raw schema with normalized defaults", async () => {
    const vineSchema = requestSchema(resource);
    expectTypeOf<QueryRequestVineOutput>().toMatchTypeOf<{
      pagination: object;
      sorting: unknown[];
      filters: unknown[];
      search: object;
    }>();

    const bulk = vine.compile(
      vine.object({
        selection: vine.union([
          vine.union.if((value) => Array.isArray(value), vine.array(vine.string())),
          vine.union.else(vineSchema),
        ]),
      }),
    );

    const result = await bulk.validate({ selection: {} });
    expect(result.selection).toMatchObject({
      pagination: { mode: "cursor", pageSize: 7, count: "none", cursor: null },
      sorting: [{ key: "id", dir: "asc" }],
      filters: [],
      search: { value: "", fields: ["name"] },
    });

    await expect(
      bulk.validate({
        selection: {
          pagination: { mode: "offset", pageIndex: "1", pageSize: "10", count: "exact" },
          facets: [{ key: "status", limit: "2" }],
        },
      }),
    ).resolves.toMatchObject({
      selection: {
        pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "exact" },
        sorting: [{ key: "id", dir: "asc" }],
        filters: [],
        search: { value: "", fields: ["name"] },
        facets: [{ key: "status", limit: 2 }],
      },
    });
  });

  it("normalizes numeric query strings before applying request defaults", async () => {
    const validator = vine.compile(requestSchema(resource));

    await expect(
      validator.validate({
        pagination: { mode: "offset", pageIndex: "1", pageSize: "10", count: "exact" },
      }),
    ).resolves.toMatchObject({
      pagination: { mode: "offset", pageIndex: 1, pageSize: 10, count: "exact" },
      sorting: [{ key: "id", dir: "asc" }],
      filters: [],
      search: { value: "", fields: ["name"] },
    });

    await expect(
      validator.validate({
        pagination: { mode: "offset", pageIndex: "invalid", pageSize: "10", count: "exact" },
      }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ field: "pagination.pageIndex", rule: "number" }),
      ]),
    });
  });

  it("returns complete defaults through vine.create for an empty search", async () => {
    const validator = vine.create(requestSchema(resource));

    await expect(
      validator.validate({ search: { value: "", fields: ["name"] } }),
    ).resolves.toMatchObject({
      sorting: [{ key: "id", dir: "asc" }],
      filters: [],
      search: { value: "", fields: ["name"] },
    });
  });

  it("uses offset defaults when a supplied pagination object omits its mode", async () => {
    const validator = vine.compile(requestSchema(resource));

    await expect(validator.validate({ pagination: { pageIndex: 2 } })).resolves.toMatchObject({
      pagination: { mode: "offset", pageIndex: 2, pageSize: 7, count: "exact" },
    });
  });

  it("enforces the resolved fields, limits, and strict object contract", async () => {
    const vineSchema = requestSchema(resource, {
      allow: { sorting: ["name"], search: ["name"], facets: ["name"] },
      defaults: { sorting: [{ key: "name", dir: "asc" }] },
      limits: { maxPageSize: 5, maxFacetLimit: 2 },
    });

    await expect(
      validatorFor(vineSchema).validate({ sorting: [{ key: "id", dir: "asc" }] }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "enum" })]),
    });
    await expect(validatorFor(vineSchema).validate({ context: {} })).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "strict" })]),
    });
    await expect(
      validatorFor(vineSchema).validate({ search: { value: "x", extra: true } }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "strict" })]),
    });
    await expect(
      validatorFor(vineSchema).validate({ pagination: { pageSize: 6 } }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "max" })]),
    });
    await expect(
      validatorFor(vineSchema).validate({ facets: [{ key: "name", limit: 3 }] }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "max" })]),
    });
  });

  it("accepts null filter values and rejects deep or oversized filter trees", async () => {
    const validator = vine.compile(requestSchema(resource));
    const condition = { type: "condition", key: "status", operator: "is", value: null } as const;
    const nested = { type: "group", combinator: "and", children: [condition] } as const;
    const tooDeep = { type: "group", combinator: "and", children: [nested] } as const;

    await expect(validator.validate({ filters: [condition] })).resolves.toMatchObject({
      filters: [condition],
    });
    await expect(validator.validate({ filters: [tooDeep] })).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "query.filters.depth" })]),
    });
    await expect(
      validator.validate({ filters: [condition, condition, condition, condition] }),
    ).rejects.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ rule: "query.filters.nodes" })]),
    });
  });

  it("rejects null sections and malformed union values without replacing their errors", async () => {
    const vineSchema = requestSchema(resource);
    const invalidInputs = [
      { pagination: null },
      { pagination: "cursor" },
      { search: null },
      { filters: [null] },
    ];

    for (const input of invalidInputs) {
      await expect(validationMessages(input, vineSchema)).resolves.toHaveLength(1);
    }
  });
});

function validatorFor(vineSchema: QueryRequestVineSchema) {
  return vine.compile(vineSchema);
}
