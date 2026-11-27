/**
 * Does keeping two schemas resident change the absolute times? Run it in a container too small to
 * hold four copies, which is what 10 million rows do to a 4 GB container:
 *
 *   BENCH_DB_MEMORY=512m BENCH_SHARED_BUFFERS=128MB bun tools/bench/cache-check.ts [--size 1m]
 *
 * It times the out-of-the-box side of five landing requests three ways: alone (one schema), next to
 * the schema it is compared with (two resident, what the benchmark does), and with all four schemas
 * resident (what it used to do). Writes tools/results/scale-runs/cache-check-<size>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { parseSizes, runsDir, sizeLabel, TIMEOUT_MS } from "./config.ts";
import { createBase, dropSchema } from "./dataset.ts";
import { dockerAvailable, removeContainer, startContainer } from "./docker.ts";
import { measure, measurePaired } from "./measure.ts";
import { makeBench } from "./resources.ts";
import { LANDING } from "./scenarios.ts";
import { tune } from "./tuning.ts";

const args = process.argv.slice(2);
const sizeArg = args.indexOf("--size") >= 0 ? args[args.indexOf("--size") + 1] : "1m";
const rows = parseSizes(sizeArg)[0]!;
const label = sizeLabel(rows);
const wanted = [
  "page-plus-count",
  "search-ord-plus-count",
  "search-customer-plus-count",
  "relation-search-plus-count",
  "sort-customer-name-plus-count",
];
const specs = LANDING.filter((l) => wanted.includes(l.name));

if (!dockerAvailable()) throw new Error("Docker is not running");
const { url, name } = await startContainer();
const ootbName = `cache_${label}`;
const names = { tuned: `${ootbName}_t`, denorm: `${ootbName}_d`, scoped: `${ootbName}_s` };
const client = new Client({ connectionString: url });
await client.connect();
const setupPool = new Pool({ connectionString: url, max: 2 });
const pool = new Pool({ connectionString: url, max: 10, statement_timeout: TIMEOUT_MS + 1_000 });
const result: Record<string, { alone: number; aloneAgain: number; two: number; four: number }> = {};
try {
  await createBase(client, ootbName, rows);
  const ootb = makeBench(pool, ootbName);
  const alone: Record<string, number> = {};
  const aloneAgain: Record<string, number> = {};
  for (const spec of specs)
    alone[spec.name] = (await measure(spec.run(ootb, "exact"))).medianMs ?? NaN;
  // The same measurement again, to see how far two runs of one schema drift by themselves.
  for (const spec of specs)
    aloneAgain[spec.name] = (await measure(spec.run(ootb, "exact"))).medianMs ?? NaN;

  await createBase(client, names.tuned, rows);
  await tune(setupPool, names.tuned, { scoped: false, denormalized: false }, "orders");
  const tuned = makeBench(pool, names.tuned);
  const pairedOotb = async () => {
    const out: Record<string, number> = {};
    for (const spec of specs) {
      const cells = await measurePaired([
        { name: "ootb", run: spec.run(ootb, "exact") },
        { name: "tuned", run: spec.run(tuned, "capped") },
      ]);
      out[spec.name] = cells.ootb?.medianMs ?? NaN;
    }
    return out;
  };
  const two = await pairedOotb();

  await createBase(client, names.denorm, rows, true);
  await createBase(client, names.scoped, rows);
  const four = await pairedOotb();

  console.log(
    `${label} rows in a container of ${process.env.BENCH_DB_MEMORY ?? "4g"}: out-of-the-box median, ms`,
  );
  console.log(
    "request".padEnd(34),
    "alone".padStart(9),
    "alone again".padStart(12),
    "two resident".padStart(13),
    "four resident".padStart(14),
    "again/alone".padStart(12),
    "two/alone".padStart(10),
    "four/alone".padStart(11),
  );
  for (const spec of specs) {
    result[spec.name] = {
      alone: alone[spec.name]!,
      aloneAgain: aloneAgain[spec.name]!,
      two: two[spec.name]!,
      four: four[spec.name]!,
    };
    const r = result[spec.name]!;
    console.log(
      spec.name.padEnd(34),
      r.alone.toFixed(1).padStart(9),
      r.aloneAgain.toFixed(1).padStart(12),
      r.two.toFixed(1).padStart(13),
      r.four.toFixed(1).padStart(14),
      (r.aloneAgain / r.alone).toFixed(2).padStart(12),
      (r.two / r.alone).toFixed(2).padStart(10),
      (r.four / r.alone).toFixed(2).padStart(11),
    );
  }
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(runsDir, `cache-check-${label}.json`),
    JSON.stringify(
      {
        rows,
        memory: process.env.BENCH_DB_MEMORY ?? "4g",
        sharedBuffers: process.env.BENCH_SHARED_BUFFERS ?? "1GB",
        result,
      },
      null,
      1,
    ),
  );
} finally {
  await pool.end();
  await setupPool.end();
  for (const schema of [ootbName, ...Object.values(names)])
    await dropSchema(client, schema).catch(() => {});
  await client.end();
  removeContainer();
  console.error(`removed ${name}`);
}
