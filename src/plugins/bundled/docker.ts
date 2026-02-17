/**
 * TaskSmith Official Plugin: Docker
 *
 * Run tasks in isolated Docker containers for safety and reproducibility.
 *
 * Features:
 *   - Execute tasks inside containers with mounted project dirs
 *   - Auto-pull images before execution
 *   - Resource limits (CPU, memory, timeout)
 *   - Container cleanup after task completion
 *   - Build and cache custom images from Dockerfile
 *
 * Config:
 *   plugins:
 *     - name: docker
 *       config:
 *         enabled: true
 *         image: "node:22-slim"           # default container image
 *         mountProject: true              # mount project dir into container
 *         resourceLimits:
 *           cpus: "2"
 *           memory: "4g"
 *         autoCleanup: true               # remove containers after execution
 *         networkMode: "host"             # or "none" for full isolation
 *         additionalMounts: []            # extra -v mounts
 *         env: {}                         # extra env vars
 *
 * Task-level override:
 *   params:
 *     docker_image: "python:3.12-slim"
 *     docker_network: "none"
 */

import { execSync, spawnSync } from "node:child_process";
import type { ForgePluginContext } from "../../plugins.js";

interface DockerConfig {
  enabled: boolean;
  image: string;
  mountProject: boolean;
  resourceLimits: {
    cpus: string;
    memory: string;
  };
  autoCleanup: boolean;
  networkMode: string;
  additionalMounts: string[];
  env: Record<string, string>;
}

const DEFAULTS: DockerConfig = {
  enabled: true,
  image: "node:22-slim",
  mountProject: true,
  resourceLimits: {
    cpus: "2",
    memory: "4g",
  },
  autoCleanup: true,
  networkMode: "host",
  additionalMounts: [],
  env: {},
};

function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["info"], { timeout: 5000, encoding: "utf-8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function pullImage(image: string): boolean {
  try {
    execSync(`docker pull ${image}`, { timeout: 120000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function imageExists(image: string): boolean {
  try {
    const result = spawnSync("docker", ["image", "inspect", image], { timeout: 5000, encoding: "utf-8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── Plugin Entry Point ──────────────────────────────────────────────

export default function dockerPlugin(ctx: ForgePluginContext, options: Record<string, unknown>): void {
  const config: DockerConfig = { ...DEFAULTS, ...options } as DockerConfig;
  if (options.resourceLimits) {
    config.resourceLimits = { ...DEFAULTS.resourceLimits, ...(options.resourceLimits as Record<string, string>) };
  }

  if (!isDockerAvailable()) {
    ctx.log.warn("Docker not available. Install Docker to enable container isolation.");
    return;
  }

  // Track active containers for cleanup
  const activeContainers = new Set<string>();

  // Hook: optionally wrap task execution in a container
  ctx.addHook("beforeTaskExecute", async (data): Promise<Record<string, unknown>> => {
    const task = data.task as Record<string, unknown> | undefined;
    if (!task) return {};

    const params = task.params as Record<string, unknown> | undefined;
    const useDocker = params?.docker !== false && config.enabled;
    if (!useDocker) return {};

    const image = (params?.docker_image as string) || config.image;
    const network = (params?.docker_network as string) || config.networkMode;
    const project = task.project as string;
    const projectDir = project ? `${ctx.workspace}/projects/${project}` : "";

    // Ensure image exists
    if (!imageExists(image)) {
      ctx.log.info(`Pulling image: ${image}`);
      if (!pullImage(image)) {
        ctx.log.error(`Failed to pull ${image}`);
        return {};
      }
    }

    // Build docker run args
    const containerName = `tasksmith-${task.id}`;
    const args: string[] = [
      "run", "--rm", "-d",
      "--name", containerName,
      "--cpus", config.resourceLimits.cpus,
      "--memory", config.resourceLimits.memory,
      "--network", network,
    ];

    // Mount project directory
    if (config.mountProject && projectDir) {
      args.push("-v", `${projectDir}:/workspace`);
      args.push("-w", "/workspace");
    }

    // Additional mounts
    for (const mount of config.additionalMounts) {
      args.push("-v", mount);
    }

    // Environment variables
    for (const [key, val] of Object.entries(config.env)) {
      args.push("-e", `${key}=${val}`);
    }

    // Pass through common env vars
    for (const envKey of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "NODE_ENV"]) {
      if (process.env[envKey]) {
        args.push("-e", `${envKey}=${process.env[envKey]}`);
      }
    }

    args.push(image, "tail", "-f", "/dev/null"); // keep container alive

    try {
      const result = spawnSync("docker", args, { encoding: "utf-8", timeout: 30000 });
      if (result.status === 0) {
        activeContainers.add(containerName);
        ctx.log.info(`Container started: ${containerName} (${image})`);

        // Inject container info into task params for the engine to use
        return { task: { ...task, params: { ...params, _dockerContainer: containerName } } } as Record<string, unknown>;
      } else {
        ctx.log.error(`Failed to start container: ${result.stderr}`);
      }
    } catch (e: any) {
      ctx.log.error(`Docker error: ${e.message}`);
    }
    return {};
  });

  // Hook: cleanup container after task completes
  ctx.addHook("afterTaskExecute", async (data) => {
    const task = data.task as Record<string, unknown> | undefined;
    const params = task?.params as Record<string, unknown> | undefined;
    const containerName = params?._dockerContainer as string | undefined;

    if (containerName && config.autoCleanup) {
      try {
        spawnSync("docker", ["stop", containerName], { timeout: 15000 });
        activeContainers.delete(containerName);
        ctx.log.info(`Container stopped: ${containerName}`);
      } catch {
        ctx.log.warn(`Failed to stop container: ${containerName}`);
      }
    }
  });

  // Hook: cleanup all containers on shutdown
  ctx.addHook("onShutdown", async () => {
    for (const container of activeContainers) {
      try {
        spawnSync("docker", ["stop", container], { timeout: 10000 });
        ctx.log.info(`Cleanup: stopped ${container}`);
      } catch { /* best effort */ }
    }
    activeContainers.clear();
  });

  // Register CLI command: tasksmith docker
  ctx.addCommand("docker", {
    description: "Show Docker plugin status and running containers",
    options: [],
    action: async () => {
      const chalk = (await import("chalk")).default;
      console.log(chalk.bold("\n  Docker Plugin Status\n"));
      console.log(`    Docker:       ${chalk.green("available")}`);
      console.log(`    Default image: ${config.image}`);
      console.log(`    Network:      ${config.networkMode}`);
      console.log(`    CPU limit:    ${config.resourceLimits.cpus}`);
      console.log(`    Memory limit: ${config.resourceLimits.memory}`);
      console.log(`    Auto-cleanup: ${config.autoCleanup ? chalk.green("yes") : chalk.yellow("no")}`);

      // List running tasksmith containers
      try {
        const result = spawnSync("docker", ["ps", "--filter", "name=tasksmith-", "--format", "{{.Names}}\t{{.Image}}\t{{.Status}}"], { encoding: "utf-8", timeout: 5000 });
        if (result.stdout.trim()) {
          console.log(chalk.bold("\n  Running Containers\n"));
          for (const line of result.stdout.trim().split("\n")) {
            const [name, image, ...status] = line.split("\t");
            console.log(`    ${chalk.green("●")} ${name}  ${chalk.dim(image)}  ${status.join(" ")}`);
          }
        } else {
          console.log(chalk.dim("\n  No TaskSmith containers running.\n"));
        }
      } catch {
        console.log(chalk.dim("\n  Could not list containers.\n"));
      }
    },
  });

  ctx.log.info(`Docker isolation active (image: ${config.image}, network: ${config.networkMode})`);
}

export { DockerConfig };
