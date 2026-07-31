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
    });

    const resource = engine.defineResource("employees", {
      query: {
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
        query: async () => ({
          rows: [],
          pageInfo: exactOffsetPageInfo(0),
        }),
      },
    });

    expect(resource.fields.has("email")).toBe(false);
    expect(resource.queryConfig.search.allowed.has("email")).toBe(false);
    expect(resource.queryConfig.facets.allowed.has("email")).toBe(false);
    expect(resource.queryConfig.sort.disabled.has("fullName")).toBe(true);

    await expect(
      resource.query({
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
