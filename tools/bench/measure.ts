import { loadavg } from "node:os";
import type { QueryEvent } from "../../packages/core/index.ts";
import { ITERATIONS, TIMEOUT_MS } from "./config.ts";

/** Every statement the engine runs reports here; the measurement reads it after each call. */
let sink: QueryEvent[] | undefined;
export const observe = (event: QueryEvent) => {
  sink?.push(event);
};

export type Cell = {
  medianMs?: number;
  p95Ms?: number;
  method: string;
  n?: number;
  rowCount?: number | null;
  countUsed?: string;
  /** Median milliseconds per kind of statement, as the engine reported them. */
  stages?: Record<string, number>;
  /** Median of the sum of every statement's time (statements may overlap in time). */
  statementsMs?: number;
  skipped?: string;
  [extra: string]: unknown;
};

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)
  ]!;
const round = (ms: number) => Math.round(ms * 1000) / 1000;

type Pageish = { pageInfo?: { count?: string; rowCount?: number | null } };

/**
 * Runs one request: a warm-up (which decides the sample count and the skip), then medians of 10
 * calls, 5 when the warm-up took over a second, 3 over twenty. Reports the call's wall time and
 * the engine's own per-statement times from `onQuery`.
 */
export async function measure(run: () => Promise<unknown>, method = "engine"): Promise<Cell> {
  const once = async () => {
    sink = [];
    const start = performance.now();
    const result = (await run()) as Pageish;
    const ms = performance.now() - start;
    const events = sink;
    sink = undefined;
    const stages: Record<string, number> = {};
    for (const event of events) stages[event.stage] = (stages[event.stage] ?? 0) + event.ms;
    return { ms, stages, result };
  };
  let warm;
  try {
    warm = await once();
  } catch (error) {
    sink = undefined;
    return { method, skipped: `error: ${String(error).slice(0, 160)}` };
  }
  if (warm.ms > TIMEOUT_MS) return { method, skipped: "over-limit" };
  const n =
    warm.ms > 20_000
      ? Math.min(ITERATIONS, 3)
      : warm.ms > 1_000
        ? Math.min(ITERATIONS, 5)
        : ITERATIONS;
  const samples: Array<Awaited<ReturnType<typeof once>>> = [];
  for (let i = 0; i < n; i += 1) samples.push(await once());
  const stageNames = [...new Set(samples.flatMap((s) => Object.keys(s.stages)))].sort();
  const info = samples[0]!.result.pageInfo;
  return {
    medianMs: round(median(samples.map((s) => s.ms))),
    p95Ms: round(p95(samples.map((s) => s.ms))),
    method,
    n,
    stages: Object.fromEntries(
      stageNames.map((k) => [k, round(median(samples.map((s) => s.stages[k] ?? 0)))]),
    ),
    statementsMs: round(
      median(samples.map((s) => Object.values(s.stages).reduce((sum, value) => sum + value, 0))),
    ),
    ...(info ? { countUsed: info.count, rowCount: info.rowCount ?? null } : {}),
  };
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
