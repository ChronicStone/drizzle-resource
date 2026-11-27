import { join } from "node:path";

export const root = join(import.meta.dirname, "..", "..");
export const resultsDir = join(root, "tools/results");
export const runsDir = join(resultsDir, "scale-runs");
export const profilesFile = join(resultsDir, "profiles.json");

/** Sizes the docs and the landing read. Anything else writes to scale-runs/ instead. */
export const DEFAULT_SIZES = [200_000, 1_000_000, 10_000_000];

/** One-minute load average above which a run counts as taken on a busy machine. */
export const LOAD_THRESHOLD = Number(process.env.BENCH_LOAD_THRESHOLD ?? 8);
/** What `--final` requires the threshold to be. `BENCH_LOAD_THRESHOLD` cannot lower it for a final run. */
export const FINAL_LOAD_THRESHOLD = 8;
/** Bump when the measurement changes, so runs from different harnesses are never mixed. */
export const HARNESS_VERSION = "3";

export const PAGE_SIZE = 50;
export const TENANT = 42;
export const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10);
/** Paired requests are called at least this many times per setup, however heavy they are. */
export const MIN_ROUNDS = 10;
/** A published cell needs at least this many samples (`--final` checks); paired ones need MIN_ROUNDS. */
export const MIN_SAMPLES = 3;
/** A call that takes longer than this, or that the pool's statement timeout cancels, is recorded as `over-limit`. */
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

/** The database the numbers describe. `BENCH_DB_*` override the container, or say what a `--url` server has. */
export const DOCKER = {
  image: "postgres:18",
  cpus: process.env.BENCH_DB_CPUS ?? "4",
  memory: process.env.BENCH_DB_MEMORY ?? "4g",
  settings: {
    shared_buffers: process.env.BENCH_SHARED_BUFFERS ?? "1GB",
    work_mem: "4MB",
    max_wal_size: "1GB",
    min_wal_size: "256MB",
  },
} as const;
