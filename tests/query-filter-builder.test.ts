import { describe, expect, it } from "vitest";

import { createQueryFilterBuilder } from "../index.js";

describe("createQueryFilterBuilder", () => {
  it("builds condition helpers with the expected operator payloads", () => {
    const filters = createQueryFilterBuilder<"name" | "createdAt">();

    expect(filters.contains("name", "Ada")).toEqual({
      type: "condition",
      key: "name",
      operator: "contains",
      value: "Ada",
    });
    expect(filters.is("name", "Ada")).toEqual({
      type: "condition",
      key: "name",
      operator: "is",
      value: "Ada",
    });
    expect(filters.isAnyOf("name", ["Ada", "Grace"])).toEqual({
      type: "condition",
      key: "name",
      operator: "isAnyOf",
      value: ["Ada", "Grace"],
    });
    expect(filters.isNot("name", "Ada")).toEqual({
      type: "condition",
      key: "name",
      operator: "isNot",
      value: "Ada",
    });
    expect(filters.gt("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "gt",
      value: "2026-01-01",
    });
    expect(filters.gte("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "gte",
      value: "2026-01-01",
    });
    expect(filters.lt("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "lt",
      value: "2026-01-01",
    });
    expect(filters.lte("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "lte",
      value: "2026-01-01",
    });
    expect(filters.before("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "before",
      value: "2026-01-01",
    });
    expect(filters.after("createdAt", "2026-01-01")).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "after",
      value: "2026-01-01",
    });
    expect(filters.between("createdAt", { from: "2026-01-01", to: "2026-01-31" })).toEqual({
      type: "condition",
      key: "createdAt",
      operator: "between",
      value: { from: "2026-01-01", to: "2026-01-31" },
    });
  });

  it("builds nested boolean groups without mutating child conditions", () => {
    const filters = createQueryFilterBuilder<"name" | "status">();
    const active = filters.is("status", "active");
    const pending = filters.is("status", "pending");
    const search = filters.contains("name", "Ada");

    expect(filters.and([filters.or([active, pending]), search])).toEqual({
      type: "group",
      combinator: "and",
      children: [
        {
          type: "group",
          combinator: "or",
          children: [active, pending],
        },
        search,
      ],
    });
    expect(filters.condition(active)).toBe(active);
  });
});
