import { E2B } from "e2b";
import { createGitHubInstallationPermissionReader, type GitHubInstallationPermissionReader } from "../../api/src/github-installation-permissions.js";
import { parseModelListPrices } from "../../../evals/src/gateway/http/cost-estimator.js";
import { RunTokenService } from "../../../evals/src/gateway/run-token.js";
import type { DemoConfig } from "./config.js";
import { ensureDemoMigrations, runCommand } from "./migrations.js";

export type DemoPreflightDependencies = {
  readonly checkDatabase: () => Promise<void>;
  readonly checkSupabase: () => Promise<void>;
  readonly checkGitHubContentsWrite: () => Promise<void>;
  readonly checkPlanningModelPrice: () => Promise<void>;
  readonly checkExecutionModelPrice: () => Promise<void>;
  readonly checkE2BListOnly: () => Promise<void>;
  readonly checkLiteLLM: () => Promise<void>;
  readonly checkTunnel: () => Promise<void>;
  readonly checkGatewayToken: () => Promise<void>;
  readonly checkWorkerClaimRollback: () => Promise<void>;
};
export type DemoPreflightResult = { readonly name: string; readonly ok: boolean; readonly message: string };

const checks: readonly [string, keyof DemoPreflightDependencies][] = [
  ["database roles and migrations", "checkDatabase"],
  ["Supabase", "checkSupabase"],
  ["GitHub App Contents: Read and write", "checkGitHubContentsWrite"],
  ["planning model price", "checkPlanningModelPrice"],
  ["execution model price", "checkExecutionModelPrice"],
  ["E2B authentication (list only)", "checkE2BListOnly"],
  ["LiteLLM", "checkLiteLLM"],
  ["ngrok gateway tunnel", "checkTunnel"],
  ["gateway token minting", "checkGatewayToken"],
  ["worker claim rollback dry-run", "checkWorkerClaimRollback"],
] as const;

const connectGitHubMessage = "Connect the GitHub App from Dhara home before the demo.";
const multipleGitHubMessage = "More than one GitHub installation is connected; set DEMO_ORGANIZATION_ID to choose one.";
const disconnectedGitHubMessage = "GitHub installation is disconnected.";
const acceptContentsMessage = "Accept the new Contents permission on the dhara-coding-agent installation (GitHub → Settings → Applications → Installed GitHub Apps).";

export async function runDemoPreflight(deps: DemoPreflightDependencies): Promise<readonly DemoPreflightResult[]> {
  const results: DemoPreflightResult[] = [];
  for (const [name, key] of checks) {
    try { await deps[key](); results.push({ name, ok: true, message: "ready" }); }
    catch (error) { results.push({ name, ok: false, message: error instanceof Error ? error.message : "check failed" }); }
  }
  return results;
}

export function assertDemoModelPrice(pricesJson: string, model: string, kind: "planning" | "execution"): void {
  const label = kind === "planning" ? "Planning" : "Execution";
  try {
    const prices = parseModelListPrices(pricesJson);
    const price = prices[model];
    if (!price || (price.inputUsdPerMillionTokens === 0 && price.outputUsdPerMillionTokens === 0)) throw new Error("missing model");
  } catch {
    throw new Error(`${label} model ${model} has no configured price.`);
  }
}

type InstallationRow = { readonly organizationId: string; readonly installationId: number; readonly status: string };

function parseInstallationRows(stdout: string): readonly InstallationRow[] {
  if (!stdout.trim()) return [];
  return stdout.trim().split(/\r?\n/).map((line) => {
    const [organizationId, installationIdRaw, status] = line.split("\t");
    const installationId = Number(installationIdRaw);
    if (!organizationId || !Number.isSafeInteger(installationId) || installationId <= 0 || !status) throw new Error("GitHub installation record is invalid.");
    return { organizationId, installationId, status };
  });
}

async function resolveDemoGitHubInstallationId(config: DemoConfig, runCommandImpl: typeof runCommand): Promise<number> {
  const databaseUrl = config.values.DEMO_DATABASE_ADMIN_URL ?? "";
  const result = await runCommandImpl("psql", [
    databaseUrl,
    "-v", "ON_ERROR_STOP=1",
    "-At",
    "-F", "\t",
    "-c", "SELECT organization_id::text,installation_id::text,status FROM public.github_installations ORDER BY organization_id;",
  ]);
  const rows = parseInstallationRows(result.stdout);
  const organizationId = config.values.DEMO_ORGANIZATION_ID?.trim();
  if (organizationId) {
    const selected = rows.find((row) => row.organizationId === organizationId);
    if (!selected) throw new Error(connectGitHubMessage);
    if (selected.status !== "connected") throw new Error(disconnectedGitHubMessage);
    return selected.installationId;
  }
  const connected = rows.filter((row) => row.status === "connected");
  if (connected.length > 1) throw new Error(multipleGitHubMessage);
  if (connected.length === 1) return connected[0]!.installationId;
  if (rows.length > 0) throw new Error(disconnectedGitHubMessage);
  throw new Error(connectGitHubMessage);
}

export async function checkDemoGitHubContentsWrite(config: DemoConfig, dependencies: {
  readonly runCommandImpl?: typeof runCommand;
  readonly permissionReader?: GitHubInstallationPermissionReader;
} = {}): Promise<void> {
  const runCommandImpl = dependencies.runCommandImpl ?? runCommand;
  const installationId = await resolveDemoGitHubInstallationId(config, runCommandImpl);
  const permissionReader = dependencies.permissionReader ?? createGitHubInstallationPermissionReader({
    appId: config.values.GITHUB_APP_ID ?? "",
    privateKey: config.values.GITHUB_APP_PRIVATE_KEY ?? "",
  });
  const permissions = await permissionReader.getInstallationPermissions(installationId, { bypassCache: true });
  if (permissions.contents !== "write") throw new Error(acceptContentsMessage);
}

async function fetchReady(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

export function createLiveDemoPreflight(config: DemoConfig, tunnelUrl: string): DemoPreflightDependencies {
  const value = (name: string): string => config.values[name] ?? "";
  return {
    checkDatabase: async () => { await ensureDemoMigrations(value("DEMO_DATABASE_ADMIN_URL")); },
    checkSupabase: async () => { await fetchReady(`${value("SUPABASE_URL").replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: value("SUPABASE_ANON_KEY") } }); },
    checkGitHubContentsWrite: async () => { await checkDemoGitHubContentsWrite(config); },
    checkPlanningModelPrice: async () => { assertDemoModelPrice(value("HARNESS_MODEL_PRICES_JSON"), value("TASK_MODEL_NAME"), "planning"); },
    checkExecutionModelPrice: async () => { assertDemoModelPrice(value("HARNESS_MODEL_PRICES_JSON"), value("TASK_EXECUTION_MODEL"), "execution"); },
    checkE2BListOnly: async () => {
      const client = new E2B({ apiKey: value("E2B_API_KEY") });
      const paginator = client.Sandbox.list({ limit: 1 });
      await paginator.nextItems();
    },
    checkLiteLLM: async () => {
      const headers = { authorization: `Bearer ${value("LITELLM_MASTER_KEY")}` };
      const live = await fetch("http://127.0.0.1:4000/health/liveliness", { headers, signal: AbortSignal.timeout(10_000) });
      if (live.ok) return;
      await fetchReady("http://127.0.0.1:4000/health", { headers });
    },
    checkTunnel: async () => {
      if (!/^https:\/\//.test(tunnelUrl)) throw new Error("ngrok did not expose an HTTPS gateway tunnel");
      const response = await fetch(tunnelUrl, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if (response.status >= 500) throw new Error(`ngrok gateway returned HTTP ${response.status}`);
    },
    checkGatewayToken: async () => {
      const service = new RunTokenService({ secret: value("MODEL_GATEWAY_RUN_TOKEN_SECRET") }); const runId = "demo-preflight"; const token = service.issue(runId, Date.now() + 60_000); service.verify(token, runId);
    },
    checkWorkerClaimRollback: async () => {
      await runCommand("psql", [value("DEMO_WORKER_DATABASE_URL"), "-v", "ON_ERROR_STOP=1", "-At", "-c", "BEGIN; SELECT * FROM public.claim_task_execution('demo-preflight',1); ROLLBACK;"]);
    },
  };
}
