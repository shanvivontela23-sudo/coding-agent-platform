import { createSign } from "node:crypto";
import { E2B } from "e2b";
import { RunTokenService } from "../../../evals/src/gateway/run-token.js";
import type { DemoConfig } from "./config.js";
import { ensureDemoMigrations, runCommand } from "./migrations.js";

export type DemoPreflightDependencies = {
  readonly checkDatabase: () => Promise<void>;
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

export function createLiveDemoPreflight(config: DemoConfig, tunnelUrl: string): DemoPreflightDependencies {
  const value = (name: string): string => config.values[name] ?? "";
  return {
    checkDatabase: async () => { await ensureDemoMigrations(value("DEMO_DATABASE_ADMIN_URL")); },
    checkSupabase: async () => { await fetchReady(`${value("SUPABASE_URL").replace(/\/$/, "")}/auth/v1/settings`, { headers: { apikey: value("SUPABASE_ANON_KEY") } }); },
    checkGitHubContentsWrite: async () => {
      const response = await fetchReady("https://api.github.com/app", { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${githubAppJwt(value("GITHUB_APP_ID"), value("GITHUB_APP_PRIVATE_KEY"))}`, "x-github-api-version": "2026-03-10" } });
      const body = await response.json() as { readonly permissions?: { readonly contents?: string } };
      if (body.permissions?.contents !== "write") throw new Error("GitHub App → Repository permissions → Contents: Read and write is required");
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
