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
  maxMs?: number;
  skipped?: string;
  method?: string;
  verdict?: Verdict;
  ratio?: number;
  rowCount?: number;
  uses?: string;
  parts?: Record<string, number | string>;
};
type ProfileName = "out-of-the-box" | "tuned" | "scoped";
type TunedChange = {
  id: string;
  change: string;
  origin: string;
  rule: string | null;
  finding: string | null;
  sql: string[];
  applied: boolean;
  affects: string[];
  touchesTimedRequests: boolean;
  note: string;
};
type NullPair = {
  rows: number;
  verdict: Verdict;
  ratio: number;
  ratioMin: number;
  ratioMax: number;
};
type Profiles = {
  provisional?: boolean;
  sizes: number[];
  setup: {
    database: string;
    postgresSettings: Record<string, string | number>;
    dataset: string;
    client: string;
    engineCommit?: string;
    handSql?: string;
    databaseHost?: { via: string; cpus: string; memory: string } | null;
    harness?: { timeoutMs?: number } | null;
    /** Written by the first harness, before \`setup.tuning\` existed. */
    profileDefinitions?: Record<string, string>;
    engineNote?: string;
    nullPairs?: NullPair[];
    tuning?: { changes: TunedChange[]; runs: unknown[] };
  };
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
const profilesPath = flag("--profiles");
const data = profilesPath
  ? (JSON.parse(readFileSync(profilesPath, "utf8")) as Profiles)
  : read<Profiles>(PROFILES_FILE);
if (typeof data.provisional !== "boolean")
  throw new Error(`${PROFILES_FILE} must say "provisional": true or false at its top level`);
for (const n of SIZES)
  if (!data.sizes.includes(n))
    throw new Error(`${PROFILES_FILE} has no ${n.toLocaleString("en-US")}-row run`);

const round = (ms: number) => Math.round(ms * 1000) / 1000;
/** A file written by the first harness has no \`setup.tuning\`; its wording is kept as it was. */
const legacy = !data.setup.tuning;
/** The limit a call may take, in seconds: what an over-limit cell was cut off at. */
const limitSeconds = (data.setup.harness?.timeoutMs ?? 60_000) / 1000;
const isOver = (cell: Cell | undefined) => cell?.skipped === "over-limit";
const cellAt = (profile: ProfileName, scenario: string, n: number) => {
  const cell = data.profiles[profile]?.[scenario]?.[String(n)];
  // A request past the limit is a result: the pages say so instead of showing a time.
  if (isOver(cell)) return cell!;
  if (cell?.skipped)
    throw new Error(`${profile} / ${scenario} / ${n} rows: ${cell.skipped} in ${PROFILES_FILE}`);
  if (typeof cell?.medianMs !== "number")
    throw new Error(`${profile} / ${scenario} / ${n} rows: no measured median in ${PROFILES_FILE}`);
  return cell;
};
/** One series: a median and the slowest sample per table size, and how they were measured. */
const series = (profile: ProfileName, scenario: string) => {
  const cells = SIZES.map((n) => cellAt(profile, scenario, n));
  const methods = [...new Set(cells.map((c) => c.method ?? "engine"))];
  return {
    scenario,
    ms: cells.map((c) => (isOver(c) ? null : round(c.medianMs!))),
    /** The limit in seconds where the request ran past it, else null. */
    over: cells.map((c) => (isOver(c) ? limitSeconds : null)),
    max: cells.map((c) => (typeof c.maxMs === "number" ? round(c.maxMs) : null)),
    method: methods.join(", "),
  };
};
/** A series measured against out of the box: the benchmark's verdict for every size. */
const judged = (profile: ProfileName, scenario: string, reference: { over: (number | null)[] }) => {
  const s = series(profile, scenario);
  const cells = SIZES.map((n) => cellAt(profile, scenario, n));
  const verdict = cells.map((c, i) => {
    // No pairs, no verdict, when either side ran past the limit.
    if (isOver(c) || (reference.over[i] !== null && !c.verdict)) return null;
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
  };
};

/** What the tuned facets setting was: the first harness took the fastest of four, the later ones fix one. */
const FACETS_HOW = legacy
  ? "fastest of shared and separate statements"
  : "one statement per facet (facets.splitAbove: 0)";

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
  twoFacets: {
    label: "2 facets",
    shape: "facets status,paid",
    outOfTheBox: "landing/two-root-facets",
    tuned: {
      scenario: "landing/two-root-facets",
      how: FACETS_HOW,
    },
  },
  fourFacets: {
    label: "4 facets, 2 through customer",
    shape: "facets status,paid,customer.segment,customer.name",
    outOfTheBox: "landing/four-mixed-facets",
    tuned: {
      scenario: "landing/four-mixed-facets",
      how: FACETS_HOW,
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
  Object.entries(REQUESTS).map(([key, r]) => {
    const outOfTheBox = series("out-of-the-box", r.outOfTheBox);
    return [
      key,
      {
        label: r.label,
        shape: r.shape,
        outOfTheBox,
        tuned: r.tuned
          ? { how: r.tuned.how, ...judged("tuned", r.tuned.scenario, outOfTheBox) }
          : null,
      },
    ];
  }),
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
  Object.entries(SCOPED).map(([key, r]) => {
    const outOfTheBox = series("out-of-the-box", r.outOfTheBox);
    return [key, { label: r.label, outOfTheBox, scoped: judged("scoped", r.scoped, outOfTheBox) }];
  }),
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
/**
 * What each profile contains, in words, written from the results file: the tuned changes are
 * listed from `setup.tuning`, with the tool that asked for each, so the page says exactly what
 * "tuned" means and which of it touches no timed request.
 */
function profileDefinitions() {
  const changes = (data.setup.tuning?.changes ?? []).filter((c) => c.applied);
  if (changes.length === 0) {
    // A results file from before `setup.tuning` carries the words itself.
    if (data.setup.profileDefinitions) return data.setup.profileDefinitions;
    throw new Error(`${PROFILES_FILE} has no setup.tuning.changes`);
  }
  const list = (cs: TunedChange[]) => cs.map((c) => `${c.change} (${c.origin})`).join("; ");
  const idle = changes.filter((c) => !c.touchesTimedRequests).map((c) => c.change);
  const scope = changes.find((c) => c.id === "scope-index");
  return {
    "out-of-the-box":
      "The schema the benchmark starts with: primary keys, an index on orders (createdAt, id) and one on orders (customerId), trigram indexes on lower(orders.reference) and lower(customers.name). Exact counts; facets use the engine's default, facets.splitAbove 100,000.",
    tuned: `${list(changes.filter((c) => c.id !== "scope-index"))}.${idle.length ? ` Of these, ${idle.join(" and ")} is used by no timed request.` : ""}`,
    scoped: `Tuned, with the resource scoped to one tenant of 100 (orgId 42)${scope ? `: ${scope.change} (${scope.origin})` : ""}. Capped counts.`,
  };
}
/**
 * "How it was measured", from what the file says: a file from the first harness measured counts
 * and facets as SQL; the later ones measure everything through the engine, in pairs.
 */
function methodParagraphs(): string[] {
  if (legacy)
    return [
      "Each request runs through the engine (`engine`), or as the SQL statement the engine would send, timed with `psql` inside the database container (`hand-sql`). The footnote under each table says which. Hand SQL leaves out the network and JavaScript, so compare numbers measured the same way.",
      "Tuned values for requests with a count add two medians: the engine's page statement without a count, and the capped count statement run as SQL. The engine measured predates capped counts, so the count could not run through it. The facet comparison is SQL too: the engine of this run shares one `GROUPING SETS` statement between root facets.",
      "Numbers are warm-cache medians after one warm-up call; a cold first request is slower.",
    ];
  return [
    'Every request runs through the engine, from Node over TCP, timed end to end. Counts that are capped use `count: "capped"`, facets go through `queryFacets`, and the engine\'s own per-statement times (`onQuery`) give the parts of a request. No number here is hand-written SQL.',
    'A request that tuning changes is called against the out-of-the-box schema and the tuned one in turn, at least 10 rounds, in an order in which each follows the other equally often. Only those two schemas are resident in the database at a time. The benchmark calls a request faster or slower only when at least 80% of its rounds agree and the median ratio is at least 15% from 1; anything else reads "no change".',
    "The same request against itself is timed as a control: a gain the control could have produced is reported as no change.",
    '"Tuned" is what `engine.checkIndexes()` asked for plus the engine options that answer its findings; the table above lists every change and the finding behind it, and says which of them touches no timed request.',
    "Numbers are warm-cache medians after an untimed identical call; a cold first request is slower.",
  ];
}
const engineNote = () =>
  data.setup.tuning ? engineNoteFromTuning() : (data.setup.engineNote ?? engineNoteFromTuning());
const engineNoteFromTuning = () =>
  `Every timing is an engine call at commit ${commit.trim().slice(0, 7)}: pages and counts through queryIds, counts capped with count: "capped", facets through queryFacets, per-statement times from onQuery.`;

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
    profiles: profileDefinitions(),
    engineNote: engineNote(),
    tuning: data.setup.tuning ?? null,
    databaseHost: data.setup.databaseHost ?? null,
    method: methodParagraphs(),
    nullPairs: data.setup.nullPairs ?? [],
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
