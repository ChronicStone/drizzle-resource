/**
 * The scaling benchmark behind the docs' Scale pages and the landing chart: orders with a customers
 * relation at 200,000, 1 million and 10 million rows, out of the box, tuned with what
 * `engine.checkIndexes()` asks for, and scoped to a tenant. One command:
 *
 *   bun run benchmark:scale [run|assemble|all] [--final] [--sizes 200k,1m,10m]
 *                           [--url postgres://…] [--keep] [--force] [--out file]
 *
 * Without --url (or TEST_DATABASE_URL) it starts a postgres:18 container with the settings the
 * published numbers used and removes it afterwards, also on Ctrl-C, SIGTERM and SIGHUP. With a
 * URL it drops its `scale_*` schemas the same way. `run` saves one file per size in
 * tools/results/scale-runs/ with the load average it was taken under; `assemble` publishes the
 * quietest run of each size into tools/results/profiles.json, but only when every default size has
 * a run and nothing failed (and, with --final, the machine was quiet and the run was sound).
 * Otherwise it writes next to the runs and says why. A provisional result never replaces a final
 * profiles.json without --force. See tools/bench/README.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_SIZES, LOAD_THRESHOLD, parseSizes, profilesFile, runsDir } from "./config.ts";
import { assemble, readRuns, writeProfiles } from "./assemble.ts";
import { containerName, dockerAvailable, removeContainer, startContainer } from "./docker.ts";
import { DOCKER } from "./config.ts";
import { createdSchemas, dropCreated, runSize, type DatabaseIdentity } from "./run.ts";

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
const force = bool("--force");
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
  let database: DatabaseIdentity = {
    via: "url",
    cpus: process.env.BENCH_DB_CPUS ?? "unknown",
    memory: process.env.BENCH_DB_MEMORY ?? "unknown",
  };
  // Everything this process made goes away on a clean exit, a failure, and Ctrl-C, SIGTERM or SIGHUP.
  const cleanup = async () => {
    if (keep) return;
    if (url) await dropCreated(url).catch(() => {});
    if (started) removeContainer();
  };
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.on(signal, () => {
      log(`${signal}: cleaning up`);
      void cleanup().finally(() => process.exit(code));
    });
  try {
    if (!url) {
      if (!dockerAvailable())
        throw new Error(
          "No TEST_DATABASE_URL and Docker is not running. Start Docker or pass --url.",
        );
      log("starting postgres:18…");
      started = true;
      const container = await startContainer();
      url = container.url;
      database = { via: "docker", cpus: DOCKER.cpus, memory: DOCKER.memory };
      log(`  container ${container.name}`);
    }
    for (const rows of sizes) await runSize(url, rows, { keep, database, log });
    if (keep)
      log(
        started
          ? `kept: container ${containerName} and the scale_* schemas.\n  connect: psql ${url}\n  remove:  docker rm -f -v ${containerName}`
          : `kept: the scale_* schemas in ${url}. Schemas: ${[...createdSchemas].join(", ") || "scale_<size>*"}`,
      );
  } finally {
    await cleanup();
  }
}

if (command !== "run") {
  const runs = readRuns().filter((r) => sizes.includes(r.rows));
  if (runs.length === 0)
    throw new Error(`no runs in ${runsDir} for ${sizes.join(", ")} rows; run the benchmark first`);
  const result = assemble(runs, { final, sizes });
  const isDefaultSet =
    sizes.length === DEFAULT_SIZES.length && sizes.every((n, i) => n === DEFAULT_SIZES[i]);
  const alongside = join(runsDir, `profiles-${sizes.join("-")}.json`);
  let target = outFlag ?? (result.publishable ? profilesFile : alongside);
  let refusal: string | undefined;
  if (resolve(target) === resolve(profilesFile)) {
    if (!result.publishable)
      throw new Error(
        `refusing to write ${profilesFile}: ${result.reasons.join("; ") || "the result is not publishable"}`,
      );
    const current = existsSync(profilesFile)
      ? (JSON.parse(readFileSync(profilesFile, "utf8")) as { provisional?: boolean })
      : {};
    if (current.provisional === false && result.data.provisional && !force) {
      refusal = `${profilesFile} is final and this result is provisional; pass --force to replace it`;
      target = alongside;
    }
  }
  writeProfiles(target, result.data);
  log(
    `wrote ${target} (provisional: ${result.data.provisional}; load threshold ${final ? 8 : LOAD_THRESHOLD})`,
  );
  if (refusal) log(`NOT written to tools/results/profiles.json: ${refusal}`);
  else if (!result.publishable && !outFlag)
    log(
      `NOT written to tools/results/profiles.json: ${(isDefaultSet || result.reasons.length ? result.reasons.join("; ") : "") || "see notes"}`,
    );
  if (refusal || (final && result.data.provisional)) {
    if (final && result.data.provisional) log(`--final refused: ${result.reasons.join("; ")}`);
    process.exitCode = 2;
  }
}
