import { describe, expectTypeOf, it } from "vite-plus/test";
import { integer, pgTable, uuid, varchar } from "drizzle-orm/pg-core";
import { defineRelationsPart } from "drizzle-orm";

import { createQueryEngine } from "../index.js";
import type { QueryFieldPath, QueryFilterBuilder, QueryIdsResponse } from "../index.js";

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
      }): Promise<
        Array<{
          id: string;
          fullName: string;
          department?: {
            company?: {
              name: string;
            };
          };
        }>
      > => [],
    },
  },
};

const engine = createQueryEngine({
  db,
  schema,
  relations,
}).withContext<{ orgId: string }>();

const employeeWith = {
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
} as const;

type EmployeeFieldPath = QueryFieldPath<
  typeof schema,
  typeof relations,
  "employees",
  typeof employeeWith
>;
const baseRequest = {
  pagination: {
    pageIndex: 1,
    pageSize: 25,
  },
  sorting: [],
  search: {
    value: "",
    fields: [],
  },
  context: {},
  filters: [],
};

describe("defineResource typing", () => {
  it("narrows inline scope filters to inferred field paths", () => {
    const resource = engine.defineResource("employees", {
      relations: employeeWith,
      query: {
        scope: (filters, ctx) => {
          expectTypeOf(filters).toEqualTypeOf<QueryFilterBuilder<EmployeeFieldPath>>();
          expectTypeOf(ctx).toEqualTypeOf<{ orgId: string }>();

          filters.is("fullName", "Ada");
          filters.is("department.company.name", "OpenAI");
          filters.contains("employeeSkills.skill.label", "TypeScript");

          // @ts-expect-error invalid nested field path should be rejected
          filters.is("department.company.unknown", "nope");

          return filters.and([filters.is("department.company.country", ctx.orgId)]);
        },
      },
    });

    expectTypeOf(resource.query).toBeFunction();
  });

  it("types ids and rows executors from the row shape", () => {
    const resource = engine.defineResource<
      "employees",
      typeof employeeWith,
      { orgId: string },
      { id: string; fullName: string }
    >("employees", {
      relations: employeeWith,
      strategy: {
        ids: async () => ({
          ids: ["emp_1"],
          rowCount: 1,
        }),
        rows: async ({ ids }) => ids.map((id) => ({ id, fullName: "Ada" })),
      },
    });

    expectTypeOf(resource.queryIds).returns.resolves.toEqualTypeOf<QueryIdsResponse<string>>();
    expectTypeOf(resource.queryRows).returns.resolves.toEqualTypeOf<
      Array<{ id: string; fullName: string }>
    >();
  });

  it("defaults query row types from the drizzle findMany shape", () => {
    const resource = engine.defineResource("employees", {
      relations: employeeWith,
      strategy: {
        ids: async () => ({
          ids: ["emp_1"],
          rowCount: 1,
        }),
      },
    });

    expectTypeOf(resource.queryRows).returns.resolves.toMatchTypeOf<
      Array<{
        id: string;
        fullName: string;
        department?: {
          company?: {
            name: string;
          };
        };
      }>
    >();
    expectTypeOf(resource.query).returns.resolves.toMatchTypeOf<{
      rows: Array<{
        id: string;
        fullName: string;
        department?: {
          company?: {
            name: string;
          };
        };
      }>;
      rowCount: number;
      facets?: Array<{
        key: string;
        options: Array<{
          value: unknown;
          count: number;
        }>;
        nextCursor?: string | null;
        total?: number;
      }>;
    }>();

    const queryPromise = resource.query({
      request: baseRequest,
      context: {
        orgId: "fr",
      },
    });

    expectTypeOf(queryPromise).toMatchTypeOf<
      Promise<{
        rows: Array<{
          id: string;
          fullName: string;
          department?: {
            company?: {
              name: string;
            };
          };
        }>;
        rowCount: number;
        facets?: Array<{
          key: string;
          options: Array<{
            value: unknown;
            count: number;
          }>;
          nextCursor?: string | null;
          total?: number;
        }>;
      }>
    >();
  });

  it("keeps defineQueryResource typed as an alias of defineResource", () => {
    const resource = engine.defineQueryResource("employees", {
      relations: employeeWith,
      strategy: {
        ids: async () => ({
          ids: ["emp_1"],
          rowCount: 1,
        }),
      },
    });

    expectTypeOf(resource.queryRows).returns.resolves.toMatchTypeOf<
      Array<{
        id: string;
        fullName: string;
        department?: {
          company?: {
            name: string;
          };
        };
      }>
    >();
  });

  it("keeps defineScope compatible for reusable root-only scopes", () => {
    const scope = engine.defineScope("employees", (ctx, filters) => {
      expectTypeOf(ctx).toEqualTypeOf<{ orgId: string }>();

      filters.is("fullName", "Ada");
      filters.contains("email", "@example.com");

      // @ts-expect-error nested relation paths should not be available without relations
      filters.is("department.company.name", "OpenAI");

      return filters.and([filters.is("fullName", "Ada")]);
    });

    expectTypeOf(scope).toBeFunction();
  });

  it("accepts sort defaults without literal assertions", () => {
    const resource = engine.defineResource("employees", {
      relations: employeeWith,
      query: {
        sort: {
          defaults: [{ key: "fullName", dir: "desc" }],
        },
      },
    });

    expectTypeOf(resource.query).toBeFunction();
  });
});
