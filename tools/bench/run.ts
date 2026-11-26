import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { LOAD_THRESHOLD, TIMEOUT_MS, runsDir, sizeLabel } from "./config.ts";
import {
  addScopeIndex,
  addTunedIndexes,
  createBase,
  createDenormalized,
  dropSchema,
} from "./dataset.ts";
import { LoadMeter, measure, type Cell } from "./measure.ts";
import { makeBench, type Bench } from "./resources.ts";
import {
  COUNTED,
  DENORMALIZED,
  FACETS,
  FACET_VARIANTS,
  LANDING,
  facetRun,
  rawScenarios,
  type CountMode,
  type Landing,
} from "./scenarios.ts";

export type ProfileName = "out-of-the-box" | "tuned" | "scoped" | "tuned-denormalized";
export type RunRecord = {
  profile: ProfileName;
  rows: number;
  startedAt: string;
  load: { start: number; end: number; max: number };
  highLoad: boolean;
  environment?: { version: string; settings: Record<string, string> };
  cells: Record<string, Cell>;
};

export type RunOptions = { profiles: ProfileName[]; keep: boolean; log: (line: string) => void };

/** A landing cell: the whole engine call, plus what its page and count statements took. */
function landingCell(cell: Cell, count: CountMode): Cell {
  const out: Cell = { ...cell, countMode: count };
  if (cell.stages)
    out.parts = {
      pageMs: cell.stages.ids ?? null,
      countMs: cell.stages.count ?? null,
      planMs: cell.stages.plan ?? null,
    };
  return out;
}

/** The count statement alone, as the engine reported it for a request with that count mode. */
function countCell(cell: Cell): Cell {
  if (cell.skipped) return cell;
  const ms = cell.stages?.count;
  if (ms === undefined) return { method: "engine", skipped: "the engine ran no count statement" };
  return {
    medianMs: ms,
    p95Ms: cell.p95Ms,
    method: "engine (onQuery count stage)",
    n: cell.n,
    rowCount: cell.rowCount,
    countUsed: cell.countUsed,
  };
}

async function landing(
  meter: LoadMeter,
  bench: Bench,
  spec: Landing,
  count: CountMode,
  cells: Record<string, Cell>,
  key = spec.name,
) {
  meter.sample();
  cells[`landing/${key}`] = landingCell(await measure(spec.run(bench, count)), count);
}

async function ootbCells(meter: LoadMeter, bench: Bench, pool: Pool, schema: string, rows: number) {
  const cells: Record<string, Cell> = {};
  for (const spec of await rawScenarios(pool, schema, rows)) {
    meter.sample();
    cells[spec.name] = await measure(spec.run(bench));
  }
  for (const spec of LANDING) await landing(meter, bench, spec, "exact", cells);
  for (const facet of FACETS) {
    meter.sample();
    const cell = await measure(facetRun(bench, facet.facets, "default", false));
    cells[facet.name] = cell;
    cells[`landing/${facet.name}`] = {
      ...cell,
      note: "the engine's default: facets.splitAbove 100,000",
    };
  }
  return cells;
}

async function tunedCells(
  meter: LoadMeter,
  bench: Bench,
  pool: Pool,
  schema: string,
  rows: number,
) {
  const cells: Record<string, Cell> = {};
  for (const spec of LANDING) await landing(meter, bench, spec, "capped", cells);
  for (const spec of COUNTED) {
    for (const mode of ["exact", "capped"] as const) {
      meter.sample();
      cells[`${spec.name}:count-${mode}`] = countCell(await measure(spec.run(bench, mode)));
    }
  }
  const keep = new Set([
    "page-without-count",
    "deep-cursor-id-asc",
    "deep-cursor-id-desc",
    "id-selection-10",
    "id-selection-10-page-only",
    "id-selection-1000",
    "id-selection-1000-page-only",
  ]);
  for (const spec of await rawScenarios(pool, schema, rows)) {
    if (!keep.has(spec.name)) continue;
    meter.sample();
    cells[spec.name] = await measure(spec.run(bench));
  }
  for (const facet of FACETS) {
    const variants: Record<string, Cell> = {};
    for (const variant of FACET_VARIANTS) {
      meter.sample();
      variants[variant.key] = await measure(
        facetRun(bench, facet.facets, variant.strategy, variant.sequential),
      );
      cells[`${facet.name}/${variant.key}`] = variants[variant.key]!;
    }
  }
  return cells;
}

async function scopedCells(
  meter: LoadMeter,
  bench: Bench,
  pool: Pool,
  schema: string,
  rows: number,
) {
  const cells: Record<string, Cell> = {};
  const byName = Object.fromEntries(LANDING.map((l) => [l.name, l]));
  await landing(meter, bench, byName["page-plus-count"]!, "capped", cells);
  await landing(meter, bench, byName["page-plus-count"]!, "exact", cells, "page-plus-count-exact");
  await landing(meter, bench, byName["relation-search-plus-count"]!, "capped", cells);
  for (const facet of FACETS.filter((f) => f.name === "two-root-facets")) {
    meter.sample();
    cells[`landing/${facet.name}`] = await measure(facetRun(bench, facet.facets, "default", false));
  }
  const keep = new Set(["page-without-count", "page-exact-count", "relation-search-page"]);
  for (const spec of await rawScenarios(pool, schema, rows)) {
    if (!keep.has(spec.name)) continue;
    meter.sample();
    cells[spec.name] = await measure(spec.run(bench));
  }
  return cells;
}

async function denormalizedCells(meter: LoadMeter, bench: Bench) {
  const cells: Record<string, Cell> = {};
  await landing(meter, bench, DENORMALIZED, "capped", cells);
  for (const mode of ["exact", "capped"] as const) {
    meter.sample();
    cells[`sort-customer-name-denormalized:count-${mode}`] = countCell(
      await measure(DENORMALIZED.run(bench, mode)),
    );
  }
  return cells;
}

/** Builds one size, runs the selected profiles on it, saves one run file per profile, drops the schemas. */
export async function runSize(
  url: string,
  rows: number,
  options: RunOptions,
): Promise<RunRecord[]> {
  const label = sizeLabel(rows);
  const schema = `scale_${label}`;
  const denormSchema = `${schema}_d`;
  const client = new Client({ connectionString: url });
  await client.connect();
  const pool = new Pool({ connectionString: url, max: 10, statement_timeout: TIMEOUT_MS + 1_000 });
  const want = (name: ProfileName) => options.profiles.includes(name);
  const records: RunRecord[] = [];
  const environment = {
    version: (await client.query("select version()")).rows[0].version as string,
    settings: Object.fromEntries(
      (
        await client.query(
          `select name, setting || coalesce(unit, '') as value from pg_settings
         where name in ('shared_buffers','work_mem','max_wal_size','max_parallel_workers_per_gather','jit','effective_cache_size')`,
        )
      ).rows.map((row) => [row.name, row.value]),
    ) as Record<string, string>,
  };
  const record = async (
    profile: ProfileName,
    build: (meter: LoadMeter) => Promise<Record<string, Cell>>,
  ) => {
    const meter = new LoadMeter();
    const startedAt = new Date().toISOString();
    meter.sample();
    options.log(`  ${profile} at ${label} rows, load ${meter.start.toFixed(1)}`);
    const cells = await build(meter);
    meter.sample();
    const run: RunRecord = {
      profile,
      rows,
      startedAt,
      load: { start: meter.start, end: meter.end, max: meter.max },
      highLoad: meter.max > LOAD_THRESHOLD,
      environment,
      cells,
    };
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, `${profile}-${label}-${startedAt.replaceAll(":", "")}.json`),
      JSON.stringify(run, null, 1),
    );
    options.log(
      `  ${profile} done, load max ${meter.max.toFixed(1)}${run.highLoad ? " (HIGH)" : ""}`,
    );
    records.push(run);
  };
  try {
    options.log(`${label}: creating ${rows.toLocaleString("en-US")} orders`);
    await createBase(client, schema, rows);
    if (want("out-of-the-box"))
      await record("out-of-the-box", (meter) =>
        ootbCells(meter, makeBench(pool, schema), pool, schema, rows),
      );
    if (want("tuned") || want("scoped") || want("tuned-denormalized"))
      await addTunedIndexes(client, schema);
    if (want("tuned"))
      await record("tuned", (meter) =>
        tunedCells(meter, makeBench(pool, schema), pool, schema, rows),
      );
    if (want("scoped")) {
      await addScopeIndex(client, schema);
      await record("scoped", (meter) =>
        scopedCells(meter, makeBench(pool, schema, { scoped: true }), pool, schema, rows),
      );
    }
    if (want("tuned-denormalized")) {
      await createDenormalized(client, schema, denormSchema);
      await record("tuned-denormalized", (meter) =>
        denormalizedCells(meter, makeBench(pool, denormSchema, { denormalized: true })),
      );
    }
  } finally {
    await pool.end();
    if (!options.keep) {
      await dropSchema(client, schema);
      await dropSchema(client, denormSchema);
    }
    await client.end();
  }
  return records;
}
