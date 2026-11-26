import { join } from "node:path";

export const root = join(import.meta.dirname, "..", "..");
export const resultsDir = join(root, "tools/results");
export const runsDir = join(resultsDir, "scale-runs");
export const profilesFile = join(resultsDir, "profiles.json");

/** Sizes the docs and the landing read. Anything else writes to scale-runs/ instead. */
export const DEFAULT_SIZES = [200_000, 1_000_000, 10_000_000];

/** One-minute load average above which a run counts as taken on a busy machine. */
export const LOAD_THRESHOLD = Number(process.env.BENCH_LOAD_THRESHOLD ?? 8);

export const PAGE_SIZE = 50;
export const TENANT = 42;
export const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
/** A scenario whose warm-up takes longer than this is recorded as skipped. */
export const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 60_000);

/** `200k,1m,10m` or plain row counts, comma separated. */
export function parseSizes(input = process.env.BENCH_SIZES): number[] {
  if (!input) return DEFAULT_SIZES;
  return input.split(",").map((part) => {
    const match = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(part.trim());
    if (!match) throw new Error(`BENCH_SIZES: cannot read "${part}" (use 50000, 200k, 1m, 10m)`);
    const unit = match[2]!.toLowerCase();
    return Math.round(Number(match[1]) * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
  });
}

export function sizeLabel(rows: number): string {
  if (rows % 1_000_000 === 0) return `${rows / 1_000_000}m`;
  if (rows % 1_000 === 0) return `${rows / 1_000}k`;
  return String(rows);
}

export const DOCKER = {
  name: "drizzle-resource-bench",
  image: "postgres:18",
  cpus: "4",
  memory: "4g",
  port: Number(process.env.BENCH_PORT ?? 5617),
  settings: {
    shared_buffers: "1GB",
    work_mem: "4MB",
    max_wal_size: "1GB",
    min_wal_size: "256MB",
  },
} as const;
