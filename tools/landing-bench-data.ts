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

type Cell = { medianMs?: number; skipped?: unknown; verdict?: Verdict };
type Verdict = "improved" | "unchanged" | "worse";
type Profiles = {
  sizes: number[];
  /** per scenario: did the tuned profile make it faster? (also accepted on the tuned scenario itself) */
  verdicts?: Record<string, Verdict>;
  profiles: Record<"out-of-the-box" | "tuned", Record<string, Record<string, Cell>>>;
  setup?: { chosenRuns?: Record<string, Record<string, { label?: string }>> };
};

/**
 * landing request → scenario in profiles.json, per profile. The `landing/*` scenarios are measured
 * for this chart: out of the box with an exact count, tuned as the engine page with the tuned
 * indexes plus a count capped at 10,001 rows. `credited` requests are the ones a tool brings down;
 * they must carry a verdict. Page and cursor are not tuned, so they default to "unchanged".
 */
const SCENARIOS: Record<string, { outOfTheBox: string; tuned: string; credited: boolean }> = {
  page: { outOfTheBox: "page-without-count", tuned: "page-without-count", credited: false },
  cursor: { outOfTheBox: "deep-cursor-id-desc", tuned: "deep-cursor-id-desc", credited: false },
  count: {
    outOfTheBox: "landing/page-plus-count",
    tuned: "landing/page-plus-count",
    credited: true,
  },
  // checkIndexes recommends copying customer.name onto orders, so the tuned run sorts the copy
  relationSort: {
    outOfTheBox: "landing/sort-customer-name-plus-count",
    tuned: "landing/sort-customer-name-denormalized-plus-count",
    credited: true,
  },
  facets: {
    outOfTheBox: "landing/four-mixed-facets",
    tuned: "landing/four-mixed-facets",
    credited: true,
  },
  search: {
    outOfTheBox: "landing/search-ord-plus-count",
    tuned: "landing/search-ord-plus-count",
    credited: true,
  },
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

const VERDICTS: Verdict[] = ["improved", "unchanged", "worse"];
/** The benchmark decides whether tuning helped; this script never infers it from the numbers. */
const verdict = (scenario: string, credited: boolean): Verdict => {
  const tuned = data.profiles.tuned?.[scenario] as
    | (Record<string, Cell> & { verdict?: Verdict })
    | undefined;
  const v =
    data.verdicts?.[scenario] ??
    tuned?.verdict ??
    tuned?.[String(SIZES[SIZES.length - 1])]?.verdict;
  if (!v && !credited) return "unchanged";
  if (!v || !VERDICTS.includes(v))
    throw new Error(`tuned / ${scenario}: no verdict (improved, unchanged or worse) in ${source}`);
  return v;
};

const requests = Object.fromEntries(
  Object.entries(SCENARIOS).map(([key, s]) => [
    key,
    {
      outOfTheBox: median("out-of-the-box", s.outOfTheBox),
      tuned: median("tuned", s.tuned),
      verdict: verdict(s.tuned, s.credited),
    },
  ]),
);

/** requests the landing credits to a tool (see PxBenchTuning REQUESTS[].drop) must get faster */
const CREDITED = Object.keys(SCENARIOS).filter((k) => SCENARIOS[k]!.credited);
for (const key of CREDITED) {
  const r = requests[key]!;
  const last = SIZES.length - 1;
  const ratio = r.tuned[last]! / r.outOfTheBox[last]!;
  if (ratio >= 0.9)
    console.warn(
      `warning: ${key} is barely faster tuned (${r.outOfTheBox[last]} → ${r.tuned[last]} ms at 10M); the landing shows it unchanged unless the verdict says improved (verdict: ${r.verdict})`,
    );
  if (r.verdict === "improved" && ratio >= 0.9)
    console.warn(
      `warning: ${key} has verdict "improved" but the numbers barely moved; check profiles.json`,
    );
  if (r.verdict !== "improved" && ratio < 0.5)
    console.warn(
      `warning: ${key} has verdict "${r.verdict}" but is ${Math.round(1 / ratio)}× faster; check profiles.json`,
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
  console.log(
    `  ${key.padEnd(13)} ${r.outOfTheBox.join(" / ")} → ${r.tuned.join(" / ")} ms  (${r.verdict})`,
  );
