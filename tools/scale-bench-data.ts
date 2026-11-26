/**
 * Writes docs/app/data/bench-scale.json, the numbers behind the docs' Scale pages, from the
 * benchmark results in tools/results. Rerun the benchmark, run this, and the pages follow:
 *
 *   bun tools/scale-bench-data.ts [--measured-on YYYY-MM-DD] [--check]
 *
 * `--check` writes nothing and fails when the committed file differs from what the results give,
 * so stale numbers cannot ship. Same rules as tools/landing-bench-data.ts: every number is a
 * measured median or p95 copied from a results file, a missing scenario stops the script, and
 * whether tuning helped comes from the benchmark's `verdict`, never from comparing numbers here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Verdict = "improved" | "unchanged" | "worse";
type Cell = {
  medianMs?: number;
  p95Ms?: number;
  method?: string;
  verdict?: Verdict;
  ratio?: number;
  rowCount?: number;
  uses?: string;
  requiresEngineChange?: boolean;
  parts?: Record<string, number | string>;
};
type ProfileName = "out-of-the-box" | "tuned" | "scoped";
type Profiles = {
  provisional?: boolean;
  sizes: number[];
  setup: Record<string, unknown> & { engineCommit?: string };
  profiles: Record<ProfileName, Record<string, Record<string, Cell>>>;
};
type HarnessRun = {
  timestamp: string;
  rows: number;
  iterations: number;
  concurrency?: number;
  note?: string;
  environment: { version: string; work_mem: string };
  measurements: Array<{
    scenario: string;
    variants: Record<string, { medianMs: number; p95Ms: number; requestsPerSecond: number }>;
  }>;
  scans?: Array<{
    sorting: Array<{ key: string; dir: string }>;
    results: Array<{ variant: string; durationMs: number }>;
  }>;
};

const args = process.argv.slice(2);
const check = args.includes("--check");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const root = join(import.meta.dir, "..");
const results = join(root, "tools/results");
const target = join(root, "docs/app/data/bench-scale.json");
const read = <T>(file: string) => JSON.parse(readFileSync(join(results, file), "utf8")) as T;

const SIZES = [200_000, 1_000_000, 10_000_000];
const VERDICTS: Verdict[] = ["improved", "unchanged", "worse"];
const PROFILES_FILE = "profiles.json";
const data = read<Profiles>(PROFILES_FILE);
if (typeof data.provisional !== "boolean")
  throw new Error(`${PROFILES_FILE} must say "provisional": true or false at its top level`);
for (const n of SIZES)
  if (!data.sizes.includes(n))
    throw new Error(`${PROFILES_FILE} has no ${n.toLocaleString("en-US")}-row run`);

const round = (ms: number) => Math.round(ms * 1000) / 1000;
const cellAt = (profile: ProfileName, scenario: string, n: number) => {
  const cell = data.profiles[profile]?.[scenario]?.[String(n)];
  if (typeof cell?.medianMs !== "number")
    throw new Error(`${profile} / ${scenario} / ${n} rows: no measured median in ${PROFILES_FILE}`);
  return cell;
};
/** One series: a median and a p95 per table size, and how they were measured. */
const series = (profile: ProfileName, scenario: string) => {
  const cells = SIZES.map((n) => cellAt(profile, scenario, n));
  const methods = [...new Set(cells.map((c) => c.method ?? "engine"))];
  return {
    scenario,
    ms: cells.map((c) => round(c.medianMs!)),
    p95: cells.map((c) => (typeof c.p95Ms === "number" ? round(c.p95Ms) : null)),
    method: methods.join(", "),
  };
};
/** A series measured against out of the box: the benchmark's verdict for every size. */
const judged = (profile: ProfileName, scenario: string) => {
  const s = series(profile, scenario);
  const cells = SIZES.map((n) => cellAt(profile, scenario, n));
  const verdict = cells.map((c, i) => {
    if (!c.verdict || !VERDICTS.includes(c.verdict))
      throw new Error(
        `${profile} / ${scenario} / ${SIZES[i]} rows: no verdict in ${PROFILES_FILE}`,
      );
    return c.verdict;
  });
  return {
    ...s,
    verdict,
    ratio: cells.map((c) => c.ratio ?? null),
    engineChange: cells.some((c) => c.requiresEngineChange === true),
  };
};

/**
 * The requests of "How it scales" and the benchmark tables. `tuned` names the tuned scenario and
 * what tuning did; requests without one were not tuned (pages and cursors are already flat).
 */
const REQUESTS: Record<
  string,
  { label: string; shape: string; outOfTheBox: string; tuned?: { scenario: string; how: string } }
> = {
  page: {
    label: "Page of 50",
    shape: "sort createdAt desc · count none",
    outOfTheBox: "page-without-count",
  },
  cursor: {
    label: "Cursor page, 90% deep",
    shape: "cursor · sort createdAt desc",
    outOfTheBox: "deep-cursor-id-desc",
  },
  ids: {
    label: "Filter on 10 ids",
    shape: "filter id:isAnyOf · count none",
    outOfTheBox: "id-selection-10-page-only",
  },
  count: {
    label: "Page + count",
    shape: "sort createdAt desc · count exact",
    outOfTheBox: "landing/page-plus-count",
    tuned: { scenario: "landing/page-plus-count", how: "capped count" },
  },
  relationSort: {
    label: "Sort by customer.name + count",
    shape: "sort customer.name asc · count exact",
    outOfTheBox: "landing/sort-customer-name-plus-count",
    tuned: {
      scenario: "landing/sort-customer-name-denormalized-plus-count",
      how: "name copied onto orders, capped count",
    },
  },
  relationSortIndexOnly: {
    label: "Sort by customer.name + count",
    shape: "sort customer.name asc · count exact",
    outOfTheBox: "landing/sort-customer-name-plus-count",
    tuned: {
      scenario: "landing/sort-customer-name-plus-count",
      how: "index on customers (name), capped count",
    },
  },
  twoFacets: {
    label: "2 facets",
    shape: "facets status,paid",
    outOfTheBox: "landing/two-root-facets",
    tuned: {
      scenario: "landing/two-root-facets",
      how: "fastest of shared and separate statements",
    },
  },
  fourFacets: {
    label: "4 facets, 2 through customer",
    shape: "facets status,paid,customer.segment,customer.name",
    outOfTheBox: "landing/four-mixed-facets",
    tuned: {
      scenario: "landing/four-mixed-facets",
      how: "fastest of shared and separate statements",
    },
  },
  searchCommon: {
    label: 'Search "ord" + count',
    shape: "search reference,customer.name · count exact",
    outOfTheBox: "landing/search-ord-plus-count",
    tuned: { scenario: "landing/search-ord-plus-count", how: "capped count" },
  },
  searchCustomer: {
    label: 'Search "customer" + count',
    shape: "search reference,customer.name · count exact",
    outOfTheBox: "landing/search-customer-plus-count",
    tuned: { scenario: "landing/search-customer-plus-count", how: "capped count" },
  },
  relationSearch: {
    label: 'Search customer.name "customer 1" + count',
    shape: "search customer.name · count exact",
    outOfTheBox: "landing/relation-search-plus-count",
    tuned: { scenario: "landing/relation-search-plus-count", how: "capped count" },
  },
  searchRareReference: {
    label: "Search one reference + count",
    shape: "search reference,customer.name · count exact",
    outOfTheBox: "landing/search-rare-reference-plus-count",
    tuned: { scenario: "landing/search-rare-reference-plus-count", how: "capped count" },
  },
  searchRareCustomer: {
    label: "Search one customer + count",
    shape: "search reference,customer.name · count exact",
    outOfTheBox: "landing/search-rare-customer-plus-count",
    tuned: { scenario: "landing/search-rare-customer-plus-count", how: "capped count" },
  },
  // every column searched, numbers included: no index can serve the casts
  wideCommon: {
    label: 'Search every column for "customer"',
    shape: "search 9 fields · count none",
    outOfTheBox: "wide-search-customer-none",
  },
  wideCommonCount: {
    label: 'Search every column for "customer" + count',
    shape: "search 9 fields · count exact",
    outOfTheBox: "wide-search-customer-exact",
  },
  wideRare: {
    label: 'Search every column for "19999"',
    shape: "search 9 fields · count none",
    outOfTheBox: "wide-search-19999-none",
  },
  wideNoMatch: {
    label: "Search every column, no match",
    shape: "search 9 fields · count none",
    outOfTheBox: "wide-search-not-here-none",
  },
};

const requests = Object.fromEntries(
  Object.entries(REQUESTS).map(([key, r]) => [
    key,
    {
      label: r.label,
      shape: r.shape,
      outOfTheBox: series("out-of-the-box", r.outOfTheBox),
      tuned: r.tuned ? { how: r.tuned.how, ...judged("tuned", r.tuned.scenario) } : null,
    },
  ]),
);

/** Inside one tenant of 100 (the `scoped` profile), next to the whole table. */
const SCOPED: Record<string, { label: string; scoped: string; outOfTheBox: string }> = {
  countExact: {
    label: "Page + exact count",
    scoped: "landing/page-plus-count-exact",
    outOfTheBox: "landing/page-plus-count",
  },
  countCapped: {
    label: "Page + capped count",
    scoped: "landing/page-plus-count",
    outOfTheBox: "landing/page-plus-count",
  },
  relationSearch: {
    label: 'Search customer.name "customer 1" + count',
    scoped: "landing/relation-search-plus-count",
    outOfTheBox: "landing/relation-search-plus-count",
  },
  twoFacets: {
    label: "2 facets",
    scoped: "landing/two-root-facets",
    outOfTheBox: "landing/two-root-facets",
  },
};
const scoped = Object.fromEntries(
  Object.entries(SCOPED).map(([key, r]) => [
    key,
    {
      label: r.label,
      outOfTheBox: series("out-of-the-box", r.outOfTheBox),
      scoped: judged("scoped", r.scoped),
    },
  ]),
);

/** The count statement alone, exact and capped, measured as SQL on the tuned schema. */
const COUNTS: Record<string, { label: string; scenario: string }> = {
  all: { label: "Every row", scenario: "page-exact-count" },
  searchCommon: { label: 'Search "ord" (every row)', scenario: "cross-table-search-ord" },
  searchCustomer: {
    label: 'Search "customer" (every row)',
    scenario: "cross-table-search-customer",
  },
  relationSearch: { label: 'customer.name "customer 1"', scenario: "relation-search-page" },
  rareCustomer: { label: "One customer's orders", scenario: "cross-table-search-customer-19999" },
  rareReference: { label: "One reference", scenario: "cross-table-search-ORD-00199999" },
  ids: { label: "1,000 ids", scenario: "id-selection-1000" },
  noMatch: { label: "No match, every column searched", scenario: "wide-search-not-here-exact" },
};
const counts = Object.fromEntries(
  Object.entries(COUNTS).map(([key, c]) => [
    key,
    {
      label: c.label,
      exact: series("tuned", `${c.scenario}:count-exact`),
      capped: series("tuned", `${c.scenario}:count-capped`),
      matches: SIZES.map((n) => cellAt("tuned", `${c.scenario}:count-exact`, n).rowCount ?? null),
    },
  ]),
);

/** Facets: one GROUPING SETS statement or one statement per facet, on one connection or several. */
const FACET_VARIANTS = [
  "grouping-sets/sequential",
  "grouping-sets/concurrent",
  "separate/sequential",
  "separate/concurrent",
];
const facetVariants = Object.fromEntries(
  (["two-root-facets", "four-mixed-facets"] as const).map((scenario) => [
    scenario === "two-root-facets" ? "twoFacets" : "fourFacets",
    Object.fromEntries(FACET_VARIANTS.map((v) => [v, series("tuned", `${scenario}/${v}`)])),
  ]),
);

// ---------- the 200,000-row harness runs: load, 2.4.1, scans ----------
const LOAD_FILE = "postgres-concurrency-32-2026-11-18.json";
const SINGLE_FILE = "postgres-2026-11-18.json";
const measurement = (run: HarnessRun, file: string, scenario: string, variant: string) => {
  const m = run.measurements.find((x) => x.scenario === scenario)?.variants[variant];
  if (!m) throw new Error(`${file}: no ${variant} measurement for ${scenario}`);
  return m;
};
const HARNESS: Array<{ key: string; label: string; note?: string; scenario: string }> = [
  { key: "page", label: "Page", scenario: "page-without-count" },
  {
    key: "cursor",
    label: "Cursor page",
    note: "180,000 rows in",
    scenario: "deep-cursor-id-asc",
  },
  { key: "ids", label: "1,000 ids filter", scenario: "id-selection-1000" },
  { key: "count", label: "Page + exact count", scenario: "page-exact-count" },
  { key: "relationSearch", label: "Search a relation + count", scenario: "relation-search-page" },
  { key: "threeFacets", label: "3 facets", note: "one statement", scenario: "three-root-facets" },
  {
    key: "filteredFacets",
    label: "Filtered facets",
    note: "each ignores its own filter",
    scenario: "filtered-exclude-self-facets",
  },
  { key: "fiveFacets", label: "5 facets", note: "two statements", scenario: "five-mixed-facets" },
];
const loadRun = read<HarnessRun>(LOAD_FILE);
const singleRun = read<HarnessRun>(SINGLE_FILE);
const harnessSetup = (run: HarnessRun, file: string) => ({
  file,
  measuredOn: run.timestamp.slice(0, 10),
  rows: run.rows,
  iterations: run.iterations,
  concurrency: run.concurrency ?? 1,
  postgres: run.environment.version.split(" ").slice(0, 2).join(" "),
  workMem: run.environment.work_mem,
});
const load = {
  ...harnessSetup(loadRun, LOAD_FILE),
  note: loadRun.note ?? "",
  requests: HARNESS.map((h) => {
    const m = measurement(loadRun, LOAD_FILE, h.scenario, "optimized");
    return {
      key: h.key,
      label: h.label,
      note: h.note ?? null,
      rps: Math.round(m.requestsPerSecond),
      p95: round(m.p95Ms),
      ms: round(m.medianMs),
    };
  }),
};
const HISTORY = [
  "page",
  "cursor",
  "count",
  "relationSearch",
  "threeFacets",
  "fiveFacets",
  "filteredFacets",
];
const history = {
  ...harnessSetup(singleRun, SINGLE_FILE),
  baseline: "2.4.1",
  requests: HISTORY.map((key) => {
    const h = HARNESS.find((x) => x.key === key)!;
    return {
      key,
      label: h.note ? `${h.label}, ${h.note}` : h.label,
      before: round(measurement(singleRun, SINGLE_FILE, h.scenario, "baseline").medianMs),
      after: round(measurement(singleRun, SINGLE_FILE, h.scenario, "optimized").medianMs),
    };
  }),
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const scanLabel: Record<string, string> = {
  "year,month": "Sorted by date",
  "account.name": "Sorted by customer",
};
const scans = {
  ...harnessSetup(singleRun, SINGLE_FILE),
  requests: (singleRun.scans ?? []).map((s) => {
    const key = s.sorting.map((x) => x.key).join(",");
    const of = (variant: string) => {
      const values = s.results.filter((r) => r.variant === variant).map((r) => r.durationMs);
      if (!values.length) throw new Error(`${SINGLE_FILE}: no ${variant} scan for ${key}`);
      return round(median(values));
    };
    return { label: scanLabel[key] ?? key, pages: of("optimized-pages"), scan: of("scan") };
  }),
};
if (scans.requests.length === 0) throw new Error(`${SINGLE_FILE}: no scans`);

const commit = data.setup.engineCommit ?? readFileSync(join(results, "engine-commit.txt"), "utf8");
const previous = (() => {
  try {
    return JSON.parse(readFileSync(target, "utf8")) as { measuredOn?: string };
  } catch {
    return {};
  }
})();
const out = {
  $comment:
    "Numbers for the docs' Scale pages. Regenerate with `bun tools/scale-bench-data.ts` from tools/results; do not edit by hand. Times are milliseconds, one per table size.",
  provisional: data.provisional,
  measuredOn: flag("--measured-on") ?? previous.measuredOn ?? new Date().toISOString().slice(0, 10),
  engine: commit.trim().slice(0, 7),
  source: `tools/results/${PROFILES_FILE}`,
  setup: {
    database: data.setup.database,
    postgresSettings: data.setup.postgresSettings,
    dataset: data.setup.dataset,
    client: data.setup.client,
    profiles: data.setup.profileDefinitions,
    engineNote: data.setup.engineNote,
  },
  sizes: SIZES,
  requests,
  scoped,
  counts,
  facetVariants,
  load,
  history,
  scans,
};
const text = `${JSON.stringify(out, null, 2)}\n`;
if (check) {
  // Compare the data, not the text, so the formatter can lay the file out as it likes.
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(target, "utf8"));
  } catch {}
  if (JSON.stringify(current) !== JSON.stringify(out)) {
    console.error(
      `${target} is out of date with tools/results. Run \`bun tools/scale-bench-data.ts\` and commit it.`,
    );
    process.exit(1);
  }
  console.log(`${target} matches tools/results`);
} else {
  writeFileSync(target, text);
  console.log(`wrote ${target}${data.provisional ? " (provisional numbers)" : ""}`);
  for (const [key, r] of Object.entries(requests))
    console.log(
      `  ${key.padEnd(22)} ${r.outOfTheBox.ms.join(" / ")}${r.tuned ? ` → ${r.tuned.ms.join(" / ")} (${r.tuned.verdict.join(", ")})` : ""}`,
    );
}
