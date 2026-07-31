import { describe, expect, it } from "vite-plus/test";

import { decodeCursor, encodeCursor } from "../src/cursor.js";

describe("cursor codec", () => {
  const sorting = [
    { key: "createdAt", dir: "desc" as const },
    { key: "id", dir: "desc" as const },
  ];

  it("round-trips scalar values used by Drizzle columns", () => {
    const createdAt = new Date("2026-07-31T10:30:00.000Z");
    const cursor = encodeCursor("orders", sorting, [createdAt, 42n]);

    expect(decodeCursor(cursor, "orders", sorting)).toEqual([createdAt, 42n]);
  });

  it("rejects malformed cursors and cursors from another query", () => {
    const cursor = encodeCursor("orders", sorting, ["2026-07-31", "order_42"]);

    expect(() => decodeCursor("not-a-cursor", "orders", sorting)).toThrow("Invalid cursor");
    expect(() => decodeCursor(cursor, "customers", sorting)).toThrow("Invalid cursor");
    expect(() =>
      decodeCursor(cursor, "orders", [
        { key: "createdAt", dir: "asc" },
        { key: "id", dir: "asc" },
      ]),
    ).toThrow("Invalid cursor");
  });

  it("rejects unsupported cursor values", () => {
    expect(() => encodeCursor("orders", sorting, [{ nested: true }, "order_42"])).toThrow(
      "Cursor values must be database scalar values",
    );
  });
});
