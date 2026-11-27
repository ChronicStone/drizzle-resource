/**
 * Writes docs/app/data/bench-landing.json, the numbers behind the landing's benchmark chart,
 * from tools/results/profiles.json. Rerun the benchmark, run this, and the landing follows:
 *
 *   bun tools/landing-bench-data.ts [--measured-on YYYY-MM-DD] [--check] [--source <profiles.json>] [--out <file>]
 *
 * `--check` writes nothing and fails when the committed file differs from what the results give.
 * Every number is a measured median, and whether tuning helped comes from the benchmark's
 * `verdict` and `ratio`, never from comparing numbers here. A missing one stops the script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Verdict = "improved" | "unchanged" | "worse";
type Cell = {
  medianMs?: number;
  verdict?: Verdict;
  ratio?: number;
};
type Profiles = {
  provisional?: boolean;
  sizes: number[];
  setup?: {
    engineCommit?: string;
    /** `select version()` up to " on ", e.g. "PostgreSQL 18.1" */
    database?: string;
    databaseHost?: { cpus?: string } | null;
    harness?: { iterations?: number } | null;
    runs?: Array<{ rows: number; startedAt: string }>;
  };
  profiles: Record<"out-of-the-box" | "tuned", Record<string, Record<string, Cell>>>;
};

/**
 * landing request → scenario in profiles.json. The `landing/*` scenarios are measured for this
 * chart: out of the box with an exact count; tuned as the engine page with the tuned indexes plus
 * a count capped at 10,001 rows. Page and cursor are not tuned (they are already flat).
 */
const SCENARIOS: Record<string, { outOfTheBox: string; tuned?: string }> = {
  page: { outOfTheBox: "page-without-count" },
  cursor: { outOfTheBox: "deep-cursor-id-desc" },
  count: { outOfTheBox: "landing/page-plus-count", tuned: "landing/page-plus-count" },
  // checkIndexes recommends copying customer.name onto orders, so the tuned run sorts the copy
  relationSort: {
    outOfTheBox: "landing/sort-customer-name-plus-count",
    tuned: "landing/sort-customer-name-denormalized-plus-count",
  },
  facets: { outOfTheBox: "landing/four-mixed-facets", tuned: "landing/four-mixed-facets" },
  search: { outOfTheBox: "landing/search-ord-plus-count", tuned: "landing/search-ord-plus-count" },
};
const SIZES = [200_000, 1_000_000, 10_000_000];
const LAST = String(SIZES[SIZES.length - 1]);
const VERDICTS: Verdict[] = ["improved", "unchanged", "worse"];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const check = args.includes("--check");
const root = join(import.meta.dir, "..");
const results = join(root, "tools/results");
const source = flag("--source") ?? join(results, "profiles.json");
const target = flag("--out") ?? join(root, "docs/app/data/bench-landing.json");
const data = JSON.parse(readFileSync(source, "utf8")) as Profiles;

if (typeof data.provisional !== "boolean")
  throw new Error(`${source} must say "provisional": true or false at its top level`);
for (const n of SIZES)
  if (!data.sizes.includes(n))
    throw new Error(`${source} has no ${n.toLocaleString("en-US")}-row run`);

const cellAt = (profile: "out-of-the-box" | "tuned", scenario: string, n: number | string) => {
  const cell = data.profiles[profile]?.[scenario]?.[String(n)];
  if (typeof cell?.medianMs !== "number")
    throw new Error(`${profile} / ${scenario} / ${n} rows: no measured median in ${source}`);
  return cell;
};
const medians = (profile: "out-of-the-box" | "tuned", scenario: string) =>
  SIZES.map((n) => Math.round(cellAt(profile, scenario, n).medianMs! * 1000) / 1000);

const requests = Object.fromEntries(
  Object.entries(SCENARIOS).map(([key, s]) => {
    const outOfTheBox = medians("out-of-the-box", s.outOfTheBox);
    if (!s.tuned)
      // not tuned: the chart keeps these columns as they are and labels them "no change"
      return [key, { outOfTheBox, tuned: outOfTheBox, verdict: "unchanged", ratio: null }];
    const last = cellAt("tuned", s.tuned, LAST);
    if (!last.verdict || !VERDICTS.includes(last.verdict))
      throw new Error(`tuned / ${s.tuned} / ${LAST} rows: no verdict in ${source}`);
    if (typeof last.ratio !== "number")
      throw new Error(`tuned / ${s.tuned} / ${LAST} rows: no ratio in ${source}`);
    return [
      key,
      {
        outOfTheBox,
        tuned: medians("tuned", s.tuned),
        verdict: last.verdict,
        // out of the box ÷ tuned at 10M rows, as the benchmark measured it
        ratio: last.ratio,
      },
    ];
  }),
) as Record<
  string,
  { outOfTheBox: number[]; tuned: number[]; verdict: Verdict; ratio: number | null }
>;

/** requests the landing credits to a tool must get faster; say so when the numbers disagree */
for (const [key, r] of Object.entries(requests)) {
  if (!SCENARIOS[key]!.tuned) continue;
  const moved = r.tuned[2]! / r.outOfTheBox[2]!;
  if (moved >= 0.9)
    console.warn(
      `warning: ${key} is barely faster tuned (${r.outOfTheBox[2]} → ${r.tuned[2]} ms at 10M); the landing shows it unchanged unless the verdict says improved (verdict: ${r.verdict})`,
    );
  if (r.verdict === "improved" && moved >= 0.9)
    console.warn(
      `warning: ${key} has verdict "improved" but the numbers barely moved; check ${source}`,
    );
  if (r.verdict !== "improved" && moved < 0.5)
    console.warn(
      `warning: ${key} has verdict "${r.verdict}" but is ${Math.round(1 / moved)}× faster; check ${source}`,
    );
}

const commit = data.setup?.engineCommit ?? readFileSync(join(results, "engine-commit.txt"), "utf8");
/** What the results say about the run; a file from before these fields falls back to the first run's setup. */
const latestRun = (data.setup?.runs ?? [])
  .map((r) => r.startedAt)
  .sort()
  .at(-1);
const postgres = /PostgreSQL ([\d.]+)/.exec(data.setup?.database ?? "")?.[1];
const cpus = Number(data.setup?.databaseHost?.cpus);
const LEGACY = { measuredOn: "2026-11-26", postgres: "18.7", cpus: 4, runs: 10 };
if (!latestRun || !postgres || !Number.isFinite(cpus) || !data.setup?.harness?.iterations)
  console.warn(
    `warning: ${source} does not say when, on which PostgreSQL, with how many CPUs or runs it was measured; using the first harness's values`,
  );
const out = {
  $comment:
    "Numbers for the landing's benchmark chart. Regenerate with `bun tools/landing-bench-data.ts` from tools/results/profiles.json; do not edit by hand. Times are medians in milliseconds, one per table size; ratio is out of the box ÷ tuned at 10M rows.",
  provisional: data.provisional,
  measuredOn: flag("--measured-on") ?? latestRun?.slice(0, 10) ?? LEGACY.measuredOn,
  engine: commit.trim().slice(0, 7),
  postgres: postgres ?? LEGACY.postgres,
  cpus: Number.isFinite(cpus) ? cpus : LEGACY.cpus,
  clients: 1,
  runs: data.setup?.harness?.iterations ?? LEGACY.runs,
  sizes: SIZES,
  requests,
  tunedSettings: { countCap: 10_000 },
};

if (check) {
  // Compare the data, not the text, so the formatter can lay the file out as it likes.
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(target, "utf8"));
  } catch {}
  if (JSON.stringify(current) !== JSON.stringify(out)) {
    console.error(
      `${target} is out of date with ${source}. Run \`bun tools/landing-bench-data.ts\` and commit it.`,
    );
    process.exit(1);
  }
  console.log(`${target} matches ${source}`);
} else {
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote ${target}${data.provisional ? " (provisional numbers)" : ""}`);
  for (const [key, r] of Object.entries(requests))
    console.log(
      `  ${key.padEnd(13)} ${r.outOfTheBox.join(" / ")} → ${r.tuned.join(" / ")} ms  (${r.verdict}${r.ratio ? `, ${r.ratio}×` : ""})`,
    );
}
