import { spawnSync } from "node:child_process";
import { DOCKER } from "./config.ts";

function docker(args: string[], allowFail = false) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFail)
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

export const dockerAvailable = () =>
  spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

/** Starts the benchmark database: postgres:18, 4 CPUs, 4 GB, the settings the published numbers used. */
export async function startContainer(): Promise<string> {
  docker(["rm", "-f", "-v", DOCKER.name], true);
  docker([
    "run",
    "-d",
    "--name",
    DOCKER.name,
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
    "-p",
    `127.0.0.1:${DOCKER.port}:5432`,
    DOCKER.image,
    ...Object.entries(DOCKER.settings).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
  ]);
  const url = `postgres://postgres:bench@127.0.0.1:${DOCKER.port}/bench`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = docker(
      ["exec", DOCKER.name, "pg_isready", "-U", "postgres", "-d", "bench"],
      true,
    );
    // The image restarts once after initialising; wait until a query goes through twice in a row.
    if (ready.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (
        docker(["exec", DOCKER.name, "pg_isready", "-U", "postgres", "-d", "bench"], true)
          .status === 0
      )
        return url;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${DOCKER.name} did not become ready`);
}

/** Removes the container and its anonymous volume, so the disk comes back. */
export function removeContainer() {
  docker(["rm", "-f", "-v", DOCKER.name], true);
}
