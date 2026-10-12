import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadDemoEnvironment, publicDemoSummary, readRootDotEnv, redactDemoSecrets, type DemoConfig } from "./config.js";
import { createDemoLaunchPlan, type DemoProcessPlan } from "./launcher.js";
import { ensureDemoMigrations, runCommand } from "./migrations.js";
import { createLiveDemoPreflight, runDemoPreflight } from "./preflight.js";

function cleanEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function runtimeEnv(explicit: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(["PATH", "HOME", "USER", "TMPDIR", "SHELL", "TERM", "DOCKER_HOST"].flatMap((name) => {
    const value = process.env[name]; return value ? [[name, value] as const] : [];
  }));
  return cleanEnv({ ...inherited, ...explicit });
}

async function checkCommand(command: string, args: readonly string[]): Promise<void> {
  try { await runCommand(command, args); }
  catch { throw new Error(`${command} is required for the demo`); }
}

async function discoverNgrokTunnel(): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const payload = await response.json() as { readonly tunnels?: readonly { readonly public_url?: string; readonly config?: { readonly addr?: string } }[] };
        const tunnel = payload.tunnels?.find((item) => item.public_url?.startsWith("https://") && (item.config?.addr?.includes("8080") ?? true));
        if (tunnel?.public_url) return tunnel.public_url;
      }
    } catch { /* retry until the local ngrok API is ready */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("ngrok did not publish an HTTPS tunnel for port 8080");
}

function startProcess(label: string, plan: DemoProcessPlan, config: DemoConfig): ChildProcess {
  const child = spawn(plan.command, [...plan.args], { env: runtimeEnv(plan.env), stdio: ["ignore", "pipe", "pipe"] });
  const write = (target: NodeJS.WriteStream, chunk: Buffer | string) => target.write(`[${label}] ${redactDemoSecrets(String(chunk), config)}`);
  child.stdout?.on("data", (chunk: Buffer) => write(process.stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => write(process.stderr, chunk));
  child.once("error", (error) => process.stderr.write(`[${label}] ${redactDemoSecrets(error.message, config)}\n`));
  return child;
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function main(): Promise<void> {
  const dotenv = await readRootDotEnv();
  const loaded = loadDemoEnvironment({ ...process.env, ...dotenv });
  if (!loaded.ok) throw new Error(loaded.message);
  const config = loaded.config;
  process.stdout.write(`${publicDemoSummary(config)}\n`);

  await Promise.all([
    checkCommand("docker", ["--version"]),
    checkCommand("psql", ["--version"]),
    checkCommand("ngrok", ["version"]),
    checkCommand("pnpm", ["--version"]),
  ]);
  await mkdir(join(process.cwd(), ".local", "gateway-state"), { recursive: true });
  const migration = await ensureDemoMigrations(config.values.DEMO_DATABASE_ADMIN_URL ?? "");
  process.stdout.write(`Database migrations: ${migration.applied.length > 0 ? `applied ${migration.applied.join(", ")}` : `verified through ${migration.plan.at(-1)?.name ?? "none"}`}\n`);

  const placeholderPlan = createDemoLaunchPlan(config, "https://placeholder.invalid");
  await runCommand(placeholderPlan.compose.command, placeholderPlan.compose.args, { env: runtimeEnv(placeholderPlan.compose.env) });

  let ngrok: ChildProcess | null = null;
  let api: ChildProcess | null = null;
  let web: ChildProcess | null = null;
  let worker: ChildProcess | null = null;
  let shuttingDown = false;
  const down = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([stopChild(worker), stopChild(web), stopChild(api), stopChild(ngrok)]);
    await runCommand("docker", ["compose", "--env-file", ".env", "-f", "evals/deploy/http-gateway/compose.local.yaml", "down"], { env: runtimeEnv(placeholderPlan.compose.env) }).catch(() => undefined);
  };
  const requestShutdown = () => { void down().finally(() => process.exit(0)); };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    ngrok = startProcess("ngrok", placeholderPlan.ngrok, config);
    const tunnelUrl = await discoverNgrokTunnel();
    const plan = createDemoLaunchPlan(config, tunnelUrl);
    const preflight = await runDemoPreflight(createLiveDemoPreflight(config, tunnelUrl));
    for (const result of preflight) process.stdout.write(`${result.ok ? "✓" : "✗"} ${result.name}: ${redactDemoSecrets(result.message, config)}\n`);
    const failed = preflight.filter((result) => !result.ok);
    if (failed.length > 0) throw new Error(`Demo preflight failed: ${failed.map((item) => item.name).join(", ")}`);

    api = startProcess("api", plan.api, config);
    web = startProcess("web", plan.web, config);
    worker = startProcess("worker", plan.worker, config);
    process.stdout.write(`Dhara demo ready: http://localhost:${config.webPort}\nGateway tunnel: ${tunnelUrl}\n`);
    await Promise.race([
      new Promise<void>((resolve) => api?.once("exit", () => resolve())),
      new Promise<void>((resolve) => web?.once("exit", () => resolve())),
      new Promise<void>((resolve) => worker?.once("exit", () => resolve())),
    ]);
    throw new Error("A demo process exited; shutting down the stack");
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    await down();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Demo startup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
