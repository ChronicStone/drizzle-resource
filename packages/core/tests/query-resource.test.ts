import { describe, expect, it, vi } from "vite-plus/test";
import { integer, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { defineRelationsPart } from "drizzle-orm";

import { createQueryEngine } from "../index.js";
import type { QueryRequest } from "../index.js";

const companies = pgTable("companies", {
  id: uuid().defaultRandom().primaryKey(),
  name: varchar({ length: 255 }).notNull(),
  country: varchar({ length: 100 }),
});

const departments = pgTable("departments", {
  id: uuid().defaultRandom().primaryKey(),
  companyId: uuid()
    .notNull()
    .references(() => companies.id),
  name: varchar({ length: 255 }).notNull(),
  budget: integer(),
});

const employees = pgTable("employees", {
  id: uuid().defaultRandom().primaryKey(),
  departmentId: uuid()
    .notNull()
    .references(() => departments.id),
  fullName: varchar({ length: 255 }).notNull(),
  email: varchar({ length: 255 }).notNull(),
});

const skills = pgTable("skills", {
  id: uuid().defaultRandom().primaryKey(),
  label: varchar({ length: 100 }).notNull(),
});

const employeeSkills = pgTable("employee_skills", {
  employeeId: uuid()
    .notNull()
    .references(() => employees.id),
  skillId: uuid()
    .notNull()
    .references(() => skills.id),
});

const schema = {
  companies,
  departments,
  employees,
  employeeSkills,
  skills,
};

const relations = defineRelationsPart(
  schema,
  ({
    companies: companiesTable,
    departments: departmentsTable,
    employees: employeesTable,
    employeeSkills: employeeSkillsTable,
    skills: skillsTable,
    many,
    one,
  }) => ({
    companies: {
      departments: many.departments({
        from: companiesTable.id,
        to: departmentsTable.companyId,
      }),
    },
    departments: {
      company: one.companies({
        from: departmentsTable.companyId,
        to: companiesTable.id,
        optional: false,
      }),
      employees: many.employees({
        from: departmentsTable.id,
        to: employeesTable.departmentId,
      }),
    },
    employees: {
      department: one.departments({
        from: employeesTable.departmentId,
        to: departmentsTable.id,
        optional: false,
      }),
      employeeSkills: many.employeeSkills({
        from: employeesTable.id,
        to: employeeSkillsTable.employeeId,
      }),
    },
    employeeSkills: {
      employee: one.employees({
        from: employeeSkillsTable.employeeId,
        to: employeesTable.id,
        optional: false,
      }),
      skill: one.skills({
        from: employeeSkillsTable.skillId,
        to: skillsTable.id,
        optional: false,
      }),
    },
    skills: {
      employeeSkills: many.employeeSkills({
        from: skillsTable.id,
        to: employeeSkillsTable.skillId,
      }),
    },
  }),
);

describe("defineResource", () => {
  const exactOffsetPageInfo = (rowCount: number, pageIndex = 1, pageSize = 25) => ({
    mode: "offset" as const,
    pageIndex,
    pageSize,
    hasNextPage: pageIndex * pageSize < rowCount,
    count: "exact" as const,
    rowCount,
  });
  const baseRequest: QueryRequest = {
    pagination: {
      mode: "offset",
      pageIndex: 1,
      pageSize: 25,
      count: "exact",
    },
    sorting: [],
    search: {
      value: "",
      fields: [],
    },
    context: {},
    filters: [],
  };

  it("merges scope filters and defaults empty search fields", async () => {
    let capturedRequest: QueryRequest | undefined;

    const db = {
      query: {
        employees: {
          findMany: async (_args?: {
            with?: {
              department?: {
                with?: {
                  company?: true;
                };
              };
              employeeSkills?: {
                with?: {
                  skill?: true;
                };
              };
            };
          }) => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    }).withContext<{ orgId: string }>();

    void engine.defineResource("employees", {
      relations: {
        department: {
          with: {
            company: true,
          },
        },
        employeeSkills: {
          with: {
            skill: true,
          },
        },
      },
      query: {
        search: {
          defaults: ["fullName", "department.company.name"],
        },
      },
      strategy: {
        query: async ({ request }) => {
          capturedRequest = request;
          return {
            rows: [],
            pageInfo: exactOffsetPageInfo(0),
          };
        },
      },
    });

    const scopedResource = engine.defineResource("employees", {
      relations: {
        department: {
          with: {
            company: true,
          },
        },
        employeeSkills: {
          with: {
            skill: true,
          },
        },
      },
      query: {
        scope: (filters, ctx) => filters.and([filters.is("department.company.country", ctx.orgId)]),
        search: {
          defaults: ["fullName", "department.company.name"],
        },
      },
      strategy: {
        query: async ({ request }) => {
          capturedRequest = request;
          return {
            rows: [],
            pageInfo: exactOffsetPageInfo(0),
          };
        },
      },
    });

    await scopedResource.query({
      request: {
        ...baseRequest,
        search: {
          value: "ada",
          fields: [],
        },
        filters: [
          {
            type: "condition",
            key: "employeeSkills.skill.label",
            operator: "contains",
            value: "typescript",
          },
        ],
      },
      context: {
        orgId: "France",
      },
    });

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.search.fields).toEqual(["fullName", "department.company.name"]);
    expect(capturedRequest?.filters).toHaveLength(2);
    expect(capturedRequest?.filters[0]).toEqual({
      type: "group",
      combinator: "and",
      children: [
        {
          type: "condition",
          key: "department.company.country",
          operator: "is",
          value: "France",
        },
      ],
    });
  });

  it("normalizes a search value omitted by a transport boundary", async () => {
    let capturedRequest: QueryRequest | undefined;

    const engine = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    });
    const resource = engine.defineResource("employees", {
      query: {
        search: {
          defaults: ["fullName"],
        },
      },
      strategy: {
        query: async ({ request }) => {
          capturedRequest = request;
          return {
            rows: [],
            pageInfo: exactOffsetPageInfo(0),
          };
        },
      },
    });

    await resource.query({
      request: {
        ...baseRequest,
        search: {
          fields: ["fullName"],
        },
      } as QueryRequest,
      context: {},
    });

    expect(capturedRequest?.search).toEqual({
      fields: ["fullName"],
      value: "",
    });
  });

  it("finds one scoped row by id without a collection request", async () => {
    const requests: QueryRequest[] = [];
    const engine = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).withContext<{ country: string }>();
    const resource = engine.defineResource("employees", {
      relations: {
        department: { with: { company: true } },
      },
      query: {
        scope: (filters, context) => filters.is("department.company.country", context.country),
        pagination: { modes: ["cursor"] },
        defaults: { pagination: { mode: "cursor" } },
      },
      strategy: {
        query: async ({ request }) => {
          requests.push(request);
          const id = request.filters.find(
            (filter) => filter.type === "condition" && filter.key === "id",
          );

          return {
            rows:
              id?.type === "condition" && id.value === "emp_1"
                ? [{ id: "emp_1", fullName: "Ada" }]
                : [],
            pageInfo: {
              mode: "cursor",
              pageSize: 1,
              hasNextPage: false,
              count: "none",
              nextCursor: null,
            },
          };
        },
      },
    });

    await expect(
      resource.findById({ id: "emp_1", context: { country: "France" } }),
    ).resolves.toEqual({ id: "emp_1", fullName: "Ada" });
    await expect(
      resource.findById({ id: "missing", context: { country: "France" } }),
    ).resolves.toBeNull();

    expect(requests[0]?.pagination).toEqual({
      mode: "cursor",
      cursor: null,
      pageSize: 1,
      count: "none",
    });
    expect(requests[0]?.sorting).toEqual([{ key: "id", dir: "asc" }]);
    expect(requests[0]?.filters).toEqual([
      {
        type: "condition",
        key: "department.company.country",
        operator: "is",
        value: "France",
      },
      { type: "condition", key: "id", operator: "is", value: "emp_1" },
    ]);
  });

  it("hydrates query and id results with their configured relation profiles", async () => {
    const hydratedRelations: unknown[] = [];
    const db = {
      query: {
        employees: {
          findMany: async ({ with: relationsToLoad }: { with?: unknown }) => {
            hydratedRelations.push(relationsToLoad);
            return [{ id: "emp_1", fullName: "Ada" }];
          },
        },
      },
    };
    const engine = createQueryEngine({ db, schema, relations });
    const resource = engine.defineResource("employees", {
      relations: {
        department: { with: { company: true } },
        employeeSkills: { with: { skill: true } },
      },
      hydration: {
        profiles: {
          list: { department: true },
          detail: {
            department: { with: { company: true } },
            employeeSkills: { with: { skill: true } },
          },
        },
        defaults: {
          query: "list",
          findById: "detail",
        },
      },
      strategy: {
        ids: async () => ({ ids: ["emp_1"], pageInfo: exactOffsetPageInfo(1) }),
      },
    });

    await resource.query({ request: baseRequest });
    await resource.findById({ id: "emp_1" });
    await resource.findById({ id: "emp_1", load: "list" });
    await resource.query({
      request: baseRequest,
      load: { employeeSkills: { with: { skill: true } } },
    });
    await resource.queryRows({
      request: baseRequest,
      ids: ["emp_1"],
      load: "detail",
    });

    expect(hydratedRelations).toEqual([
      { department: true },
      {
        department: { with: { company: true } },
        employeeSkills: { with: { skill: true } },
      },
      { department: true },
      { employeeSkills: { with: { skill: true } } },
      {
        department: { with: { company: true } },
        employeeSkills: { with: { skill: true } },
      },
    ]);
  });

  it("passes resolved hydration relations through custom query strategies", async () => {
    const selectedRelations: unknown[] = [];
    const engine = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    });
    const resource = engine.defineResource("employees", {
      relations: { department: { with: { company: true } } },
      hydration: {
        profiles: {
          list: { department: true },
          detail: { department: { with: { company: true } } },
        },
        defaults: { query: "list" },
      },
      strategy: {
        query: async ({ relations: relationsToLoad }) => {
          selectedRelations.push(relationsToLoad);
          return { rows: [], pageInfo: exactOffsetPageInfo(0) };
        },
      },
    });

    await resource.query({ request: baseRequest });
    await resource.query({ request: baseRequest, load: "detail" });

    expect(selectedRelations).toEqual([
      { department: true },
      { department: { with: { company: true } } },
    ]);
  });

  it("rejects hydration outside the declared resource relation graph", async () => {
    const engine = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    });

    expect(() =>
      engine.defineResource("employees", {
        relations: { department: true },
        hydration: {
          profiles: {
            invalid: { employeeSkills: true },
          },
        },
      } as any),
    ).toThrow('Unknown hydration relation "invalid.employeeSkills"');

    const resource = engine.defineResource("employees", {
      relations: { department: true },
      strategy: {
        query: async () => ({ rows: [], pageInfo: exactOffsetPageInfo(0) }),
      },
    });

    await expect(
      resource.query({ request: baseRequest, load: "unknown" as never }),
    ).rejects.toThrow('Unknown hydration profile "unknown" for resource "employees"');
  });

  it("returns requested facets from query while keeping queryFacets available", async () => {
    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const resource = engine.defineResource("employees", {
      strategy: {
        facets: async ({ facets }) => ({
          facets: facets.map((facet) => ({
            key: facet.key,
            options: [
              {
                value: `${facet.key}:value`,
                count: 3,
              },
            ],
            total: 1,
          })),
        }),
        query: async () => ({
          rows: [{ id: "emp_1" }],
          pageInfo: exactOffsetPageInfo(1),
        }),
      },
    });

    const request: QueryRequest = {
      ...baseRequest,
      facets: [
        {
          key: "fullName",
        },
      ],
    };

    const queryResult = await resource.query({
      request,
    });

    expect(queryResult.rows).toEqual([{ id: "emp_1" }]);
    expect(queryResult.pageInfo.rowCount).toBe(1);
    expect(queryResult.facets).toEqual([
      {
        key: "fullName",
        options: [
          {
            value: "fullName:value",
            count: 3,
          },
        ],
        total: 1,
      },
    ]);

    const facetsResult = await resource.queryFacets({
      request: {
        ...request,
        facets: undefined,
      },
      facets: [
        {
          key: "fullName",
        },
      ],
    });

    expect(facetsResult.facets).toEqual(queryResult.facets);
  });

  it("exposes ids-only queries and defaults row hydration from ids", async () => {
    const findManyCalls: Array<{ where?: { id?: { in?: string[] } } }> = [];

    const db = {
      query: {
        employees: {
          findMany: async (args?: {
            where?: {
              id?: {
                in?: string[];
              };
            };
            with?: {
              department?: {
                with?: {
                  company?: true;
                };
              };
            };
          }) => {
            findManyCalls.push(args ?? {});
            return [
              { id: "emp_2", fullName: "Grace" },
              { id: "emp_1", fullName: "Ada" },
            ];
          },
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const resource = engine.defineResource("employees", {
      relations: {
        department: {
          with: {
            company: true,
          },
        },
      },
      strategy: {
        ids: async () => ({
          ids: ["emp_1", "emp_2", "emp_1"],
          pageInfo: exactOffsetPageInfo(42),
        }),
      },
    });

    const idsResult = await resource.queryIds({
      request: baseRequest,
    });

    expect(idsResult).toEqual({
      ids: ["emp_1", "emp_2", "emp_1"],
      pageInfo: exactOffsetPageInfo(42),
    });

    const rows = await resource.queryRows({
      request: baseRequest,
      ids: idsResult.ids,
    });

    expect(rows).toEqual([
      { id: "emp_1", fullName: "Ada" },
      { id: "emp_2", fullName: "Grace" },
    ]);
    expect(findManyCalls[0]?.where?.id?.in).toEqual(["emp_1", "emp_2"]);

    const queryResult = await resource.query({
      request: baseRequest,
    });

    expect(queryResult).toEqual({
      rows: [
        { id: "emp_1", fullName: "Ada" },
        { id: "emp_2", fullName: "Grace" },
      ],
      pageInfo: exactOffsetPageInfo(42),
    });
  });

  it("normalizes pagination and sorting defaults before invoking strategies", async () => {
    let capturedRequest: QueryRequest | undefined;

    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const resource = engine.defineResource("employees", {
      query: {
        sort: {
          defaults: [{ key: "id", dir: "desc" }],
        },
        defaults: {
          pagination: {
            pageIndex: 3,
            pageSize: 10,
          },
        },
      },
      strategy: {
        ids: async ({ request }) => {
          capturedRequest = request;
          return {
            ids: [],
            pageInfo: exactOffsetPageInfo(0, 3, 10),
          };
        },
      },
    });

    await resource.query({
      request: {
        ...baseRequest,
        pagination: {
          pageIndex: 0,
          pageSize: -1,
        },
        sorting: [],
      },
    });

    expect(capturedRequest).toMatchObject({
      pagination: {
        mode: "offset",
        pageIndex: 3,
        pageSize: 10,
        count: "exact",
      },
      sorting: [{ key: "id", dir: "desc" }],
    });
  });

  it("normalizes cursor pagination with a stable id tiebreaker and optional exact count", async () => {
    const capturedRequests: QueryRequest[] = [];
    const resource = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).defineResource("employees", {
      query: {
        pagination: { modes: ["offset", "cursor"] },
        sort: { defaults: [{ key: "fullName", dir: "desc" }] },
      },
      strategy: {
        ids: async ({ request }) => {
          capturedRequests.push(request);
          const countInfo =
            request.pagination.count === "exact"
              ? ({ count: "exact", rowCount: 42 } as const)
              : ({ count: "none", rowCount: null } as const);
          return {
            ids: [],
            pageInfo: {
              mode: "cursor",
              pageSize: request.pagination.pageSize,
              nextCursor: null,
              ...countInfo,
            },
          };
        },
      },
    });

    await resource.query({
      request: {
        ...baseRequest,
        pagination: { mode: "cursor", pageSize: 10 },
        sorting: [],
      },
    });
    await resource.query({
      request: {
        ...baseRequest,
        pagination: { mode: "cursor", pageSize: 10, count: "exact" },
        sorting: [{ key: "fullName", dir: "asc" }],
      },
    });

    expect(capturedRequests[0]).toMatchObject({
      pagination: { mode: "cursor", cursor: null, pageSize: 10, count: "none" },
      sorting: [
        { key: "fullName", dir: "desc" },
        { key: "id", dir: "desc" },
      ],
    });
    expect(capturedRequests[1]).toMatchObject({
      pagination: { mode: "cursor", cursor: null, pageSize: 10, count: "exact" },
      sorting: [
        { key: "fullName", dir: "asc" },
        { key: "id", dir: "asc" },
      ],
    });
  });

  it("rejects cursor mode unless the resource exposes it", async () => {
    const resource = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).defineResource("employees", {
      strategy: {
        query: async () => ({ rows: [], pageInfo: exactOffsetPageInfo(0) }),
      },
    });

    await expect(
      resource.query({
        request: {
          ...baseRequest,
          pagination: { mode: "cursor", pageSize: 10 },
        },
      }),
    ).rejects.toThrow('Pagination mode "cursor" is not allowed for resource "employees"');
  });

  it("rejects unknown sorting, search, filter, and facet fields", async () => {
    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const resource = engine.defineResource("employees", {
      relations: {
        department: {
          with: {
            company: true,
          },
        },
      },
      strategy: {
        query: async () => ({
          rows: [],
          pageInfo: exactOffsetPageInfo(0),
        }),
      },
    });

    await expect(
      resource.query({
        request: {
          ...baseRequest,
          sorting: [{ key: "unknown", dir: "asc" }],
        },
      }),
    ).rejects.toThrow('Unknown sorting field "unknown" for resource "employees"');

    await expect(
      resource.query({
        request: {
          ...baseRequest,
          search: {
            value: "ada",
            fields: ["unknown"],
          },
        },
      }),
    ).rejects.toThrow('Unknown search field "unknown" for resource "employees"');

    await expect(
      resource.query({
        request: {
          ...baseRequest,
          pagination: { pageIndex: 1, pageSize: 10 },
          filters: [
            {
              type: "condition",
              key: "unknown",
              operator: "is",
              value: "Ada",
            },
          ],
        },
      }),
    ).rejects.toThrow('Unknown filter field "unknown" for resource "employees"');

    await expect(
      resource.queryFacets({
        request: baseRequest,
        facets: [{ key: "unknown" }],
      }),
    ).rejects.toThrow('Unknown facet field "unknown" for resource "employees"');
  });

  it("keeps hidden fields out of the public resource registry and runtime allowances", async () => {
    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    }).withContext<{ email: string }>();

    let scopedFilters: QueryRequest["filters"] = [];

    const resource = engine.defineResource("employees", {
      query: {
        scope: (filters, context) => filters.is("email", context.email),
        search: {
          allowed: ["fullName", "email"],
        },
        facets: {
          allowed: ["fullName", "email"],
        },
        filters: {
          hidden: ["email"],
        },
        sort: {
          disabled: ["fullName"],
        },
      },
      strategy: {
        query: async ({ request, utils }) => {
          scopedFilters = request.filters;
          utils.compileFilterNode(request.filters[0]!);

          return {
            rows: [],
            pageInfo: exactOffsetPageInfo(0),
          };
        },
      },
    });

    expect(resource.fields.has("email")).toBe(false);
    expect(resource.queryConfig.search.allowed.has("email")).toBe(false);
    expect(resource.queryConfig.facets.allowed.has("email")).toBe(false);
    expect(resource.queryConfig.sort.disabled.has("fullName")).toBe(true);

    await expect(
      resource.query({
        context: { email: "ada@example.com" },
        request: baseRequest,
      }),
    ).resolves.toMatchObject({ rows: [] });
    expect(scopedFilters).toEqual([
      {
        type: "condition",
        key: "email",
        operator: "is",
        value: "ada@example.com",
      },
    ]);

    await expect(
      resource.query({
        context: { email: "ada@example.com" },
        request: {
          ...baseRequest,
          facets: [{ key: "email" }],
        },
      }),
    ).rejects.toThrow('Unknown facet field "email" for resource "employees"');

    await expect(
      resource.query({
        context: { email: "ada@example.com" },
        request: {
          ...baseRequest,
          pagination: { pageIndex: 1, pageSize: 10 },
          filters: [
            {
              type: "condition",
              key: "email",
              operator: "contains",
              value: "@example.com",
            },
          ],
        },
      }),
    ).rejects.toThrow('Unknown filter field "email" for resource "employees"');
  });

  it("enforces configured request limits even without an integration schema", async () => {
    const resource = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).defineResource("employees", {
      query: {
        validation: { maxPageSize: 10, maxFilterDepth: 1, maxFacetLimit: 5 },
      },
      strategy: {
        query: async () => ({ rows: [], pageInfo: exactOffsetPageInfo(0) }),
      },
    });

    await expect(
      resource.query({ request: { ...baseRequest, pagination: { pageIndex: 1, pageSize: 11 } } }),
    ).rejects.toThrow("Page size cannot exceed 10");
    await expect(
      resource.query({
        request: {
          ...baseRequest,
          pagination: { pageIndex: 1, pageSize: 10 },
          filters: [
            {
              type: "group",
              combinator: "and",
              children: [{ type: "group", combinator: "and", children: [] }],
            },
          ],
        },
      }),
    ).rejects.toThrow("Filter tree cannot exceed 1 levels");
    await expect(
      resource.query({
        request: {
          ...baseRequest,
          pagination: { pageIndex: 1, pageSize: 10 },
          facets: [{ key: "fullName", limit: 6 }],
        },
      }),
    ).rejects.toThrow("Facet limit cannot exceed 5");
  });

  it("allows trusted server executions to raise the page-size limit", async () => {
    const requests: QueryRequest[] = [];
    const resource = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).defineResource("employees", {
      query: {
        validation: { maxPageSize: 10 },
      },
      strategy: {
        ids: async ({ request }) => {
          requests.push(request);
          return { ids: [], pageInfo: exactOffsetPageInfo(0, 1, request.pagination.pageSize) };
        },
      },
    });
    const request = {
      ...baseRequest,
      pagination: { pageIndex: 1, pageSize: 50 },
    };

    await expect(resource.queryIds({ request })).rejects.toThrow("Page size cannot exceed 10");

    await resource.queryIds({
      request,
      execution: { maxPageSize: 50 },
    });

    expect(requests[0]?.pagination.pageSize).toBe(50);
    expect(resource.queryConfig.validation.maxPageSize).toBe(10);
  });

  it("rejects invalid trusted execution page-size limits", async () => {
    const resource = createQueryEngine({
      db: { query: { employees: { findMany: async () => [] } } },
      schema,
      relations,
    }).defineResource("employees", {});

    await expect(
      resource.queryIds({ request: baseRequest, execution: { maxPageSize: 0 } }),
    ).rejects.toThrow("Execution max page size must be a positive safe integer");
  });

  it("skips the facet strategy when the main query strategy already returns facets", async () => {
    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const facetsStrategy = vi.fn<() => Promise<{ facets: [] }>>(async () => ({
      facets: [],
    }));

    const resource = engine.defineResource("employees", {
      strategy: {
        facets: facetsStrategy,
        query: async () => ({
          rows: [{ id: "emp_1" }],
          pageInfo: exactOffsetPageInfo(1),
          facets: [
            {
              key: "fullName",
              options: [{ value: "Ada", count: 1 }],
            },
          ],
        }),
      },
    });

    const result = await resource.query({
      request: {
        ...baseRequest,
        facets: [{ key: "fullName" }],
      },
    });

    expect(result.facets).toEqual([
      {
        key: "fullName",
        options: [{ value: "Ada", count: 1 }],
      },
    ]);
    expect(facetsStrategy).not.toHaveBeenCalled();
  });

  it("keeps defineQueryResource as a fully functional alias of defineResource", async () => {
    const db = {
      query: {
        employees: {
          findMany: async () => [],
        },
      },
    };

    const engine = createQueryEngine({
      db,
      schema,
      relations,
    });

    const resource = engine.defineQueryResource("employees", {
      strategy: {
        query: async () => ({
          rows: [{ id: "emp_1" }],
          pageInfo: exactOffsetPageInfo(1),
        }),
      },
    });

    await expect(
      resource.query({
        request: baseRequest,
      }),
    ).resolves.toEqual({
      rows: [{ id: "emp_1" }],
      pageInfo: exactOffsetPageInfo(1),
    });
  });
});
