import type { SQL } from "drizzle-orm";
import type { VirtualField } from "./models.js";
import type {
  DefineResourceOptions,
  GenericObject,
  QueryEngine,
  QueryEngineDb,
  QueryEngineRelations,
  QueryEngineSchema,
  QueryEngineTable,
  QueryRootKey,
  QueryRelationsConfig,
  QueryResource,
  QueryRowShape,
  QueryResultRowShape,
  ResourceHydrationConfig,
  ResourceHydrationProfiles,
  ResourceLoad,
  ResolveResourceLoad,
  ResourceRowForLoad,
  QueryRequestInput,
  ResourceQueryExecutionOptions,
  QueryResponse,
  QueryScanRequest,
  QueryScanBatch,
  QueryCountMode,
  QueryFieldPath,
  QueryScopeHandler,
  ResourceQueryConfig,
} from "./types.js";

type Columns<S, K extends keyof S> = S[K] extends QueryEngineTable ? S[K]["_"]["columns"] : never;
type Model<M, K> = K extends keyof M ? M[K] : {};
type Keys<M, K, P extends "private" | "hidden"> =
  Model<M, K> extends { [F in P]: readonly (infer V)[] } ? Extract<V, string> : never;
type Virtuals<M, K> = Model<M, K> extends { virtual: infer V } ? V : {};
type Value<T> = T extends VirtualField<infer V, any, any> ? V : never;
type Relations<R, K> = K extends keyof R ? (R[K] extends { relations: infer V } ? V : {}) : {};
type Target<R> = R extends { targetTableName: infer K } ? K : never;
type Nested<W> = W extends { with: infer V } ? V : undefined;
type Simplify<T> = { [K in keyof T]: T[K] };

export type ModelDefinitions<S extends QueryEngineSchema, D extends QueryEngineDb> = {
  [K in keyof S]?: {
    private?: readonly Extract<keyof Columns<S, K>, string>[];
    hidden?: readonly Extract<keyof Columns<S, K>, string>[];
    virtual?: Record<string, VirtualField<any, S[K], D>>;
  };
};

/** Public query paths include virtuals, but never private model columns. */
type ModelSchema<S, M, IncludePrivate extends boolean = false> = {
  [K in keyof S]: S[K] extends QueryEngineTable
    ? Omit<S[K], "_"> & {
        _: Omit<S[K]["_"], "columns"> & {
          columns: Omit<
            Columns<S, K>,
            IncludePrivate extends true ? never : Keys<M, K, "private">
          > &
            Virtuals<M, K>;
        };
      }
    : S[K];
};

type Selection<S, R, M, K extends keyof S, W> = {
  [F in Exclude<keyof Columns<S, K> | keyof Virtuals<M, K>, Keys<M, K, "private">>]?: true;
} & {
  [F in keyof W & keyof Relations<R, K>]?:
    | true
    | ResourceView<S, R, M, Extract<Target<Relations<R, K>[F]>, keyof S>, Nested<W[F]>>;
};

export type ResourceView<S, R, M, K extends keyof S, W> = { select: Selection<S, R, M, K, W> };

type ValidateView<S, R, M, K extends keyof S, W, V> = V extends { select: infer Sel }
  ? {
      select: {
        [F in keyof Sel]: F extends keyof Selection<S, R, M, K, W>
          ? Sel[F] extends true
            ? true
            : F extends keyof Relations<R, K> & keyof W
              ? ValidateView<
                  S,
                  R,
                  M,
                  Extract<Target<Relations<R, K>[F]>, keyof S>,
                  Nested<W[F]>,
                  Sel[F]
                >
              : never
          : never;
      };
    }
  : never;

type ScalarRow<
  D extends QueryEngineDb,
  S extends QueryEngineSchema,
  M,
  K extends QueryRootKey<D, S>,
> = Omit<QueryRowShape<D, S, K>, Keys<M, K, "private">> & {
  [F in keyof Virtuals<M, K>]: Value<Virtuals<M, K>[F]>;
};

type RelationRow<D extends QueryEngineDb, S extends QueryEngineSchema, R, M, Rel, W, V> =
  Target<Rel> extends infer K extends QueryRootKey<D, S>
    ? Rel extends { relationType: "many" }
      ? SelectedRow<D, S, R, M, K, W, V>[]
      : SelectedRow<D, S, R, M, K, W, V> | (Rel extends { optional: true } ? null : never)
    : never;

type SelectedRow<
  D extends QueryEngineDb,
  S extends QueryEngineSchema,
  R,
  M,
  K extends QueryRootKey<D, S>,
  W,
  V,
> = V extends { select: infer Sel }
  ? Simplify<{
      -readonly [F in keyof Sel]: F extends keyof ScalarRow<D, S, M, K>
        ? ScalarRow<D, S, M, K>[F]
        : F extends keyof Relations<R, K> & keyof W
          ? RelationRow<
              D,
              S,
              R,
              M,
              Relations<R, K>[F],
              Sel[F] extends true ? undefined : Nested<W[F]>,
              Sel[F] extends true ? undefined : Sel[F]
            >
          : never;
    }>
  : Simplify<
      Omit<QueryRowShape<D, S, K>, Keys<M, K, "private"> | Keys<M, K, "hidden">> & {
        [F in keyof W & keyof Relations<R, K>]: RelationRow<
          D,
          S,
          R,
          M,
          Relations<R, K>[F],
          Nested<W[F]>,
          undefined
        >;
      }
    >;

export type SummarySelection = Record<string, SQL | SQL.Aliased>;
export type SummaryResult<S> = {
  -readonly [K in keyof S]: S[K] extends SQL<infer V> | SQL.Aliased<infer V> ? V : never;
};
type SummaryFields<S, M, K extends keyof S> = Omit<Columns<S, K>, Keys<M, K, "private">> & {
  [F in keyof Virtuals<M, K>]: SQL<Value<Virtuals<M, K>[F]>>;
};
type WithSummary<R, S, B> = B extends true ? R & { summary: SummaryResult<S> } : R;
type SelectionArgs<N, L> = { view?: N; load?: never } | { view?: never; load?: L };

type ResultRow<
  D extends QueryEngineDb,
  S extends QueryEngineSchema,
  R extends QueryEngineRelations,
  M,
  K extends QueryRootKey<D, S>,
  W extends object | undefined,
  H,
  Row extends GenericObject,
  V,
  Name,
  Load,
  Op extends "query" | "findById",
> = Name extends keyof V
  ? SelectedRow<D, S, R, M, K, W, V[Name]>
  : keyof M extends never
    ? ResourceRowForLoad<D, S, R, K, W, Row, ResolveResourceLoad<W, H, Op, Load>>
    : SelectedRow<D, S, R, M, K, ResolveResourceLoad<W, H, Op, Load>, undefined>;

type Resource<
  D extends QueryEngineDb,
  S extends QueryEngineSchema,
  R extends QueryEngineRelations,
  M,
  K extends QueryRootKey<D, S>,
  W extends object | undefined,
  C extends GenericObject,
  Row extends GenericObject,
  H extends ResourceHydrationConfig<W, ResourceHydrationProfiles<W>> | undefined,
  V,
  Sum,
> = Omit<
  QueryResource<D, S, R, K, W, C, Row, H>,
  "$infer" | "query" | "findById" | "queryRows" | "scan"
> & {
  views: V;
  models: M;
  $infer: Omit<
    QueryResource<D, S, R, K, W, C, Row, H>["$infer"],
    "query" | "findById" | "profiles"
  > & {
    query: ResultRow<D, S, R, M, K, W, H, Row, V, undefined, undefined, "query">;
    findById: ResultRow<D, S, R, M, K, W, H, Row, V, undefined, undefined, "findById">;
    profiles: {
      [N in keyof QueryResource<D, S, R, K, W, C, Row, H>["$infer"]["profiles"]]: ResultRow<
        D,
        S,
        R,
        M,
        K,
        W,
        H,
        Row,
        V,
        undefined,
        N,
        "query"
      >;
    };
    views: { [N in keyof V]: SelectedRow<D, S, R, M, K, W, V[N]> };
    summary: SummaryResult<Sum>;
  };
  query<
    const N extends Extract<keyof V, string> | undefined = undefined,
    const L extends ResourceLoad<W, H> | undefined = undefined,
    const B extends boolean = false,
  >(
    args: {
      request: QueryRequestInput;
      context?: C;
      db?: QueryEngineDb;
      execution?: ResourceQueryExecutionOptions;
      summary?: keyof Sum extends never ? never : B;
    } & SelectionArgs<N, L>,
  ): Promise<
    WithSummary<QueryResponse<ResultRow<D, S, R, M, K, W, H, Row, V, N, L, "query">>, Sum, B>
  >;
  findById<
    const N extends Extract<keyof V, string> | undefined = undefined,
    const L extends ResourceLoad<W, H> | undefined = undefined,
  >(
    args: {
      id: Row extends { id: infer I } ? I : unknown;
      context?: C;
      db?: QueryEngineDb;
    } & SelectionArgs<N, L>,
  ): Promise<ResultRow<D, S, R, M, K, W, H, Row, V, N, L, "findById"> | null>;
  queryRows<
    const N extends Extract<keyof V, string> | undefined = undefined,
    const L extends ResourceLoad<W, H> | undefined = undefined,
  >(
    args: {
      request: QueryRequestInput;
      ids: Array<Row extends { id: infer I } ? I : unknown>;
      context?: C;
      db?: QueryEngineDb;
      execution?: ResourceQueryExecutionOptions;
    } & SelectionArgs<N, L>,
  ): Promise<ResultRow<D, S, R, M, K, W, H, Row, V, N, L, "query">[]>;
  scan<
    T,
    const N extends Extract<keyof V, string> | undefined = undefined,
    const L extends ResourceLoad<W, H> | undefined = undefined,
  >(
    args: {
      request?: QueryScanRequest;
      context?: C;
      db?: QueryEngineDb;
      batchSize?: number;
      count?: QueryCountMode;
      signal?: AbortSignal;
    } & SelectionArgs<N, L>,
    consume: (
      batches: AsyncIterable<QueryScanBatch<ResultRow<D, S, R, M, K, W, H, Row, V, N, L, "query">>>,
    ) => Promise<T>,
  ): Promise<T>;
  querySummary: keyof Sum extends never
    ? never
    : (args: {
        request: QueryRequestInput;
        context?: C;
        db?: QueryEngineDb;
        execution?: ResourceQueryExecutionOptions;
      }) => Promise<SummaryResult<Sum>>;
};

export interface ConfiguredEngine<
  D extends QueryEngineDb,
  S extends QueryEngineSchema,
  R extends QueryEngineRelations,
  M,
  C extends GenericObject = GenericObject,
> extends Omit<
  QueryEngine<D, S, R, C>,
  "defineResource" | "defineQueryResource" | "withContext" | "defineScope"
> {
  withContext<Context extends GenericObject>(): ConfiguredEngine<D, S, R, M, Context>;
  defineScope: QueryEngine<D, ModelSchema<S, M, true>, R, C>["defineScope"];
  defineResource<
    K extends QueryRootKey<D, S>,
    const W extends QueryRelationsConfig<R, K> | undefined = undefined,
    Context extends C = C,
    Row extends GenericObject = QueryResultRowShape<D, S, R, K, W>,
    const H extends ResourceHydrationConfig<W, ResourceHydrationProfiles<W>> | undefined =
      undefined,
    const V extends Record<string, ResourceView<S, R, M, K, W>> = {},
    const Sum extends SummarySelection = {},
  >(
    root: K,
    options: Omit<DefineResourceOptions<D, S, R, K, W, C, Context, Row, H>, "query"> & {
      relations?: W;
      query?: Omit<
        ResourceQueryConfig<
          D,
          ModelSchema<S, M>,
          R,
          K & QueryRootKey<D, ModelSchema<S, M>>,
          W,
          Context
        >,
        "scope"
      > & {
        scope?: QueryScopeHandler<QueryFieldPath<ModelSchema<S, M, true>, R, K, W>, Context>;
      };
      views?: V & { [N in keyof V]: ValidateView<S, R, M, K, W, V[N]> };
      summary?: (fields: SummaryFields<S, M, K>) => Sum;
    },
  ): Resource<D, S, R, M, K, W, Context, Row, H, V, Sum>;
  defineQueryResource: ConfiguredEngine<D, S, R, M, C>["defineResource"];
}
