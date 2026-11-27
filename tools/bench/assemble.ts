import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SIZES,
  DOCUMENTED,
  FINAL_LOAD_THRESHOLD,
  LOAD_THRESHOLD,
  MIN_ROUNDS,
  MIN_SAMPLES,
  runsDir,
  sizeLabel,
} from "./config.ts";
import { REQUIRED_CELLS } from "./contract.ts";
import { median, type Cell } from "./measure.ts";
import type { ProfileName, RunRecord } from "./run.ts";
import type { Tuning } from "./tuning.ts";

type Verdict = "improved" | "unchanged" | "worse";
type OutCell = Cell & {
  verdict?: Verdict;
  ratio?: number;
  ratioMeaning?: string;
  withinNoise?: boolean;
  verdictBeforeNoise?: Verdict;
};
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

/** Everything that changes what a number means. Runs with different keys are never mixed. */
const fingerprintKey = (run: RunRecord) => {
  const f = run.fingerprint;
  return JSON.stringify([
    f.engineCommit,
    f.harnessVersion,
    f.harnessHash,
    f.postgres,
    f.settings,
    f.database,
    f.iterations,
    f.timeoutMs,
    f.minRounds,
  ]);
};

/**
 * A run whose own checks pass: a clean null pair, no failed cell, no checkIndexes error left.
 * Load is judged apart, so a sound run under a higher load still beats an unsound quiet one.
 */
function sound(run: RunRecord) {
  const ratios = run.nullPair?.ratios ?? [];
  if (ratios.length < MIN_ROUNDS) return false;
  const nullPair = judge(ratios);
  if (nullPair.verdict !== "unchanged" || !(Math.abs(nullPair.ratio - 1) <= 0.05)) return false;
  if (run.tuning.some((t) => !t.noErrorRemains)) return false;
  return Object.values(run.cells).every((cells) =>
    Object.values(cells ?? {}).every((c) => !c.skipped || c.skipped === "over-limit"),
  );
}

/**
 * Runs from one engine commit, harness and database only: the newest fingerprint wins and older
 * ones are counted, never mixed in. The run for each size is a sound one if there is one (see
 * `sound`), and among those the one taken under the lowest load.
 */
export function chooseRuns(runs: RunRecord[], sizes: number[]) {
  const inScope = runs.filter((r) => sizes.includes(r.rows));
  const newest = [...inScope].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const usable = newest ? inScope.filter((r) => fingerprintKey(r) === fingerprintKey(newest)) : [];
  const best = new Map<number, RunRecord>();
  for (const run of usable) {
    const current = best.get(run.rows);
    const better =
      !current ||
      (sound(run) && !sound(current)) ||
      (sound(run) === sound(current) && run.load.max < current.load.max);
    if (better) best.set(run.rows, run);
  }
  const chosen = [...best.values()].sort((a, b) => a.rows - b.rows);
  if (new Set(chosen.map(fingerprintKey)).size > 1)
    throw new Error("the chosen runs come from different engine commits, harnesses or databases");
  return { chosen, ignored: inScope.length - usable.length };
}

const PROFILES: ProfileName[] = ["out-of-the-box", "tuned", "scoped"];
const isLanding = (scenario: string) => scenario.startsWith("landing/");

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
  const complete =
    options.sizes.length === DEFAULT_SIZES.length &&
    options.sizes.every((n, i) => n === DEFAULT_SIZES[i]) &&
    missing.length === 0;
  if (!complete) reasons.push("not every default size (200k, 1m, 10m) has a run");

  // A request that ran past the limit is a result. Any other failure to measure is not.
  const cellsOf = (r: RunRecord) =>
    PROFILES.flatMap((p) =>
      Object.entries(r.cells[p] ?? {}).map(([scenario, cell]) => ({
        p,
        scenario,
        cell,
        rows: r.rows,
      })),
    );
  const failed = chosen
    .flatMap(cellsOf)
    .filter((c) => c.cell.skipped && c.cell.skipped !== "over-limit");
  const overLimit = chosen.flatMap(cellsOf).filter((c) => c.cell.skipped === "over-limit");
  if (failed.length)
    reasons.push(
      `${failed.length} cell(s) failed (${failed
        .slice(0, 3)
        .map((c) => `${c.p} / ${c.scenario} / ${sizeLabel(c.rows)}: ${c.cell.skipped}`)
        .join("; ")}${failed.length > 3 ? "; …" : ""})`,
    );

  // The null pair: the same request against itself. It should read "unchanged".
  const nulls = chosen.map((r) => ({
    rows: r.rows,
    request: r.nullPair?.request ?? "none",
    ratios: r.nullPair?.ratios ?? [],
    ...(r.nullPair?.ratios?.length
      ? judge(r.nullPair.ratios)
      : {
          verdict: "unchanged" as Verdict,
          ratio: NaN,
          pairs: 0,
          pairsFaster: 0,
          ratioMeaning: "",
        }),
    min: r.nullPair?.ratios?.length ? Math.min(...r.nullPair.ratios) : NaN,
    max: r.nullPair?.ratios?.length ? Math.max(...r.nullPair.ratios) : NaN,
  }));
  // At least 10 pairs, a median within 5% of 1, and a verdict of unchanged.
  const nullBad = nulls.filter(
    (n) => n.pairs < MIN_ROUNDS || !(Math.abs(n.ratio - 1) <= 0.05) || n.verdict !== "unchanged",
  );
  if (nullBad.length)
    reasons.push(
      `the null pair (the same request against itself) was not a clean "unchanged" (${nullBad.map((n) => `${n.verdict}, median ${n.ratio}, ${n.pairs} pairs at ${sizeLabel(n.rows)}`).join("; ")}): this run's verdicts are not trustworthy`,
    );

  // The load is judged here, from the numbers, not from a flag stored when the run was made.
  const threshold = options.final ? FINAL_LOAD_THRESHOLD : LOAD_THRESHOLD;
  const busy = chosen.filter((r) => r.load.max > threshold);
  let finalOk = options.final;
  const finalReasons: string[] = [];
  if (options.final) {
    if (
      process.env.BENCH_LOAD_THRESHOLD &&
      Number(process.env.BENCH_LOAD_THRESHOLD) !== FINAL_LOAD_THRESHOLD
    )
      throw new Error(
        `--final needs the load threshold to be ${FINAL_LOAD_THRESHOLD}; unset BENCH_LOAD_THRESHOLD`,
      );
    if (busy.length)
      finalReasons.push(
        `${busy.map((r) => `${sizeLabel(r.rows)} was taken at load ${r.load.max.toFixed(1)}`).join(", ")} (limit ${threshold})`,
      );
    if (chosen.some((r) => r.fingerprint.engineDirty))
      finalReasons.push("packages/core had uncommitted changes during the run");
    const untuned = chosen.flatMap((r) =>
      r.tuning.filter((t) => !t.noErrorRemains).map((t) => `${t.schema} at ${sizeLabel(r.rows)}`),
    );
    if (untuned.length)
      finalReasons.push(`checkIndexes still reports an error for ${untuned.join(", ")}`);
    if (nullBad.length)
      finalReasons.push(
        "the null pair was not unchanged, with at least 10 pairs and a median within 5% of 1",
      );
    const odd = chosen.filter((r) => {
      const f = r.fingerprint;
      return (
        f.iterations !== DOCUMENTED.iterations ||
        f.timeoutMs !== DOCUMENTED.timeoutMs ||
        f.minRounds !== MIN_ROUNDS ||
        f.database.cpus !== DOCUMENTED.cpus ||
        f.database.memory !== DOCUMENTED.memory ||
        Object.entries(DOCUMENTED.settings).some(([k, v]) => f.settings[k] !== v)
      );
    });
    if (odd.length)
      finalReasons.push(
        `${odd.map((r) => sizeLabel(r.rows)).join(", ")} was made with a configuration the pages do not describe (they describe ${DOCUMENTED.cpus} CPUs, ${DOCUMENTED.memory}, shared_buffers ${DOCUMENTED.settings.shared_buffers}, work_mem ${DOCUMENTED.settings.work_mem}, ${DOCUMENTED.iterations} iterations, a ${DOCUMENTED.timeoutMs / 1000} s limit)`,
      );
    if (failed.length) finalReasons.push("some cells failed");
    if (!complete) finalReasons.push("not every default size has a run");
    const unknownDb = chosen.filter(
      (r) =>
        r.fingerprint.database.cpus === "unknown" || r.fingerprint.database.memory === "unknown",
    );
    if (unknownDb.length)
      finalReasons.push(
        "the database's CPUs and memory are unknown: set BENCH_DB_CPUS and BENCH_DB_MEMORY for --url",
      );
    const absent = chosen.flatMap((r) =>
      PROFILES.flatMap((p) =>
        REQUIRED_CELLS[p]
          .filter((k) => !r.cells[p]?.[k])
          .map((k) => `${p} / ${k} / ${sizeLabel(r.rows)}`),
      ),
    );
    if (absent.length)
      finalReasons.push(
        `${absent.length} cell(s) the docs read are missing (${absent.slice(0, 2).join("; ")}${absent.length > 2 ? "; …" : ""})`,
      );
    const thin = chosen
      .flatMap(cellsOf)
      .filter(
        ({ cell, scenario }) =>
          !cell.skipped &&
          typeof cell.n === "number" &&
          cell.n < (isLanding(scenario) ? MIN_ROUNDS : MIN_SAMPLES),
      );
    if (thin.length)
      finalReasons.push(
        `${thin.length} cell(s) have too few samples (${thin
          .slice(0, 2)
          .map((c) => `${c.p} / ${c.scenario}: n=${c.cell.n}`)
          .join("; ")})`,
      );
    if (finalReasons.length) reasons.push(`final refused: ${finalReasons.join("; ")}`);
    finalOk = finalReasons.length === 0;
  }
  const publishable = complete && failed.length === 0 && (!options.final || finalOk);
  return {
    data: build(chosen, {
      provisional: !finalOk,
      sizes: options.sizes,
      threshold,
      reasons,
      nulls,
      overLimit: overLimit.length,
    }),
    publishable,
    reasons,
  };
}

const bare = (sql: string) =>
  sql
    .replace(/\bscale_[0-9a-z]+(_[tds])?\./g, "<schema>.")
    .replace(/"scale_[0-9a-z]+(_[tds])?"\./g, "<schema>.");

/** What "tuned" contains, change by change, with the finding of `checkIndexes` that asked for it, if any. */
export function tunedChanges(run: RunRecord | undefined) {
  const find = (suffix: string, scoped = false) =>
    run?.tuning.find(
      (t) =>
        t.schema.endsWith(suffix) &&
        (scoped ? t.resource.includes("scoped") : !t.resource.includes("scoped")),
    );
  const tuned = find("_t");
  const denorm = find("_d");
  const scoped = find("_s", true);
  const finding = (t: Tuning | undefined, rule: string) => t?.before.find((f) => f.rule === rule);
  const statements = (t: Tuning | undefined, match: RegExp) =>
    (t?.applied ?? []).filter((s) => match.test(s)).map(bare);
  const status = statements(tuned, /status/);
  return [
    {
      id: "status-trigram",
      change: "a trigram index on lower(orders.status)",
      origin: "checkIndexes: fix.sql",
      rule: "search-unindexed",
      finding: finding(tuned, "search-unindexed")?.message ?? null,
      sql: status,
      applied: status.length > 0,
      affects: ["the count statements of a search over every column (wide-search-not-here)"],
      touchesTimedRequests: true,
      note: "Search is open to every column, so the check asks for it from 100,000 rows. No landing request searches status. The count statements of a search over every column can use it; they are measured on the tuned schema only, exact against capped, so no out-of-the-box comparison credits it.",
    },
    {
      id: "copied-name",
      change:
        "orders.customerName copied from the customer, with the index the check then asks for",
      origin: "checkIndexes: advice (copy the name onto orders), then fix.sql for the new column",
      rule: "relation-sort",
      finding: finding(tuned, "relation-sort")?.message ?? null,
      sql: (denorm?.applied ?? []).map(bare),
      applied: (denorm?.applied.length ?? 0) > 0 || denorm !== undefined,
      affects: ["sort-customer-name-plus-count"],
      touchesTimedRequests: true,
      note: "The copy itself is a table change the harness makes while building the schema; the check gives no SQL for a relation sort.",
    },
    {
      id: "capped-count",
      change: 'count: "capped" instead of "exact" (countCap 10,000)',
      origin: "engine option; checkIndexes reports exact-count-large-table from 1,000,000 rows",
      rule: "exact-count-large-table",
      finding: finding(tuned, "exact-count-large-table")?.message ?? null,
      sql: [] as string[],
      applied: true,
      affects: ["every landing request with a count"],
      touchesTimedRequests: true,
      note: "Not an index. This is where most of the tuned gain comes from.",
    },
    {
      id: "facets-split",
      change: "facets.splitAbove: 0, one statement per facet",
      origin: "engine option, from the facets guide; checkIndexes has no finding for it",
      rule: null,
      finding: null,
      sql: [] as string[],
      applied: true,
      affects: ["two-root-facets", "four-mixed-facets"],
      touchesTimedRequests: true,
      note: "Out of the box already uses the engine's default, facets.splitAbove 100,000.",
    },
    {
      id: "scope-index",
      change: "an index on (orgId, createdAt, id) for the scoped setting",
      origin: "applied by hand: checkIndexes describes the problem in words and gives no SQL",
      rule: "default-sort-unindexed",
      finding: finding(scoped, "default-sort-unindexed")?.message ?? null,
      sql: (scoped?.byHand ?? []).map((b) => bare(b.sql)),
      applied: (scoped?.byHand.length ?? 0) > 0,
      affects: ["scoped requests"],
      touchesTimedRequests: true,
      note: "Only the scoped setting has it.",
    },
  ];
}

function build(
  chosen: RunRecord[],
  options: {
    provisional: boolean;
    sizes: number[];
    threshold: number;
    reasons: string[];
    nulls: Array<{
      rows: number;
      request: string;
      ratios: number[];
      verdict: Verdict;
      ratio: number;
      pairs: number;
      min: number;
      max: number;
    }>;
    overLimit: number;
  },
) {
  const profiles: Record<ProfileName, Scenarios> = { "out-of-the-box": {}, tuned: {}, scoped: {} };
  const regressions: string[] = [];
  const withinNoise: string[] = [];
  const nullRange = new Map(options.nulls.map((n) => [n.rows, n]));
  for (const run of chosen)
    for (const profile of PROFILES)
      for (const [scenario, cell] of Object.entries(run.cells[profile] ?? {})) {
        const out: OutCell = { ...cell };
        // The raw pairs stay in the run file.
        delete out.pairedRatios;
        if (cell.pairedRatios?.length) {
          Object.assign(out, judge(cell.pairedRatios));
          // A verdict the null pair could have produced by chance is not one: the same request
          // against itself reached a ratio at least as far from 1 in that run.
          const noise = nullRange.get(run.rows);
          if (noise && noise.pairs > 0 && out.verdict !== "unchanged") {
            const inside =
              out.verdict === "improved" ? out.ratio! <= noise.max : out.ratio! >= noise.min;
            if (inside) {
              out.verdictBeforeNoise = out.verdict;
              out.withinNoise = true;
              withinNoise.push(
                `${profile} ${scenario.replace("landing/", "")} at ${run.rows.toLocaleString("en-US")} rows (${out.ratio}x, ${out.verdict})`,
              );
              out.verdict = "unchanged";
            }
          }
          if (out.verdict === "worse")
            regressions.push(
              `${profile} ${scenario.replace("landing/", "")} at ${run.rows.toLocaleString("en-US")} rows (${out.ratio}x)`,
            );
        }
        (profiles[profile][scenario] ??= {})[String(run.rows)] = out;
      }
  const last = chosen.at(-1);
  const fingerprint = last?.fingerprint;
  const notes = [
    options.provisional
      ? options.reasons.length
        ? `Provisional: ${options.reasons.join("; ")}.`
        : "Provisional: run with --final on a quiet machine to publish final numbers."
      : `Final: every run was taken at or below load ${options.threshold}, nothing failed, the null pair read unchanged, and checkIndexes reports no error for any tuned schema.`,
    'Every number is one engine call end to end: pages and counts through resource.queryIds, capped counts with count: "capped", facets through resource.queryFacets. `parts` and `stages` are the engine\'s own per-statement times from onQuery; `statementsMs` is their sum (statements can overlap, so it can exceed the call time). `maxMs` is the slowest sample; with ten samples a p95 would be the same number.',
    "Landing requests are measured in pairs: out of the box and the setup it is compared with are called one after the other, at least 10 rounds, in a carryover-balanced (Williams) order, so a verdict compares calls made seconds apart. Only the out-of-the-box schema and the one being compared are resident at a time. verdict: improved when the ratio (out of the box / this) stays above 1 in at least 80% of the pairs and its median is at least 1.15; worse when it stays below 1 in at least 80% and the median is at most 1/1.15; otherwise unchanged. `ratio` is the median; `pairsFaster` counts the pairs above 1. Each ratio is against the out-of-the-box calls of its own pair.",
    "setup.nullPairs: the same request against itself, timed as two arms, with the range of its ratios. It must read unchanged with at least 10 pairs and a median within 5% of 1; a verdict whose ratio is inside that range is reported as unchanged (withinNoise).",
    "Tuned is what setup.tuning.changes lists: what engine.checkIndexes({ live: true }) asked for, the engine options that go with its findings, and nothing else. The check's only index for the unchanged schema (a trigram index on status) is used by no landing request, only by the count statements of a search over every column; the gains come from the capped count and the copied name. facets.splitAbove 0 runs the same statements as the default, 100,000, on every size measured here. `<scenario>:count-exact` and `:count-capped` are the count statement alone, from onQuery's count stage on the tuned schema. Facet cells named `<facets>/<variant>` (GROUPING SETS or one statement per facet, in a transaction or on the pool) are informational and carry no verdict.",
    "Out of the box facets use the engine's default, facets.splitAbove 100,000, which already splits the facets of a table of this size; a tuned facets request can therefore come out unchanged.",
    "Data: createdAt grows with id, so a cursor with createdAt desc, id asc is cheap without a tuned index. orgId, status and paid are functions of n: inside tenant 42 every order has status 'paid' and paid = false.",
    ...(options.overLimit
      ? [
          `${options.overLimit} cell(s) are over-limit (a call past ${fingerprint?.timeoutMs ?? 60_000} ms): they carry skipped: "over-limit" and no median.`,
        ]
      : []),
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
      databaseHost: fingerprint?.database ?? null,
      dataset:
        "orders (n rows: customerId (n%20000)+1, orgId (n%100)+1, status by n%5, paid n%2=0, createdAt evenly over 7 years to 2026-11-01, reference ORD-00000001) and customers (20,000 rows)",
      client: `one engine call at a time; paired requests ${MIN_ROUNDS}+ rounds, other requests ${fingerprint?.iterations ?? 10} calls (5 when the warm-up took over 1 s, 3 over 20 s); warm cache`,
      engineCommit: fingerprint?.engineCommit ?? "unknown",
      harness: fingerprint
        ? {
            version: fingerprint.harnessVersion,
            hash: fingerprint.harnessHash,
            runtime: fingerprint.runtime,
            iterations: fingerprint.iterations,
            timeoutMs: fingerprint.timeoutMs,
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
        waitedS: r.load.waitedS ?? null,
        highLoad: r.load.max > options.threshold,
      })),
      nullPairs: options.nulls.map(({ rows, request, verdict, ratio, pairs, min, max }) => ({
        rows,
        request,
        verdict,
        ratio,
        pairs,
        ratioMin: min,
        ratioMax: max,
      })),
      tuning: {
        changes: tunedChanges(last),
        runs: chosen.map((r) => ({ rows: r.rows, schemas: r.tuning })),
      },
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
