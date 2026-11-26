/**
 * Writes docs/app/data/bench-landing.json, the numbers behind the landing's benchmark chart,
 * from a benchmark run's profiles.json. Rerun the benchmark, run this, and the landing follows:
 *
 *   bun tools/landing-bench-data.ts [tools/results/profiles.json] [--engine <sha>] [--measured-on YYYY-MM-DD] [--out <file>]
 *
 * Every number is a measured median. Nothing is estimated: a missing scenario stops the script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Cell = { medianMs?: number; skipped?: unknown };
type Profiles = {
  sizes: number[];
  profiles: Record<"out-of-the-box" | "tuned", Record<string, Record<string, Cell>>>;
  setup?: { chosenRuns?: Record<string, Record<string, { label?: string }>> };
};

/** landing request → scenario in profiles.json, per profile */
const SCENARIOS: Record<string, { outOfTheBox: string; tuned: string }> = {
  page: { outOfTheBox: "page-without-count", tuned: "page-without-count" },
  cursor: { outOfTheBox: "deep-cursor-id-desc", tuned: "deep-cursor-id-desc" },
  // page + exact count out of the box, page + capped count tuned (assembled by the benchmark)
  count: { outOfTheBox: "page-plus-count", tuned: "page-plus-count" },
  relationSort: { outOfTheBox: "relation-sorted-count", tuned: "relation-sorted-count" },
  facets: { outOfTheBox: "four-mixed-facets", tuned: "four-mixed-facets" },
  search: { outOfTheBox: "cross-table-search-ord", tuned: "cross-table-search-ord" },
};
const SIZES = [200_000, 1_000_000, 10_000_000];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const engine = flag("--engine");
const measuredOn = flag("--measured-on") ?? new Date().toISOString().slice(0, 10);
const outFile = flag("--out");
const root = join(import.meta.dir, "..");
const source = args[0] ?? join(root, "tools/results/profiles.json");
const data = JSON.parse(readFileSync(source, "utf8")) as Profiles;

for (const n of SIZES)
  if (!data.sizes.includes(n))
    throw new Error(`${source} has no ${n.toLocaleString("en-US")}-row run`);

const median = (profile: "out-of-the-box" | "tuned", scenario: string) =>
  SIZES.map((n) => {
    const cell = data.profiles[profile]?.[scenario]?.[String(n)];
    if (typeof cell?.medianMs !== "number")
      throw new Error(`${profile} / ${scenario} / ${n} rows: no measured median in ${source}`);
    return Math.round(cell.medianMs * 1000) / 1000;
  });

const requests = Object.fromEntries(
  Object.entries(SCENARIOS).map(([key, s]) => [
    key,
    { outOfTheBox: median("out-of-the-box", s.outOfTheBox), tuned: median("tuned", s.tuned) },
  ]),
);

/** requests the landing credits to a tool (see PxBenchTuning REQUESTS[].drop) must get faster */
const CREDITED = ["count", "relationSort", "facets", "search"];
for (const key of CREDITED) {
  const r = requests[key]!;
  const last = SIZES.length - 1;
  if (r.tuned[last]! >= r.outOfTheBox[last]! * 0.9)
    console.warn(
      `warning: ${key} is barely faster tuned (${r.outOfTheBox[last]} → ${r.tuned[last]} ms at 10M); the chart says a tool brings it down`,
    );
}

const out = {
  $comment:
    "Numbers for the landing's benchmark chart. Regenerate with `bun tools/landing-bench-data.ts` from tools/results/profiles.json; do not edit by hand. Times are medians in milliseconds, one per table size.",
  placeholder: false,
  measuredOn,
  engine:
    engine ??
    readFileSync(join(root, "tools/results/engine-commit.txt"), "utf8").trim().slice(0, 7),
  postgres: "18.7",
  cpus: 4,
  clients: 1,
  runs: 10,
  sizes: SIZES,
  requests,
  tunedSettings: { countCap: 10_000 },
};
const target = outFile ?? join(root, "docs/app/data/bench-landing.json");
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${target}`);
for (const [key, r] of Object.entries(requests))
  console.log(`  ${key.padEnd(13)} ${r.outOfTheBox.join(" / ")} → ${r.tuned.join(" / ")} ms`);
