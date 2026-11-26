import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOAD_THRESHOLD, root, runsDir, sizeLabel } from "./config.ts";
import { FACETS, FACET_VARIANTS } from "./scenarios.ts";
import type { Cell } from "./measure.ts";
import type { RunRecord } from "./run.ts";

type ProfileKey = "out-of-the-box" | "tuned" | "scoped";
type Verdict = "improved" | "unchanged" | "worse";
type OutCell = Cell & { verdict?: Verdict; ratio?: number; ratioMeaning?: string };

const PROFILE_OF: Record<RunRecord["profile"], ProfileKey> = {
  "out-of-the-box": "out-of-the-box",
  tuned: "tuned",
  scoped: "scoped",
  "tuned-denormalized": "tuned",
};

/** improved above 1.1x, worse below 0.9x, unchanged between them or when the gap is under 0.3 ms. */
export function judge(before: number, after: number) {
  const ratio = before / after;
  const verdict: Verdict =
    Math.abs(after - before) < 0.3 || (ratio >= 0.9 && ratio <= 1.1)
      ? "unchanged"
      : ratio > 1.1
        ? "improved"
        : "worse";
  return {
    verdict,
    ratio: Math.round(ratio * 100) / 100,
    ratioMeaning: "out-of-the-box median / this median; above 1 is faster",
  };
}

export function readRuns(): RunRecord[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("profiles"))
      .map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf8")) as RunRecord);
  } catch {
    return [];
  }
}

/** The run to publish for each profile and size: the one taken under the lowest load. */
export function bestRuns(runs: RunRecord[]): RunRecord[] {
  const best = new Map<string, RunRecord>();
  for (const run of runs) {
    const key = `${run.profile}/${run.rows}`;
    const current = best.get(key);
    if (!current || run.load.max < current.load.max) best.set(key, run);
  }
  return [...best.values()];
}

const comparable = (profile: ProfileKey, key: string) => {
  if (key === "landing/page-plus-count-exact") return "landing/page-plus-count";
  if (key === "landing/sort-customer-name-denormalized-plus-count")
    return "landing/sort-customer-name-plus-count";
  return key;
};

export function assemble(runs: RunRecord[], options: { final: boolean; sizes: number[] }) {
  const chosen = bestRuns(runs).filter((r) => options.sizes.includes(r.rows));
  const profiles: Record<ProfileKey, Record<string, Record<string, OutCell>>> = {
    "out-of-the-box": {},
    tuned: {},
    scoped: {},
  };
  for (const run of chosen)
    for (const [scenario, cell] of Object.entries(run.cells))
      (profiles[PROFILE_OF[run.profile]][scenario] ??= {})[String(run.rows)] = { ...cell };

  // Facets: the landing value is the fastest of the four ways to run them, as the engine runs each.
  for (const facet of FACETS)
    for (const rows of options.sizes) {
      const ways = FACET_VARIANTS.map((v) => ({
        key: v.key,
        strategy: v.strategy,
        cell: profiles.tuned[`${facet.name}/${v.key}`]?.[String(rows)],
      }));
      const timed = ways.filter((o) => typeof o.cell?.medianMs === "number");
      if (timed.length === 0) continue;
      const win = timed.reduce((a, b) => (b.cell!.medianMs! < a.cell!.medianMs! ? b : a));
      const cell: OutCell = {
        ...win.cell!,
        uses: win.key,
        setting: win.strategy === "split" ? "facets.splitAbove: 0" : "facets.splitAbove: Infinity",
        all: Object.fromEntries(timed.map((o) => [o.key, o.cell!.medianMs])),
      };
      (profiles.tuned[`landing/${facet.name}`] ??= {})[String(rows)] = cell;
    }

  // Verdicts: every tuned and scoped landing request against the same request out of the box.
  const regressions: string[] = [];
  for (const profile of ["tuned", "scoped"] as const)
    for (const [key, bySize] of Object.entries(profiles[profile])) {
      if (!key.startsWith("landing/")) continue;
      for (const [rows, cell] of Object.entries(bySize)) {
        const before = profiles["out-of-the-box"][comparable(profile, key)]?.[rows];
        if (typeof cell.medianMs !== "number" || typeof before?.medianMs !== "number") continue;
        Object.assign(cell, judge(before.medianMs, cell.medianMs));
        if (cell.verdict === "worse")
          regressions.push(
            `${profile} ${key.slice(8)} at ${Number(rows).toLocaleString("en-US")} rows (${cell.ratio}x)`,
          );
      }
    }

  const runsList = chosen
    .map((r) => ({
      profile: r.profile,
      rows: r.rows,
      startedAt: r.startedAt,
      loadStart: r.load.start,
      loadEnd: r.load.end,
      loadMax: r.load.max,
      highLoad: r.highLoad,
    }))
    .sort((a, b) => a.rows - b.rows || a.profile.localeCompare(b.profile));
  const busy = runsList.filter((r) => r.highLoad);
  const expected = options.sizes.length * 4;
  const complete = chosen.length >= expected;
  const provisional = !(options.final && busy.length === 0 && complete);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const environment = chosen[0]?.environment;
  const notes = [
    provisional
      ? options.final
        ? `Not final: ${busy.length ? `${busy.length} run(s) were taken above load ${LOAD_THRESHOLD} (${busy.map((r) => `${r.profile} ${sizeLabel(r.rows)}`).join(", ")})` : "some profile or size has no run"}. Rerun them when the machine is quiet.`
        : "Provisional: run with --final on a quiet machine to publish final numbers."
      : `Final: every run was taken at or below load ${LOAD_THRESHOLD}.`,
    'Every number is one engine call end to end: pages and counts through resource.queryIds, capped counts with count: "capped", facets through resource.queryFacets. `parts` and `stages` are the engine\'s own per-statement times from onQuery; `statementsMs` is their sum (statements can overlap, so it can exceed the call time).',
    "`<scenario>:count-exact` and `:count-capped` are the count statement alone, read from onQuery's count stage of a request with that count mode.",
    "Out of the box is the engine's default configuration, including count: exact on the landing requests and facets.splitAbove 100,000 for facets. Tuned adds customers (name) and orders (createdAt desc, id asc), counts capped at the resource's countCap (10,000). Scoped adds orders (orgId, createdAt, id) and scopes the resource to orgId 42 (1% of the rows).",
    "Facets: tuned landing value = the fastest of GROUPING SETS or one statement per facet (facets.splitAbove Infinity or 0), each in a transaction (statements follow each other on one connection) or on the pool (up to four at a time). Fields: uses, setting, all.",
    "verdict: ratio = out-of-the-box median / this median. improved above 1.1, worse below 0.9, unchanged between or when the gap is under 0.3 ms.",
    "Data: createdAt grows with id, so a cursor with createdAt desc, id asc is cheap without a tuned index. orgId, status and paid are functions of n: inside tenant 42 every order has status 'paid' and paid = false.",
    ...(regressions.length
      ? [
          `Worse than out of the box: ${regressions.join("; ")}. Do not present these as improvements.`,
        ]
      : []),
  ];
  return {
    provisional,
    sizes: options.sizes,
    setup: {
      database: environment?.version.split(" on ")[0] ?? "unknown",
      postgresSettings: environment?.settings ?? {},
      dataset:
        "orders (n rows: customerId (n%20000)+1, orgId (n%100)+1, status by n%5, paid n%2=0, createdAt evenly over 7 years to 2026-11-01, reference ORD-00000001) and customers (20,000 rows)",
      client:
        "single client, medians of 10 calls (5 when the warm-up took over 1 s, 3 over 20 s), warm cache, one engine call at a time",
      engineCommit: commit,
      loadThreshold: LOAD_THRESHOLD,
      handSql:
        "none of the published numbers: setup SQL only (schema, indexes, ANALYZE). Every timing is an engine call.",
      runs: runsList,
    },
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([name, scenarios]) => [
        name,
        Object.fromEntries(Object.entries(scenarios).sort(([a], [b]) => a.localeCompare(b))),
      ]),
    ),
    notes,
  };
}

export function writeProfiles(file: string, data: ReturnType<typeof assemble>) {
  writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
}
