/**
 * The scaling benchmark behind the docs' Scale pages and the landing chart: orders with a customers
 * relation at 200,000, 1 million and 10 million rows, in three setups (out of the box, tuned,
 * scoped to a tenant). One command:
 *
 *   bun run benchmark:scale [run|assemble|all] [--final] [--sizes 200k,1m,10m]
 *                           [--profiles out-of-the-box,tuned,scoped,tuned-denormalized]
 *                           [--url postgres://…] [--keep] [--out file]
 *
 * Without --url (or TEST_DATABASE_URL) it starts a postgres:18 container with the settings the
 * published numbers used and removes it afterwards. `run` saves one file per profile and size in
 * tools/results/scale-runs/ with the load average it was taken under; `assemble` publishes the
 * quietest run of each into tools/results/profiles.json. See tools/bench/README.md.
 */
import { LOAD_THRESHOLD, DEFAULT_SIZES, parseSizes, profilesFile, runsDir } from "./config.ts";
import { assemble, readRuns, writeProfiles } from "./assemble.ts";
import { dockerAvailable, removeContainer, startContainer } from "./docker.ts";
import { runSize, type ProfileName } from "./run.ts";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const bool = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const final = bool("--final");
const keep = bool("--keep");
const sizes = parseSizes(flag("--sizes"));
const profiles = (flag("--profiles") ?? "out-of-the-box,tuned,scoped,tuned-denormalized").split(
  ",",
) as ProfileName[];
const urlFlag = flag("--url") ?? process.env.TEST_DATABASE_URL;
const outFlag = flag("--out");
const command = args[0] ?? "all";
if (!["run", "assemble", "all"].includes(command))
  throw new Error(`unknown command "${command}" (run, assemble, all)`);

const log = (line: string) => console.error(line);
const isDefaultSet =
  sizes.length === DEFAULT_SIZES.length && sizes.every((n, i) => n === DEFAULT_SIZES[i]);
const out =
  outFlag ?? (isDefaultSet ? profilesFile : join(runsDir, `profiles-${sizes.join("-")}.json`));

if (command !== "assemble") {
  let url = urlFlag;
  let started = false;
  if (!url) {
    if (!dockerAvailable())
      throw new Error(
        "No TEST_DATABASE_URL and Docker is not running. Start Docker or pass --url.",
      );
    log("starting postgres:18 (drizzle-resource-bench)…");
    url = await startContainer();
    started = true;
  }
  try {
    for (const rows of sizes) await runSize(url, rows, { profiles, keep, log });
  } finally {
    if (started && !keep) removeContainer();
  }
}

if (command !== "run") {
  const runs = readRuns().filter((r) => sizes.includes(r.rows));
  if (runs.length === 0)
    throw new Error(`no runs in ${runsDir} for ${sizes.join(", ")} rows; run the benchmark first`);
  const data = assemble(runs, { final, sizes });
  writeProfiles(out, data);
  log(`wrote ${out} (provisional: ${data.provisional}; load threshold ${LOAD_THRESHOLD})`);
  if (final && data.provisional) log(data.notes[0]!);
  if (final && data.provisional) process.exitCode = 2;
}
