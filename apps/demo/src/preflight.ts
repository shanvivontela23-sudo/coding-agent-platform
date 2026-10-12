import { createSign } from "node:crypto";
import { E2B } from "e2b";
import { parseModelListPrices } from "../../../evals/src/gateway/http/cost-estimator.js";
import { RunTokenService } from "../../../evals/src/gateway/run-token.js";
import type { DemoConfig } from "./config.js";
import { ensureDemoMigrations, runCommand, type CommandResult } from "./migrations.js";

export type DemoPreflightDependencies = {
  readonly checkDatabase: () => Promise<void>;
  readonly checkModelPrices: () => Promise<void>;
  readonly checkSupabase: () => Promise<void>;
  readonly checkGitHubContentsWrite: () => Promise<void>;
  readonly checkE2BListOnly: () => Promise<void>;
  readonly checkLiteLLM: () => Promise<void>;
  readonly checkTunnel: () => Promise<void>;
  readonly checkGatewayToken: () => Promise<void>;
  readonly checkWorkerClaimRollback: () => Promise<void>;
};
export type DemoPreflightResult = { readonly name: string; readonly ok: boolean; readonly message: string };

const checks: readonly [string, keyof DemoPreflightDependencies][] = [
  ["database roles and migrations", "checkDatabase"],
  ["model list prices", "checkModelPrices"],
  ["Supabase", "checkSupabase"],
  ["GitHub App Contents: Read and write", "checkGitHubContentsWrite"],
  ["E2B authentication (list only)", "checkE2BListOnly"],
  ["LiteLLM", "checkLiteLLM"],
  ["ngrok gateway tunnel", "checkTunnel"],
  ["gateway token minting", "checkGatewayToken"],
  ["worker claim rollback dry-run", "checkWorkerClaimRollback"],
] as const;

export async function runDemoPreflight(deps: DemoPreflightDependencies): Promise<readonly DemoPreflightResult[]> {
  const results: DemoPreflightResult[] = [];
  for (const [name, key] of checks) {
    try { await deps[key](); results.push({ name, ok: true, message: "ready" }); }
    catch (error) { results.push({ name, ok: false, message: error instanceof Error ? error.message : "check failed" }); }
  }
  return results;
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function githubAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const seconds = Math.floor(nowMs / 1000); const header = encode({ alg: "RS256", typ: "JWT" }); const payload = encode({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId }); const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256"); signer.update(unsigned); signer.end(); const key = privateKey.includes("\\n") ? privateKey.replaceAll("\\n", "\n") : privateKey;
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
}
async function fetchReady(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RunCommandImpl = (command: string, args: readonly string[], options?: { readonly env?: NodeJS.ProcessEnv; readonly input?: string }) => Promise<CommandResult>;

export async function readDemoInstallationId(input: {
  readonly databaseUrl: string;
  readonly organizationId: string;
  readonly runCommandImpl?: RunCommandImpl;
}): Promise<number> {
  if (!uuidPattern.test(input.organizationId)) throw new Error("DEMO_ORGANIZATION_ID must be a UUID");
  const run = input.runCommandImpl ?? runCommand;
  const sql = `SELECT installation_id FROM public.github_installations WHERE organization_id = '${input.organizationId}'::uuid AND status = 'connected';`;
  const result = await run("psql", [input.databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
  const rows = result.stdout.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  if (rows.length !== 1 || !/^\d+$/.test(rows[0] ?? "")) throw new Error("The demo organization must have exactly one connected GitHub App installation recorded in Dhara.");
  const installationId = Number(rows[0]);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error("The recorded GitHub App installation id is invalid.");
  return installationId;
}

export async function checkInstallationContentsWrite(input: {
  readonly installationId: number;
  readonly appJwt: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://api.github.com/app/installations/${input.installationId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.appJwt}`,
      "x-github-api-version": "2026-03-10",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub installation permission check failed with HTTP ${response.status}`);
  const body = await response.json() as { readonly permissions?: { readonly contents?: string } };
  if (body.permissions?.contents !== "write") {
    throw new Error("Accept the new Contents permission on the dhara-coding-agent installation (GitHub → Settings → Applications → Installed GitHub Apps).");
  }
}

export function assertDemoModelPrices(raw: string | undefined, executionModel: string, planningModel: string): void {
  if (!raw?.trim()) throw new Error("HARNESS_MODEL_PRICES_JSON is required for demo cost accounting.");
  const prices = parseModelListPrices(raw.trim());
  for (const model of new Set([executionModel.trim(), planningModel.trim()])) {
    if (!model) throw new Error("TASK_EXECUTION_MODEL and TASK_MODEL_NAME are required for demo cost accounting.");
    const price = prices[model];
    if (!price) throw new Error(`HARNESS_MODEL_PRICES_JSON must include a price for configured model ${model}.`);
    if (price.inputUsdPerMillionTokens === 0 && price.outputUsdPerMillionTokens === 0) {
      throw new Error(`HARNESS_MODEL_PRICES_JSON price for ${model} cannot have both input and output prices set to zero.`);
    }
  }
}

export function createLiveDemoPreflight(config: DemoConfig, tunnelUrl: string): DemoPreflightDependencies {
  const value = (name: string): string => config.values[name] ?? "";
  return {
    checkDatabase: async () => { await ensureDemoMigrations(value("DEMO_DATABASE_ADMIN_URL")); },
    checkModelPrices: async () => { assertDemoModelPrices(value("HARNESS_MODEL_PRICES_JSON"), value("TASK_EXECUTION_MODEL"), value("TASK_MODEL_NAME")); },
    checkSupabase: async () => { await fetchReady(`${value("SUPABASE_URL").replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: value("SUPABASE_ANON_KEY") } }); },
    checkGitHubContentsWrite: async () => {
      const installationId = await readDemoInstallationId({ databaseUrl: value("DEMO_DATABASE_ADMIN_URL"), organizationId: value("DEMO_ORGANIZATION_ID") });
      await checkInstallationContentsWrite({ installationId, appJwt: githubAppJwt(value("GITHUB_APP_ID"), value("GITHUB_APP_PRIVATE_KEY")) });
    },
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
