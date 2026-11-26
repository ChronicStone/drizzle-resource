/**
 * The scaling benchmark behind the docs' Scale pages and the landing chart: orders with a customers
 * relation at 200,000, 1 million and 10 million rows, out of the box, tuned with what
 * `engine.checkIndexes()` asks for, and scoped to a tenant. One command:
 *
 *   bun run benchmark:scale [run|assemble|all] [--final] [--sizes 200k,1m,10m]
 *                           [--url postgres://…] [--keep] [--out file]
 *
 * Without --url (or TEST_DATABASE_URL) it starts a postgres:18 container with the settings the
 * published numbers used and removes it afterwards, also on Ctrl-C. `run` saves one file per size
 * in tools/results/scale-runs/ with the load average it was taken under; `assemble` publishes the
 * quietest run of each size into tools/results/profiles.json, but only when every default size has
 * a run and nothing was skipped (and, with --final, the machine was quiet). Otherwise it writes
 * next to the runs and says why. See tools/bench/README.md.
 */
import { join, resolve } from "node:path";
import {
  DEFAULT_SIZES,
  LOAD_THRESHOLD,
  parseSizes,
  profilesFile,
  runsDir,
  DOCKER,
} from "./config.ts";
import { assemble, readRuns, writeProfiles } from "./assemble.ts";
import { dockerAvailable, removeContainer, startContainer } from "./docker.ts";
import { runSize } from "./run.ts";

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
const urlFlag = flag("--url") ?? process.env.TEST_DATABASE_URL;
const outFlag = flag("--out");
const command = args[0] ?? "all";
if (!["run", "assemble", "all"].includes(command))
  throw new Error(`unknown command "${command}" (run, assemble, all)`);
if (final && process.env.BENCH_LOAD_THRESHOLD && Number(process.env.BENCH_LOAD_THRESHOLD) !== 8)
  throw new Error("--final needs the load threshold to be 8; unset BENCH_LOAD_THRESHOLD");

const log = (line: string) => console.error(line);

if (command !== "assemble") {
  let url = urlFlag;
  let started = false;
  // The container goes away on Ctrl-C and on a kill too, not only on a clean exit.
  const cleanup = () => {
    if (started && !keep) removeContainer();
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => {
      log(`${signal}: removing the container`);
      cleanup();
      process.exit(code);
    });
  try {
    if (!url) {
      if (!dockerAvailable())
        throw new Error(
          "No TEST_DATABASE_URL and Docker is not running. Start Docker or pass --url.",
        );
      log("starting postgres:18 (drizzle-resource-bench)…");
      started = true;
      url = await startContainer();
    }
    for (const rows of sizes) await runSize(url, rows, { keep, log });
    if (started && keep)
      log(
        `kept: container ${DOCKER.name} and the scale_* schemas.\n  connect: psql ${url}\n  remove:  docker rm -f -v ${DOCKER.name}`,
      );
  } finally {
    cleanup();
  }
}

if (command !== "run") {
  const runs = readRuns().filter((r) => sizes.includes(r.rows));
  if (runs.length === 0)
    throw new Error(`no runs in ${runsDir} for ${sizes.join(", ")} rows; run the benchmark first`);
  const result = assemble(runs, { final, sizes });
  const isDefaultSet =
    sizes.length === DEFAULT_SIZES.length && sizes.every((n, i) => n === DEFAULT_SIZES[i]);
  if (outFlag && resolve(outFlag) === resolve(profilesFile) && !result.publishable)
    throw new Error(
      `refusing to write ${profilesFile}: ${result.reasons.join("; ") || "the result is not publishable"}`,
    );
  const target =
    outFlag ??
    (result.publishable ? profilesFile : join(runsDir, `profiles-${sizes.join("-")}.json`));
  writeProfiles(target, result.data);
  log(
    `wrote ${target} (provisional: ${result.data.provisional}; load threshold ${final ? 8 : LOAD_THRESHOLD})`,
  );
  if (!result.publishable && !outFlag)
    log(
      `NOT written to tools/results/profiles.json: ${isDefaultSet || result.reasons.length ? result.reasons.join("; ") || "see notes" : ""}`,
    );
  if (final && result.data.provisional) {
    log(`--final refused: ${result.reasons.join("; ")}`);
    process.exitCode = 2;
  }
}
