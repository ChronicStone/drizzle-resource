import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DOCKER } from "./config.ts";

function docker(args: string[], allowFail = false) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFail)
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

export const dockerAvailable = () =>
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

/** The container this process started. Its name is unique, so a second run never touches the first. */
export let containerName: string | undefined;

/** Starts the benchmark database: postgres:18, 4 CPUs, 4 GB, the settings the published numbers used. */
export async function startContainer(): Promise<{ url: string; name: string }> {
  const name = `drizzle-resource-bench-${randomBytes(3).toString("hex")}`;
  containerName = name;
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--cpus",
    DOCKER.cpus,
    "--memory",
    DOCKER.memory,
    "--shm-size",
    "1g",
    "-e",
    "POSTGRES_PASSWORD=bench",
    "-e",
    "POSTGRES_DB=bench",
    // Docker picks a free port on this machine.
    "-p",
    "127.0.0.1::5432",
    DOCKER.image,
    ...Object.entries(DOCKER.settings).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
  ]);
  const mapping = docker(["port", name, "5432/tcp"]).stdout.trim().split("\n")[0]!;
  const port = mapping.slice(mapping.lastIndexOf(":") + 1);
  const url = `postgres://postgres:bench@127.0.0.1:${port}/bench`;
  const ready = () =>
    docker(["exec", name, "pg_isready", "-U", "postgres", "-d", "bench"], true).status === 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // The image restarts once after initialising; wait until it answers twice in a row.
    if (ready()) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (ready()) return { url, name };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${name} did not become ready`);
}

/** Removes the container and its anonymous volume, so the disk comes back. */
export function removeContainer() {
  if (containerName) docker(["rm", "-f", "-v", containerName], true);
}
