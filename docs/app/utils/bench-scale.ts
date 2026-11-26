import bench from "~/data/bench-scale.json";

/* The numbers of the Scale pages. They come only from data/bench-scale.json, which
   tools/scale-bench-data.ts writes from tools/results; nothing here computes a measurement. */

export type Verdict = "improved" | "unchanged" | "worse";
export interface Series {
  scenario: string;
  ms: number[];
  p95: (number | null)[];
  method: string;
}
export interface Judged extends Series {
  verdict: Verdict[];
  ratio: (number | null)[];
  engineChange: boolean;
}
export interface BenchRequest {
  label: string;
  shape: string;
  outOfTheBox: Series;
  tuned: (Judged & { how: string }) | null;
}

export const benchScale = bench as unknown as {
  provisional: boolean;
  measuredOn: string;
  engine: string;
  source: string;
  setup: {
    database: string;
    postgresSettings: Record<string, string | number>;
    dataset: string;
    client: string;
    profiles: Record<string, string>;
    engineNote: string;
  };
  sizes: number[];
  requests: Record<string, BenchRequest>;
  scoped: Record<string, { label: string; outOfTheBox: Series; scoped: Judged }>;
  counts: Record<
    string,
    { label: string; exact: Series; capped: Series; matches: (number | null)[] }
  >;
  facetVariants: Record<string, Record<string, Series>>;
  load: {
    file: string;
    measuredOn: string;
    rows: number;
    iterations: number;
    concurrency: number;
    postgres: string;
    note: string;
    requests: Array<{
      key: string;
      label: string;
      note: string | null;
      rps: number;
      p95: number;
      ms: number;
    }>;
  };
  history: {
    file: string;
    measuredOn: string;
    rows: number;
    baseline: string;
    requests: Array<{ key: string; label: string; before: number; after: number }>;
  };
  scans: {
    file: string;
    measuredOn: string;
    rows: number;
    requests: Array<{ label: string; pages: number; scan: number }>;
  };
};

export const SIZE_SHORT = ["200k", "1M", "10M"];
export const SIZE_LONG = ["200,000 rows", "1M rows", "10M rows"];

/** `n` as "200k", "1M", "10M" or an index. */
export function sizeIndex(n: string | number | undefined) {
  if (n === undefined) return benchScale.sizes.length - 1;
  if (typeof n === "number") return n;
  const i = SIZE_SHORT.indexOf(n);
  if (i < 0) throw new Error(`Unknown table size "${n}": use 200k, 1M or 10M`);
  return i;
}

export function formatMs(ms: number) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s`;
  if (ms >= 10) return `${Math.round(ms)} ms`;
  return `${ms.toFixed(ms < 1 ? 2 : 1)} ms`;
}

export function formatCount(n: number) {
  return n.toLocaleString("en-US");
}

export function verdictText(v: Verdict) {
  return v === "improved" ? "faster" : v === "worse" ? "slower" : "no change";
}

/** Read a value by dotted path, for inline numbers in prose. */
export function benchValue(path: string): unknown {
  let value: unknown = benchScale;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !(part in value))
      throw new Error(`bench-scale.json has no "${path}"`);
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** How a series was measured, in words, keyed by the `method` the results file gives. */
export const METHOD_TEXT: Record<string, string> = {
  engine: "Through the engine, end to end, from Node over TCP.",
  "hand-sql": "Measured as SQL with psql inside the database container: no network, no JavaScript.",
  "engine+hand-sql":
    "Tuned counts add the engine's page statement to the capped count statement run as SQL: the engine of this run predates capped counts.",
};

export function methodSentences(methods: string[]) {
  const seen = new Set(methods.flatMap((m) => m.split(", ")));
  return [...seen].map((m) => METHOD_TEXT[m] ?? m);
}
