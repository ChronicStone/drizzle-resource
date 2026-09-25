import { Column, getColumns, is, SQL, StringChunk } from "drizzle-orm";
import type { QueryEngineDb } from "./types.js";
import type { RuntimeModel } from "./models.js";
import type { SummarySelection } from "./model-types.js";

export interface SummaryFieldShape {
  kind: "number" | "string" | "boolean" | "date" | "column";
  nullable: boolean;
  column?: Column;
}

export function resolveSummarySelection(
  table: any,
  model: RuntimeModel | undefined,
  summary: (fields: Record<string, any>) => SummarySelection,
  db: QueryEngineDb,
): SummarySelection {
  const fields: Record<string, any> = { ...getColumns(table) };
  for (const [key, field] of Object.entries(model?.virtual ?? {})) {
    Object.defineProperty(fields, key, {
      enumerable: true,
      configurable: true,
      get: () => field.resolve(table, { db }),
    });
  }
  for (const key of model?.private ?? []) delete fields[key];
  const selection = summary(fields);
  if (
    !selection ||
    !Object.keys(selection).length ||
    Object.values(selection).some((field) => !is(field, SQL) && !is(field, SQL.Aliased))
  ) {
    throw new Error("Summary must return a non-empty object of SQL aggregate expressions");
  }
  return selection;
}

/** Recognize Drizzle's aggregate AST and decoder without rendering SQL or querying the database. */
export function resolveSummaryShape(
  selection: SummarySelection,
): Record<string, SummaryFieldShape> {
  return Object.fromEntries(
    Object.entries(selection).map(([name, field]) => {
      const expression = is(field, SQL.Aliased) ? field.sql : field;
      const chunks = expression.queryChunks;
      const start = chunks[0];
      const end = chunks[2];
      const aggregate =
        chunks.length === 3 && is(start, StringChunk) && is(end, StringChunk) && end.value === ")"
          ? /^(count|sum|avg|min|max)\((?:distinct )?$/.exec(start.value)?.[1]
          : undefined;
      const decoder = (expression as SQL & { decoder: { mapFromDriverValue: unknown } }).decoder;
      const decode = decoder.mapFromDriverValue;
      let shape: SummaryFieldShape | undefined;
      if (aggregate) {
        const nullable = aggregate !== "count";
        if (is(decoder, Column)) shape = { kind: "column", column: decoder, nullable };
        else if (decode === Number) shape = { kind: "number", nullable };
        else if (decode === String) shape = { kind: "string", nullable };
        else if (decode === Boolean) shape = { kind: "boolean", nullable };
      }
      if (!shape)
        throw new Error(
          `Cannot infer runtime schema for summary field "${name}". Use a Drizzle aggregate with a known decoder or provide a summary schema override for custom SQL.`,
        );
      return [name, shape];
    }),
  );
}
