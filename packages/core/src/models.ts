import { Column, getColumns, is, SQL, sql } from "drizzle-orm";
import type { TypedQueryBuilder } from "drizzle-orm/query-builders/query-builder";
import type { QueryEngineDb } from "./types.js";

export interface VirtualField<T = unknown, TTable = any, TDb = any> {
  readonly nullable?: boolean;
  readonly kind: "text" | "number" | "boolean" | "timestamp" | "scalar";
  readonly resolve: (table: TTable, context: { db: TDb }) => SQL<T>;
}

type ScalarResult<Q extends TypedQueryBuilder<any, any>> =
  Q["_"]["result"] extends Array<infer R> ? R[keyof R] | null : never;

type IsUnion<T, All = T> = T extends All ? ([All] extends [T] ? false : true) : never;
type SingleScalar<Q extends TypedQueryBuilder<any, any>> =
  keyof Q["_"]["selectedFields"] extends never
    ? false
    : IsUnion<keyof Q["_"]["selectedFields"]> extends true
      ? false
      : Q["_"]["selectedFields"][keyof Q["_"]["selectedFields"]] extends Column | SQL | SQL.Aliased
        ? true
        : false;

function expression<T>(kind: VirtualField["kind"], decode: (value: any) => T) {
  return <TTable, TDb = QueryEngineDb>(
    factory: (table: TTable, context: { db: TDb }) => SQL,
  ): VirtualField<T, TTable, TDb> => ({
    kind,
    resolve: (table, context) => factory(table, context).mapWith(decode),
  });
}

/** SQL expressions are built lazily, using the owning table alias and current transaction. */
type ExpressionFactory<T> = <TTable, TDb = QueryEngineDb>(
  factory: (table: TTable, context: { db: TDb }) => SQL,
) => VirtualField<T, TTable, TDb>;

export interface VirtualHelpers {
  text: ExpressionFactory<string>;
  number: ExpressionFactory<number>;
  boolean: ExpressionFactory<boolean>;
  timestamp: ExpressionFactory<Date>;
  nullable<T, TTable, TDb>(
    field: VirtualField<T, TTable, TDb>,
  ): VirtualField<T | null, TTable, TDb>;
  scalar<TTable, TDb, Q extends TypedQueryBuilder<any, any>>(
    factory: (
      table: TTable,
      context: { db: TDb },
    ) => Q & (SingleScalar<NoInfer<Q>> extends false ? never : unknown),
  ): VirtualField<ScalarResult<Q>, TTable, TDb>;
}

export const virtual: VirtualHelpers = {
  text: expression("text", String),
  number: expression("number", Number),
  boolean: expression("boolean", (value) => value === true || value === "t" || value === 1),
  timestamp: expression("timestamp", (value) => (value instanceof Date ? value : new Date(value))),
  nullable<T, TTable, TDb>(
    field: VirtualField<T, TTable, TDb>,
  ): VirtualField<T | null, TTable, TDb> {
    return { ...field, nullable: true };
  },
  scalar<TTable, TDb, Q extends TypedQueryBuilder<any, any>>(
    factory: (
      table: TTable,
      context: { db: TDb },
    ) => Q & (SingleScalar<NoInfer<Q>> extends false ? never : unknown),
  ): VirtualField<ScalarResult<Q>, TTable, TDb> {
    return {
      kind: "scalar",
      nullable: true,
      resolve(table, context) {
        const query = factory(table, context);
        const fields = Object.values((query as any).getSelectedFields());
        if (fields.length !== 1) throw new Error("A scalar virtual must select exactly one column");
        const field: any = fields[0];
        if (!is(field, Column) && !is(field, SQL) && !is(field, SQL.Aliased))
          throw new Error("A scalar virtual must select one scalar expression");
        const decoder = is(field, SQL.Aliased)
          ? (field.sql as any).decoder
          : ((field as any).decoder ?? field);
        return sql`(${query.getSQL()})`.mapWith(
          typeof decoder?.mapFromDriverValue === "function"
            ? decoder
            : { mapFromDriverValue: (v: unknown) => v },
        ) as SQL<ScalarResult<Q>>;
      },
    };
  },
};

export interface RuntimeModel {
  private?: readonly string[];
  hidden?: readonly string[];
  virtual?: Record<string, VirtualField>;
}

export interface RuntimeView {
  select: Record<string, true | RuntimeView>;
}

export function validateModels(
  schema: Record<string, any>,
  models: Record<string, RuntimeModel>,
  relations: Record<string, any>,
): void {
  for (const [name, model] of Object.entries(models)) {
    if (!schema[name]) throw new Error(`Unknown model "${name}"`);
    const columns = getColumns(schema[name]);
    for (const key of [...(model.private ?? []), ...(model.hidden ?? [])]) {
      if (!(key in columns) && !model.virtual?.[key])
        throw new Error(`Unknown model field "${name}.${key}"`);
    }
    for (const [key, field] of Object.entries(model.virtual ?? {})) {
      if (key in columns) throw new Error(`Virtual field collides with column "${name}.${key}"`);
      if (key in (relations[name]?.relations ?? {}))
        throw new Error(`Virtual field collides with relation "${name}.${key}"`);
      if (!field || typeof field.resolve !== "function")
        throw new Error(`Invalid virtual "${name}.${key}"`);
    }
  }
}

export interface Projection {
  config(db: QueryEngineDb, root?: boolean): Record<string, any>;
  project(row: Record<string, any>): Record<string, any>;
}

/** Compile once per view; only virtual SQL construction depends on the execution database. */
export function compileProjection(
  config: {
    schema: Record<string, any>;
    relations: Record<string, any>;
    models?: Record<string, RuntimeModel>;
  },
  root: string,
  available: Record<string, any> | undefined,
  view?: RuntimeView,
): Projection {
  const model = config.models?.[root];
  const columns = getColumns(config.schema[root]);
  const privateFields = new Set(model?.private ?? []);
  const hiddenFields = new Set(model?.hidden ?? []);
  const scalarKeys: string[] = [];
  const extras: Record<string, VirtualField> = {};
  const nested: Record<string, Projection> = {};
  if (view && (!view.select || typeof view.select !== "object" || Array.isArray(view.select))) {
    throw new Error(`Invalid view selection for "${root}"`);
  }
  const selection =
    view?.select ??
    Object.fromEntries([
      ...Object.keys(columns)
        .filter((key) => !privateFields.has(key) && !hiddenFields.has(key))
        .map((key) => [key, true]),
      ...Object.entries(available ?? {}),
    ]);
  for (const [key, value] of Object.entries(selection)) {
    if (privateFields.has(key)) throw new Error(`Cannot select private field "${root}.${key}"`);
    if (key in columns || model?.virtual?.[key]) {
      if (value !== true) throw new Error(`Invalid scalar selection "${root}.${key}"`);
      scalarKeys.push(key);
      if (model?.virtual?.[key]) extras[key] = model.virtual[key];
      continue;
    }
    const relation = config.relations[root]?.relations?.[key];
    if (!relation || !available?.[key]) throw new Error(`Unknown selection "${root}.${key}"`);
    const childAvailable = available[key] === true ? undefined : available[key].with;
    let childRelations;
    let childView;
    if (value !== true) {
      childRelations = view ? childAvailable : (value as any).with;
      childView = view ? (value as RuntimeView) : undefined;
    }
    nested[key] = compileProjection(config, relation.targetTableName, childRelations, childView);
  }
  return {
    config(db, isRoot = false) {
      const selectedColumns = Object.fromEntries(
        scalarKeys.filter((key) => key in columns).map((key) => [key, true]),
      );
      // Hydration orders by ID before stripping internal fields from the result.
      if (isRoot) selectedColumns.id = true;
      // Keep an empty nested selection valid SQL; projection strips this internal column.
      if (!scalarKeys.length && !Object.keys(nested).length) {
        selectedColumns[Object.keys(columns)[0]!] = true;
      }
      return {
        columns: selectedColumns,
        ...(Object.keys(extras).length
          ? {
              extras: Object.fromEntries(
                Object.entries(extras).map(([key, field]) => [
                  key,
                  (table: any) => field.resolve(table, { db }),
                ]),
              ),
            }
          : {}),
        with: Object.fromEntries(
          Object.entries(nested).map(([key, child]) => [key, child.config(db)]),
        ),
      };
    },
    project(row) {
      const result: Record<string, any> = {};
      for (const key of scalarKeys) {
        if (!(key in row))
          throw new Error(`Missing selected field "${root}.${key}" in row strategy result`);
        result[key] = row[key];
      }
      for (const [key, child] of Object.entries(nested)) {
        if (!(key in row))
          throw new Error(`Missing selected relation "${root}.${key}" in row strategy result`);
        const value = row[key];
        result[key] = Array.isArray(value)
          ? value.map((item) => child.project(item))
          : value == null
            ? value
            : child.project(value);
      }
      return result;
    },
  };
}
