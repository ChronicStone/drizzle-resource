import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { HARNESS_VERSION, LOAD_THRESHOLD, TIMEOUT_MS, root, runsDir, sizeLabel } from "./config.ts";
import { createBase, dropSchema } from "./dataset.ts";
import { LoadMeter, measure, measurePaired, type Cell, type Run } from "./measure.ts";
import { makeBench } from "./resources.ts";
import { tune, type Tuning } from "./tuning.ts";
import {
  COUNTED,
  DENORMALIZED,
  FACETS,
  FACET_VARIANTS,
  LANDING,
  facetRun,
  rawScenarios,
} from "./scenarios.ts";

export type ProfileName = "out-of-the-box" | "tuned" | "scoped";

/** What a run was made with. `assemble` refuses to publish runs whose fingerprints differ. */
export type Fingerprint = {
  engineCommit: string;
  /** True when packages/core had uncommitted changes. A final run refuses that. */
  engineDirty: boolean;
  harnessVersion: string;
  /** Hash of the harness sources, so an edit without a version bump still shows. */
  harnessHash: string;
  postgres: string;
  settings: Record<string, string>;
  runtime: string;
};

/** One size, all setups, measured in the same minutes. */
export type RunRecord = {
  rows: number;
  startedAt: string;
  finishedAt: string;
  load: { start: number; end: number; max: number };
  fingerprint: Fingerprint;
  /** What `checkIndexes` found and fixed for each tuned schema. */
  tuning: Tuning[];
  cells: Record<ProfileName, Record<string, Cell>>;
};

export function harnessHash(): string {
  const hash = createHash("sha256");
  const dir = import.meta.dirname;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort())
    hash.update(file).update(readFileSync(join(dir, file)));
  return hash.digest("hex").slice(0, 12);
}

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function fingerprint(client: Client): Promise<Fingerprint> {
  const settings = Object.fromEntries(
    (
      await client.query(
        `select name, setting || coalesce(unit, '') as value from pg_settings
         where name in ('shared_buffers','work_mem','max_wal_size','max_parallel_workers_per_gather','jit','effective_cache_size')`,
      )
    ).rows.map((row) => [row.name, row.value]),
  ) as Record<string, string>;
  return {
    engineCommit: git("rev-parse", "HEAD"),
    engineDirty: git("status", "--porcelain", "--", "packages/core").length > 0,
    harnessVersion: HARNESS_VERSION,
    harnessHash: harnessHash(),
    postgres: ((await client.query("select version()")).rows[0].version as string).split(
      " on ",
    )[0]!,
    settings,
    runtime: `bun ${process.versions.bun}`,
  };
}

export type RunOptions = { keep: boolean; log: (line: string) => void };

const same = (a: Cell | undefined, extra: Record<string, unknown>): Cell => ({
  ...(a ?? { method: "engine" }),
  ...extra,
});
const withParts = (cell: Cell, countMode: string): Cell => ({
  ...cell,
  countMode,
  ...(cell.stages
    ? {
        parts: {
          pageMs: cell.stages.ids ?? null,
          countMs: cell.stages.count ?? null,
          planMs: cell.stages.plan ?? null,
        },
      }
    : {}),
});

/** The count statement alone, as the engine reported it for a request with that count mode. */
function countCell(cell: Cell): Cell {
  if (cell.skipped) return cell;
  const ms = cell.stages?.count;
  if (ms === undefined) return { method: "engine", skipped: "the engine ran no count statement" };
  return {
    medianMs: ms,
    maxMs: cell.maxMs,
    method: "engine (onQuery count stage)",
    n: cell.n,
    rowCount: cell.rowCount,
    countUsed: cell.countUsed,
  };
}

/**
 * Builds one size as four schemas that live side by side (out of the box, tuned, tuned with the
 * copied name, scoped), tunes three of them with `checkIndexes`, and measures every request
 * against all setups in turn, so every ratio comes from the same minutes. Four copies of the data
 * cost disk (see the README) and share the container's memory, so each call finds the others'
 * pages evicted; that holds for both arms of every pair.
 */
export async function runSize(url: string, rows: number, options: RunOptions): Promise<RunRecord> {
  const label = sizeLabel(rows);
  const names = {
    ootb: `scale_${label}`,
    tuned: `scale_${label}_t`,
    denorm: `scale_${label}_d`,
    scoped: `scale_${label}_s`,
  };
  const client = new Client({ connectionString: url });
  await client.connect();
  // No statement timeout while building: index builds at 10 million rows take minutes.
  const setupPool = new Pool({ connectionString: url, max: 2 });
  const pool = new Pool({ connectionString: url, max: 10, statement_timeout: TIMEOUT_MS + 1_000 });
  const startedAt = new Date().toISOString();
  try {
    for (const [key, schema] of Object.entries(names)) {
      options.log(`${label}: creating ${schema} (${rows.toLocaleString("en-US")} orders)`);
      await createBase(client, schema, rows, key === "denorm");
    }
    options.log(`${label}: checkIndexes on the tuned schemas`);
    const tuning: Tuning[] = [
      await tune(setupPool, names.tuned, { scoped: false, denormalized: false }, "orders"),
      await tune(
        setupPool,
        names.denorm,
        { scoped: false, denormalized: true },
        "orders, name copied onto the order",
      ),
      await tune(setupPool, names.scoped, { scoped: false, denormalized: false }, "orders"),
      // The check says the default sort has no index that starts with the scope's column, in words
      // only; the index it describes is (orgId, createdAt, id).
      await tune(
        setupPool,
        names.scoped,
        { scoped: true, denormalized: false },
        "orders scoped to orgId 42",
        [
          {
            rule: "default-sort-unindexed",
            sql: `create index on "${names.scoped}".orders ("orgId", "createdAt", id)`,
          },
        ],
      ),
    ];
    for (const t of tuning)
      options.log(
        `  ${t.schema} (${t.resource}): ${t.applied.length} statements applied, ${t.byHand.length} by hand, no error left: ${t.noErrorRemains}`,
      );

    const benches = {
      ootb: makeBench(pool, names.ootb),
      tuned: makeBench(pool, names.tuned),
      denorm: makeBench(pool, names.denorm, { denormalized: true }),
      scoped: makeBench(pool, names.scoped, { scoped: true }),
    };
    const cells: RunRecord["cells"] = { "out-of-the-box": {}, tuned: {}, scoped: {} };
    const meter = new LoadMeter();
    meter.sample();
    options.log(`${label}: measuring, load ${meter.start.toFixed(1)}`);

    // Out of the box, every request the harness knows: no pair, nothing to compare it with.
    for (const spec of await rawScenarios(pool, names.ootb, rows)) {
      meter.sample();
      cells["out-of-the-box"][spec.name] = await measure(spec.run(benches.ootb));
    }

    // The landing requests, each against every setup that applies, in turn.
    const paired = async (
      key: string,
      arms: Array<{ profile: ProfileName; key?: string; run: Run; countMode?: string }>,
    ) => {
      meter.sample();
      const result = await measurePaired(arms.map((a, i) => ({ name: String(i), run: a.run })));
      arms.forEach((arm, i) => {
        const cell = result[String(i)]!;
        cells[arm.profile][arm.key ?? `landing/${key}`] = arm.countMode
          ? withParts(cell, arm.countMode)
          : cell;
      });
    };
    for (const spec of LANDING) {
      const arms: Parameters<typeof paired>[1] = [
        { profile: "out-of-the-box", run: spec.run(benches.ootb, "exact"), countMode: "exact" },
        spec.name === "sort-customer-name-plus-count"
          ? {
              profile: "tuned",
              key: `landing/${DENORMALIZED.name}`,
              run: DENORMALIZED.run(benches.denorm, "capped"),
              countMode: "capped",
            }
          : { profile: "tuned", run: spec.run(benches.tuned, "capped"), countMode: "capped" },
      ];
      if (spec.name === "page-plus-count") {
        arms.push({
          profile: "scoped",
          run: spec.run(benches.scoped, "capped"),
          countMode: "capped",
        });
        arms.push({
          profile: "scoped",
          key: "landing/page-plus-count-exact",
          run: spec.run(benches.scoped, "exact"),
          countMode: "exact",
        });
      }
      if (spec.name === "relation-search-plus-count")
        arms.push({
          profile: "scoped",
          run: spec.run(benches.scoped, "capped"),
          countMode: "capped",
        });
      await paired(spec.name, arms);
    }
    for (const facet of FACETS) {
      const arms: Parameters<typeof paired>[1] = [
        { profile: "out-of-the-box", run: facetRun(benches.ootb, facet.facets, "default", false) },
        // The tuned setting is chosen before measuring: one statement per facet, on the pool.
        { profile: "tuned", run: facetRun(benches.tuned, facet.facets, "split", false) },
      ];
      if (facet.name === "two-root-facets")
        arms.push({
          profile: "scoped",
          run: facetRun(benches.scoped, facet.facets, "default", false),
        });
      await paired(facet.name, arms);
      cells.tuned[`landing/${facet.name}`] = {
        ...cells.tuned[`landing/${facet.name}`]!,
        setting: "facets.splitAbove: 0",
        uses: "separate/concurrent",
      };
      cells["out-of-the-box"][`landing/${facet.name}`] = {
        ...cells["out-of-the-box"][`landing/${facet.name}`]!,
        note: "the engine's default: facets.splitAbove 100,000",
      };
    }

    // Informational, on the tuned schema, no verdict: the count statement alone, and the four ways to run facets.
    for (const spec of COUNTED)
      for (const mode of ["exact", "capped"] as const) {
        meter.sample();
        cells.tuned[`${spec.name}:count-${mode}`] = countCell(
          await measure(spec.run(benches.tuned, mode)),
        );
      }
    for (const facet of FACETS)
      for (const variant of FACET_VARIANTS) {
        meter.sample();
        cells.tuned[`${facet.name}/${variant.key}`] = same(
          await measure(
            facetRun(benches.tuned, facet.facets, variant.strategy, variant.sequential),
          ),
          { informational: true },
        );
      }
    meter.sample();

    const record: RunRecord = {
      rows,
      startedAt,
      finishedAt: new Date().toISOString(),
      load: { start: meter.start, end: meter.end, max: meter.max },
      fingerprint: await fingerprint(client),
      tuning,
      cells,
    };
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, `run-${label}-${startedAt.replaceAll(":", "")}.json`),
      JSON.stringify(record, null, 1),
    );
    options.log(
      `${label}: done, load max ${meter.max.toFixed(1)}${meter.max > LOAD_THRESHOLD ? ` (above ${LOAD_THRESHOLD})` : ""}`,
    );
    return record;
  } finally {
    await pool.end();
    await setupPool.end();
    if (!options.keep) for (const schema of Object.values(names)) await dropSchema(client, schema);
    await client.end();
  }
}
