import { loadavg } from "node:os";
import type { QueryEvent } from "../../packages/core/index.ts";
import { ITERATIONS, MIN_ROUNDS, TIMEOUT_MS } from "./config.ts";

/** Every statement the engine runs reports here; the measurement reads it after each call. */
let sink: QueryEvent[] | undefined;
export const observe = (event: QueryEvent) => {
  sink?.push(event);
};

export type Cell = {
  medianMs?: number;
  /** The slowest sample. With ten samples a p95 would be the same number, so it is not reported. */
  maxMs?: number;
  method: string;
  n?: number;
  rowCount?: number | null;
  countUsed?: string;
  /** Median milliseconds per kind of statement, as the engine reported them. */
  stages?: Record<string, number>;
  /** Median of the sum of every statement's time (statements may overlap in time). */
  statementsMs?: number;
  /** Set when the request was not measured: `over-limit` or `error: …`. */
  skipped?: string;
  /** Per iteration, the out-of-the-box call's time divided by this call's time, from the same pair. */
  pairedRatios?: number[];
  [extra: string]: unknown;
};

/** Median; for an even count the mean of the two middle values. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
const round = (ms: number) => Math.round(ms * 1000) / 1000;

type Pageish = { pageInfo?: { count?: string; rowCount?: number | null } };
type Sample = { ms: number; stages: Record<string, number>; result: Pageish };
export type Run = () => Promise<unknown>;

async function once(run: Run): Promise<Sample> {
  sink = [];
  try {
    const start = performance.now();
    const result = (await run()) as Pageish;
    const ms = performance.now() - start;
    const stages: Record<string, number> = {};
    for (const event of sink) stages[event.stage] = (stages[event.stage] ?? 0) + event.ms;
    return { ms, stages, result };
  } finally {
    sink = undefined;
  }
}

/** PostgreSQL's `statement_timeout` cancels with SQLSTATE 57014. */
const isTimeout = (error: unknown) => {
  const chain = [error, (error as { cause?: unknown })?.cause];
  return chain.some((e) => (e as { code?: string } | undefined)?.code === "57014");
};
const failure = (error: unknown, method: string): Cell => ({
  method,
  skipped: isTimeout(error) ? "over-limit" : `error: ${String(error).slice(0, 160)}`,
});

const samplesFor = (warmMs: number) =>
  warmMs > 20_000 ? Math.min(ITERATIONS, 3) : warmMs > 1_000 ? Math.min(ITERATIONS, 5) : ITERATIONS;

function summarize(samples: Sample[], method: string): Cell {
  const stageNames = [...new Set(samples.flatMap((s) => Object.keys(s.stages)))].sort();
  const info = samples[0]!.result.pageInfo;
  return {
    medianMs: round(median(samples.map((s) => s.ms))),
    maxMs: round(Math.max(...samples.map((s) => s.ms))),
    method,
    n: samples.length,
    stages: Object.fromEntries(
      stageNames.map((k) => [k, round(median(samples.map((s) => s.stages[k] ?? 0)))]),
    ),
    statementsMs: round(
      median(samples.map((s) => Object.values(s.stages).reduce((sum, value) => sum + value, 0))),
    ),
    ...(info ? { countUsed: info.count, rowCount: info.rowCount ?? null } : {}),
  };
}

/**
 * Runs one request: a warm-up (which decides the sample count and the skip), then medians of 10
 * calls, 5 when the warm-up took over a second, 3 over twenty.
 */
export async function measure(run: Run, method = "engine"): Promise<Cell> {
  let warm: Sample;
  try {
    warm = await once(run);
  } catch (error) {
    return failure(error, method);
  }
  if (warm.ms > TIMEOUT_MS) return { method, skipped: "over-limit" };
  const samples: Sample[] = [];
  try {
    for (let i = 0; i < samplesFor(warm.ms); i += 1) samples.push(await once(run));
  } catch (error) {
    return failure(error, method);
  }
  return summarize(samples, method);
}

/**
 * Orderings for `k` arms in which every arm follows every other arm equally often (a Williams
 * design: a Latin square whose first row is 0, 1, k-1, 2, k-2, …; for odd `k` it is followed by the
 * reversed rows). A plain rotation would leave one arm always right after the same neighbour.
 */
export function williamsOrders(k: number): number[][] {
  if (k <= 1) return [[0]];
  const first = [0];
  let low = 1;
  let high = k - 1;
  while (first.length < k) {
    first.push(low++);
    if (first.length < k) first.push(high--);
  }
  const rows = Array.from({ length: k }, (_, shift) => first.map((x) => (x + shift) % k));
  return k % 2 === 0 ? rows : [...rows, ...rows.map((row) => [...row].reverse())];
}

/** Rounds to run: the fewest that is a whole number of orderings and at least MIN_ROUNDS. */
export const roundsFor = (arms: number) => {
  const orders = williamsOrders(arms).length;
  return Math.ceil(MIN_ROUNDS / orders) * orders;
};

/**
 * Runs the same request against several setups, one call of each in turn, in a carryover-balanced
 * order, at least ten rounds whatever the weight of the request, so each ratio to the first
 * (out-of-the-box) arm comes from calls made seconds apart. Every timed call is preceded by an
 * untimed one of the same request. Returns one cell per arm; every arm
 * after the first carries `pairedRatios`. An arm that times out or fails is marked alone; the
 * others carry on.
 */
export async function measurePaired(
  arms: Array<{ name: string; run: Run }>,
  method = "engine",
): Promise<Record<string, Cell>> {
  const out: Record<string, Cell> = {};
  let live: Array<{ name: string; run: Run }> = [];
  for (const arm of arms) {
    try {
      const warm = await once(arm.run);
      if (warm.ms > TIMEOUT_MS) out[arm.name] = { method, skipped: "over-limit" };
      else live.push(arm);
    } catch (error) {
      out[arm.name] = failure(error, method);
    }
  }
  const rounds = roundsFor(live.length);
  const orders = williamsOrders(live.length);
  const slots = live.slice();
  const samples = new Map<string, Array<Sample | undefined>>(slots.map((arm) => [arm.name, []]));
  for (let i = 0; i < rounds; i += 1)
    for (const index of orders[i % orders.length]!) {
      const arm = slots[index]!;
      if (!live.includes(arm)) continue;
      try {
        // An untimed call of the same request first, so the timed one finds its own pages in
        // memory whatever the other setup's calls have evicted since it last ran.
        await arm.run();
        samples.get(arm.name)![i] = await once(arm.run);
      } catch (error) {
        out[arm.name] = failure(error, method);
        live = live.filter((a) => a !== arm);
      }
    }
  const reference = samples.get(arms[0]!.name);
  for (const arm of live) {
    const own = samples.get(arm.name)!;
    const cell = summarize(
      own.filter((s): s is Sample => s !== undefined),
      method,
    );
    if (reference && arm.name !== arms[0]!.name && live.some((a) => a.name === arms[0]!.name))
      cell.pairedRatios = own.flatMap((s, i) =>
        s && reference[i] ? [Math.round((reference[i]!.ms / s.ms) * 1000) / 1000] : [],
      );
    out[arm.name] = cell;
  }
  return out;
}

/** The one-minute load average, sampled around every scenario so a busy spell shows. */
export class LoadMeter {
  samples: number[] = [];
  sample() {
    this.samples.push(loadavg()[0]!);
  }
  get start() {
    return this.samples[0] ?? 0;
  }
  get end() {
    return this.samples.at(-1) ?? 0;
  }
  get max() {
    return Math.max(0, ...this.samples);
  }
}
