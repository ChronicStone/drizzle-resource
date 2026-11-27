import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import {
  HARNESS_VERSION,
  ITERATIONS,
  LOAD_THRESHOLD,
  MIN_ROUNDS,
  TIMEOUT_MS,
  root,
  runsDir,
  sizeLabel,
} from "./config.ts";
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

/** What the database is. A container says so itself; for `--url` the caller declares it. */
export type DatabaseIdentity = { via: "docker" | "url"; cpus: string; memory: string };

/** What a run was made with. `assemble` refuses to publish runs whose fingerprints differ. */
export type Fingerprint = {
  engineCommit: string;
  /** True when packages/core had uncommitted changes. A final run refuses that. */
  engineDirty: boolean;
  harnessVersion: string;
  /** Hash of the harness sources, so an edit without a version bump still shows. */
  harnessHash: string;
  postgres: string;
  /** `current_setting` of the settings that change the numbers, as PostgreSQL prints them. */
  settings: Record<string, string>;
  database: DatabaseIdentity;
  iterations: number;
  timeoutMs: number;
  minRounds: number;
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
  /** The same request on the same schema timed as two arms: what a verdict reads when nothing changed. */
  nullPair: { request: string; ratios: number[] };
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

const SETTINGS = [
  "shared_buffers",
  "work_mem",
  "max_wal_size",
  "max_parallel_workers_per_gather",
  "jit",
  "effective_cache_size",
];

async function fingerprint(client: Client, database: DatabaseIdentity): Promise<Fingerprint> {
  const settings: Record<string, string> = {};
  for (const name of SETTINGS)
    settings[name] = (
      await client.query("select current_setting($1) as value", [name])
    ).rows[0].value;
  return {
    engineCommit: git("rev-parse", "HEAD"),
    engineDirty: git("status", "--porcelain", "--", "packages/core").length > 0,
    harnessVersion: HARNESS_VERSION,
    harnessHash: harnessHash(),
    postgres: ((await client.query("select version()")).rows[0].version as string).split(
      " on ",
    )[0]!,
    settings,
    database,
    iterations: ITERATIONS,
    timeoutMs: TIMEOUT_MS,
    minRounds: MIN_ROUNDS,
    runtime: `bun ${process.versions.bun}`,
  };
}

export type RunOptions = { keep: boolean; database: DatabaseIdentity; log: (line: string) => void };

/** Schemas this process created, so an interrupt can drop them from a database it does not own. */
export const createdSchemas = new Set<string>();
export async function dropCreated(url: string) {
  if (createdSchemas.size === 0) return;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const schema of createdSchemas) await dropSchema(client, schema);
    createdSchemas.clear();
  } finally {
    await client.end();
  }
}

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

type Arm = { profile: ProfileName; key?: string; run: Run; countMode?: string };

/**
 * Builds one size and measures every request against every setup in turn. Two schemas are
 * resident at a time: out of the box, and the one it is being compared with. The tuned, the tuned
 * with the copied name, and the scoped schema are built, measured and dropped one after another,
 * so the container's memory holds the same two at every size and each call is not evicted by
 * copies it has nothing to do with.
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
  const tuning: Tuning[] = [];
  const cells: RunRecord["cells"] = { "out-of-the-box": {}, tuned: {}, scoped: {} };
  const meter = new LoadMeter();
  const build = async (key: keyof typeof names) => {
    options.log(`${label}: creating ${names[key]} (${rows.toLocaleString("en-US")} orders)`);
    createdSchemas.add(names[key]);
    await createBase(client, names[key], rows, key === "denorm");
  };
  const drop = async (key: keyof typeof names) => {
    if (options.keep) return;
    await dropSchema(client, names[key]);
    createdSchemas.delete(names[key]);
  };
  const record = (t: Tuning) => {
    tuning.push(t);
    options.log(
      `  ${t.schema} (${t.resource}): ${t.applied.length} statements applied, ${t.byHand.length} by hand, no error left: ${t.noErrorRemains}`,
    );
  };
  const paired = async (key: string, arms: Arm[]) => {
    meter.sample();
    const result = await measurePaired(arms.map((a, i) => ({ name: String(i), run: a.run })));
    arms.forEach((arm, i) => {
      const cell = result[String(i)]!;
      const target = cells[arm.profile];
      const name = arm.key ?? `landing/${key}`;
      const shaped = arm.countMode ? withParts(cell, arm.countMode) : cell;
      // Each pair has its own out-of-the-box calls; the first pair's are the ones published.
      if (arm.profile === "out-of-the-box" && target[name]) return;
      target[name] = shaped;
    });
  };
  try {
    await build("ootb");
    const ootb = makeBench(pool, names.ootb);
    meter.sample();
    options.log(`${label}: measuring, load ${meter.start.toFixed(1)}`);

    // Out of the box, every request the harness knows: no pair, nothing to compare it with.
    for (const spec of await rawScenarios(pool, names.ootb, rows)) {
      meter.sample();
      cells["out-of-the-box"][spec.name] = await measure(spec.run(ootb));
    }

    // The null pair: one request on one schema, called as two arms. Its verdict must be "unchanged".
    const nullRequest = LANDING.find((l) => l.name === "page-plus-count")!;
    meter.sample();
    const nulls = await measurePaired([
      { name: "a", run: nullRequest.run(ootb, "exact") },
      { name: "b", run: nullRequest.run(ootb, "exact") },
    ]);
    const nullPair = {
      request: "page-plus-count, exact, out of the box against itself",
      ratios: nulls.b?.pairedRatios ?? [],
    };

    // Tuned: what checkIndexes asks for, then every landing request that is not the sort.
    await build("tuned");
    record(await tune(setupPool, names.tuned, { scoped: false, denormalized: false }, "orders"));
    const tuned = makeBench(pool, names.tuned);
    for (const spec of LANDING.filter((l) => l.name !== "sort-customer-name-plus-count"))
      await paired(spec.name, [
        { profile: "out-of-the-box", run: spec.run(ootb, "exact"), countMode: "exact" },
        { profile: "tuned", run: spec.run(tuned, "capped"), countMode: "capped" },
      ]);
    for (const facet of FACETS)
      await paired(facet.name, [
        { profile: "out-of-the-box", run: facetRun(ootb, facet.facets, "default", false) },
        // The tuned setting is chosen before measuring: one statement per facet, on the pool.
        { profile: "tuned", run: facetRun(tuned, facet.facets, "split", false) },
      ]);
    for (const facet of FACETS) {
      const cell = cells.tuned[`landing/${facet.name}`];
      if (cell)
        cells.tuned[`landing/${facet.name}`] = {
          ...cell,
          setting: "facets.splitAbove: 0",
          uses: "separate/concurrent",
        };
      const base = cells["out-of-the-box"][`landing/${facet.name}`];
      if (base)
        cells["out-of-the-box"][`landing/${facet.name}`] = {
          ...base,
          note: "the engine's default: facets.splitAbove 100,000",
        };
    }
    // Informational, on the tuned schema, no verdict: the count statement alone, and the four ways to run facets.
    for (const spec of COUNTED)
      for (const mode of ["exact", "capped"] as const) {
        meter.sample();
        cells.tuned[`${spec.name}:count-${mode}`] = countCell(await measure(spec.run(tuned, mode)));
      }
    for (const facet of FACETS)
      for (const variant of FACET_VARIANTS) {
        meter.sample();
        cells.tuned[`${facet.name}/${variant.key}`] = {
          ...(await measure(facetRun(tuned, facet.facets, variant.strategy, variant.sequential))),
          informational: true,
        };
      }
    await drop("tuned");

    // The sort through the customer's name, with the name copied onto orders.
    await build("denorm");
    record(
      await tune(
        setupPool,
        names.denorm,
        { scoped: false, denormalized: true },
        "orders, name copied onto the order",
      ),
    );
    const denorm = makeBench(pool, names.denorm, { denormalized: true });
    const sort = LANDING.find((l) => l.name === "sort-customer-name-plus-count")!;
    await paired(sort.name, [
      { profile: "out-of-the-box", run: sort.run(ootb, "exact"), countMode: "exact" },
      {
        profile: "tuned",
        key: `landing/${DENORMALIZED.name}`,
        run: DENORMALIZED.run(denorm, "capped"),
        countMode: "capped",
      },
    ]);
    for (const mode of ["exact", "capped"] as const) {
      meter.sample();
      cells.tuned[`sort-customer-name-denormalized:count-${mode}`] = countCell(
        await measure(DENORMALIZED.run(denorm, mode)),
      );
    }
    await drop("denorm");

    // Scoped to one tenant.
    await build("scoped");
    record(await tune(setupPool, names.scoped, { scoped: false, denormalized: false }, "orders"));
    // The check says the default sort has no index that starts with the scope's column, in words
    // only; the index it describes is (orgId, createdAt, id).
    record(
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
    );
    const scoped = makeBench(pool, names.scoped, { scoped: true });
    const pageCount = LANDING.find((l) => l.name === "page-plus-count")!;
    await paired(pageCount.name, [
      { profile: "out-of-the-box", run: pageCount.run(ootb, "exact"), countMode: "exact" },
      { profile: "scoped", run: pageCount.run(scoped, "capped"), countMode: "capped" },
      {
        profile: "scoped",
        key: "landing/page-plus-count-exact",
        run: pageCount.run(scoped, "exact"),
        countMode: "exact",
      },
    ]);
    const relationSearch = LANDING.find((l) => l.name === "relation-search-plus-count")!;
    await paired(relationSearch.name, [
      { profile: "out-of-the-box", run: relationSearch.run(ootb, "exact"), countMode: "exact" },
      { profile: "scoped", run: relationSearch.run(scoped, "capped"), countMode: "capped" },
    ]);
    const facet = FACETS.find((f) => f.name === "two-root-facets")!;
    await paired(facet.name, [
      { profile: "out-of-the-box", run: facetRun(ootb, facet.facets, "default", false) },
      { profile: "scoped", run: facetRun(scoped, facet.facets, "default", false) },
    ]);
    await drop("scoped");
    meter.sample();

    const result: RunRecord = {
      rows,
      startedAt,
      finishedAt: new Date().toISOString(),
      load: { start: meter.start, end: meter.end, max: meter.max },
      fingerprint: await fingerprint(client, options.database),
      tuning,
      nullPair,
      cells,
    };
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, `run-${label}-${startedAt.replaceAll(":", "")}.json`),
      JSON.stringify(result, null, 1),
    );
    options.log(
      `${label}: done, load max ${meter.max.toFixed(1)}${meter.max > LOAD_THRESHOLD ? ` (above ${LOAD_THRESHOLD})` : ""}`,
    );
    return result;
  } finally {
    await pool.end();
    await setupPool.end();
    if (!options.keep) {
      await dropSchema(client, names.ootb);
      createdSchemas.delete(names.ootb);
      for (const key of ["tuned", "denorm", "scoped"] as const) {
        await dropSchema(client, names[key]);
        createdSchemas.delete(names[key]);
      }
    }
    await client.end();
  }
}
