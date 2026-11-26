import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SIZES,
  FINAL_LOAD_THRESHOLD,
  LOAD_THRESHOLD,
  runsDir,
  sizeLabel,
} from "./config.ts";
import { median, type Cell } from "./measure.ts";
import type { ProfileName, RunRecord } from "./run.ts";

type Verdict = "improved" | "unchanged" | "worse";
type OutCell = Cell & { verdict?: Verdict; ratio?: number; ratioMeaning?: string };
type Scenarios = Record<string, Record<string, OutCell>>;

/**
 * Judges a tuned or scoped request against the same request out of the box, from the pairs of
 * calls made one after the other: improved when the ratio (out of the box / this) stays above 1 in
 * at least 80% of the pairs and its median is at least 1.15; worse when it stays below 1 in at least
 * 80% and the median is at most 1/1.15; otherwise unchanged.
 */
export function judge(ratios: number[]) {
  const m = median(ratios);
  const above = ratios.filter((r) => r > 1).length / ratios.length;
  const below = ratios.filter((r) => r < 1).length / ratios.length;
  const verdict: Verdict =
    above >= 0.8 && m >= 1.15 ? "improved" : below >= 0.8 && m <= 1 / 1.15 ? "worse" : "unchanged";
  return {
    verdict,
    ratio: Math.round(m * 100) / 100,
    ratioMeaning:
      "median over the paired calls of out-of-the-box time / this time; above 1 is faster",
    pairs: ratios.length,
    pairsFaster: Math.round(above * ratios.length),
  };
}

export function readRuns(): RunRecord[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf8")) as RunRecord);
  } catch {
    return [];
  }
}

const fingerprintKey = (run: RunRecord) => {
  const f = run.fingerprint;
  return JSON.stringify([f.engineCommit, f.harnessVersion, f.harnessHash, f.postgres, f.settings]);
};

/**
 * Runs from one engine commit, harness and database only: the newest fingerprint wins and older
 * ones are listed, never mixed in. The run for each size is the one taken under the lowest load.
 */
export function chooseRuns(runs: RunRecord[], sizes: number[]) {
  const inScope = runs.filter((r) => sizes.includes(r.rows));
  const newest = [...inScope].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const usable = newest ? inScope.filter((r) => fingerprintKey(r) === fingerprintKey(newest)) : [];
  const ignored = inScope.length - usable.length;
  const best = new Map<number, RunRecord>();
  for (const run of usable) {
    const current = best.get(run.rows);
    if (!current || run.load.max < current.load.max) best.set(run.rows, run);
  }
  const chosen = [...best.values()].sort((a, b) => a.rows - b.rows);
  const prints = new Set(chosen.map(fingerprintKey));
  if (prints.size > 1)
    throw new Error("the chosen runs come from different engine commits, harnesses or databases");
  return { chosen, ignored };
}

const PROFILES: ProfileName[] = ["out-of-the-box", "tuned", "scoped"];

export type Assembled = {
  data: ReturnType<typeof build>;
  /** True when the file may replace tools/results/profiles.json. */
  publishable: boolean;
  /** Why not, or why a final run was refused. */
  reasons: string[];
};

export function assemble(
  runs: RunRecord[],
  options: { final: boolean; sizes: number[] },
): Assembled {
  const { chosen, ignored } = chooseRuns(runs, options.sizes);
  const reasons: string[] = [];
  if (ignored)
    reasons.push(`${ignored} run(s) from another engine commit, harness or database were left out`);
  const missing = options.sizes.filter((n) => !chosen.some((r) => r.rows === n));
  if (missing.length)
    reasons.push(`no run for ${missing.map((n) => n.toLocaleString("en-US")).join(", ")} rows`);

  // The load is judged here, from the numbers, not from a flag stored when the run was made.
  const threshold = options.final ? FINAL_LOAD_THRESHOLD : LOAD_THRESHOLD;
  const busy = chosen.filter((r) => r.load.max > threshold);
  const skipped = chosen.flatMap((r) =>
    PROFILES.flatMap((p) =>
      Object.entries(r.cells[p] ?? {})
        .filter(([, cell]) => cell.skipped)
        .map(([scenario, cell]) => `${p} / ${scenario} / ${sizeLabel(r.rows)}: ${cell.skipped}`),
    ),
  );
  const complete =
    DEFAULT_SIZES.every((n) => chosen.some((r) => r.rows === n)) &&
    options.sizes.length === DEFAULT_SIZES.length &&
    options.sizes.every((n, i) => n === DEFAULT_SIZES[i]);
  if (!complete) reasons.push("not every default size (200k, 1m, 10m) has a run");
  if (skipped.length)
    reasons.push(
      `${skipped.length} cell(s) were skipped (${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; …" : ""})`,
    );
  const dirty = chosen.filter((r) => r.fingerprint.engineDirty);
  const untuned = chosen.flatMap((r) =>
    r.tuning.filter((t) => !t.noErrorRemains).map((t) => `${t.schema} at ${sizeLabel(r.rows)}`),
  );
  let finalOk = options.final;
  if (options.final) {
    if (
      process.env.BENCH_LOAD_THRESHOLD &&
      Number(process.env.BENCH_LOAD_THRESHOLD) !== FINAL_LOAD_THRESHOLD
    )
      throw new Error(
        `--final needs the load threshold to be ${FINAL_LOAD_THRESHOLD}; unset BENCH_LOAD_THRESHOLD`,
      );
    if (busy.length)
      reasons.push(
        `final refused: ${busy.map((r) => `${sizeLabel(r.rows)} was taken at load ${r.load.max.toFixed(1)}`).join(", ")} (limit ${threshold})`,
      );
    if (dirty.length)
      reasons.push("final refused: packages/core had uncommitted changes during the run");
    if (untuned.length)
      reasons.push(`final refused: checkIndexes still reports an error for ${untuned.join(", ")}`);
    finalOk =
      busy.length === 0 &&
      dirty.length === 0 &&
      untuned.length === 0 &&
      complete &&
      skipped.length === 0 &&
      missing.length === 0;
  }
  const publishable =
    complete && skipped.length === 0 && missing.length === 0 && (!options.final || finalOk);
  return {
    data: build(chosen, { provisional: !finalOk, sizes: options.sizes, threshold, busy, reasons }),
    publishable,
    reasons,
  };
}

function build(
  chosen: RunRecord[],
  options: {
    provisional: boolean;
    sizes: number[];
    threshold: number;
    busy: RunRecord[];
    reasons: string[];
  },
) {
  const profiles: Record<ProfileName, Scenarios> = { "out-of-the-box": {}, tuned: {}, scoped: {} };
  const regressions: string[] = [];
  for (const run of chosen)
    for (const profile of PROFILES)
      for (const [scenario, cell] of Object.entries(run.cells[profile] ?? {})) {
        const out: OutCell = { ...cell };
        // Strip what a reader of the file does not need: the raw pairs stay in the run file.
        delete out.pairedRatios;
        if (cell.pairedRatios?.length) {
          Object.assign(out, judge(cell.pairedRatios));
          if (out.verdict === "worse")
            regressions.push(
              `${profile} ${scenario.replace("landing/", "")} at ${run.rows.toLocaleString("en-US")} rows (${out.ratio}x)`,
            );
        }
        (profiles[profile][scenario] ??= {})[String(run.rows)] = out;
      }
  const first = chosen[0];
  const fingerprint = first?.fingerprint;
  const notes = [
    options.provisional
      ? options.reasons.length
        ? `Provisional: ${options.reasons.join("; ")}.`
        : "Provisional: run with --final on a quiet machine to publish final numbers."
      : `Final: every run was taken at or below load ${options.threshold}, nothing was skipped, and checkIndexes reports no error for any tuned schema.`,
    'Every number is one engine call end to end: pages and counts through resource.queryIds, capped counts with count: "capped", facets through resource.queryFacets. `parts` and `stages` are the engine\'s own per-statement times from onQuery; `statementsMs` is their sum (statements can overlap, so it can exceed the call time). `maxMs` is the slowest of the samples; with ten samples a p95 would be the same number.',
    "Landing requests are measured in pairs: out of the box and each other setup are called one after the other, the order rotating every round, so a verdict compares calls made seconds apart. verdict: improved when the ratio (out of the box / this) stays above 1 in at least 80% of the pairs and its median is at least 1.15; worse when it stays below 1 in at least 80% and the median is at most 1/1.15; otherwise unchanged. `ratio` is the median; `pairsFaster` counts the pairs above 1.",
    "Tuned means what engine.checkIndexes({ live: true }) asks for: its fix.sql of every error and warning was applied to a copy of the out-of-the-box schema, and the check was run again (setup.tuning). The sort through the customer's name has no fix.sql, only the advice to copy the name onto orders: that copy, with the index the check then asks for, is the tuned setting of that request. Counts are capped at the resource's countCap (10,000). Scoped adds what the check asks for under the orgId 42 scope.",
    "`<scenario>:count-exact` and `:count-capped` are the count statement alone, from onQuery's count stage on the tuned schema. `<scenario>/<variant>` facet cells (GROUPING SETS or one statement per facet, in a transaction or on the pool) are informational and carry no verdict. The tuned facets setting was chosen before measuring: facets.splitAbove 0, on the pool.",
    "Out of the box facets use the engine's default, facets.splitAbove 100,000, which already splits the facets of a table of this size; a tuned facets request can therefore come out unchanged.",
    "Data: createdAt grows with id, so a cursor with createdAt desc, id asc is cheap without a tuned index. orgId, status and paid are functions of n: inside tenant 42 every order has status 'paid' and paid = false.",
    ...(regressions.length
      ? [
          `Worse than out of the box: ${regressions.join("; ")}. Do not present these as improvements.`,
        ]
      : []),
  ];
  return {
    provisional: options.provisional,
    sizes: options.sizes,
    setup: {
      database: fingerprint?.postgres ?? "unknown",
      postgresSettings: fingerprint?.settings ?? {},
      dataset:
        "orders (n rows: customerId (n%20000)+1, orgId (n%100)+1, status by n%5, paid n%2=0, createdAt evenly over 7 years to 2026-11-01, reference ORD-00000001) and customers (20,000 rows)",
      client:
        "one engine call at a time, medians of 10 calls (5 when the warm-up took over 1 s, 3 over 20 s), setups called in turn",
      engineCommit: fingerprint?.engineCommit ?? "unknown",
      harness: fingerprint
        ? {
            version: fingerprint.harnessVersion,
            hash: fingerprint.harnessHash,
            runtime: fingerprint.runtime,
          }
        : null,
      loadThreshold: options.threshold,
      handSql:
        "none of the published numbers: setup SQL only (schema, the indexes checkIndexes asks for, ANALYZE). Every timing is an engine call.",
      runs: chosen.map((r) => ({
        rows: r.rows,
        startedAt: r.startedAt,
        loadStart: r.load.start,
        loadEnd: r.load.end,
        loadMax: r.load.max,
        highLoad: r.load.max > options.threshold,
      })),
      tuning: chosen.map((r) => ({ rows: r.rows, schemas: r.tuning })),
    },
    profiles: Object.fromEntries(
      PROFILES.map((name) => [
        name,
        Object.fromEntries(Object.entries(profiles[name]).sort(([a], [b]) => a.localeCompare(b))),
      ]),
    ),
    notes,
  };
}

export function writeProfiles(file: string, data: Assembled["data"]) {
  writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
}
