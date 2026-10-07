import { resolve } from "node:path";
import { parseModelListPrices } from "../src/gateway/http/index.js";
import { finishAndReconcileLocalRun, startLocalHttpRun } from "../src/operator/http-run-control.js";
import { requireLiveSmoke } from "./contracts.js";
import { assertIncrementalAnthropicStream, gatewayUrlFromHostname } from "./local-tunnel.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for local tunnel preflight`);
  return value;
}
function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
function estimateSpend(model: string, body: Readonly<Record<string, unknown>>): number {
  const prices = parseModelListPrices(required("HARNESS_MODEL_PRICES_JSON"));
  const price = prices[model];
  if (!price) throw new Error(`HARNESS_MODEL_PRICES_JSON has no entry for ${model}`);
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : price.defaultMaxOutputTokens;
  const inputTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body), "utf8") / 3);
  return (inputTokens * price.inputUsdPerMillionTokens + maxTokens * price.outputUsdPerMillionTokens) / 1_000_000;
}

async function main(): Promise<void> {
  requireLiveSmoke();
  required("ANTHROPIC_API_KEY");
  const hostname = required("GATEWAY_HOSTNAME");
  const gatewayUrl = gatewayUrlFromHostname(hostname);
  const model = required("SMOKE_ANTHROPIC_MODEL");
  const stateDir = resolve(process.env.LOCAL_GATEWAY_STATE_DIR ?? ".local/gateway-state");
  const litellmBaseUrl = process.env.SMOKE_LITELLM_BASE_URL?.trim() || "http://127.0.0.1:4000";
  const spendCapUsd = positiveNumber("LOCAL_SMOKE_SPEND_CAP_USD", 1);
  const requestBody = {
    model,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly four short words, emitted normally." }],
  } as const;
  const estimatedSpend = estimateSpend(model, requestBody);
  if (estimatedSpend > spendCapUsd) throw new Error(`estimated request spend $${estimatedSpend.toFixed(6)} exceeds local smoke cap $${spendCapUsd.toFixed(2)}`);
  process.stdout.write(`Estimated model spend before paid preflight: $${estimatedSpend.toFixed(6)} (run cap $${spendCapUsd.toFixed(2)})\n`);

  const local = await startLocalHttpRun({
    stateDir,
    litellmBaseUrl,
    litellmAdminToken: required("LITELLM_MASTER_KEY"),
    signingSecret: required("MODEL_GATEWAY_RUN_TOKEN_SECRET"),
    allowedModels: [model],
    spendCapUsd,
    ttlMs: 15 * 60_000,
  });

  // This is intentionally the first request made through the public tunnel.
  // It must prove the tunnel does not buffer model output before any other
  // tunnel-level readiness assertion is allowed to pass.
  const response = await fetch(`${gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": local.token,
    },
    body: JSON.stringify(requestBody),
  });
  const incremental = await assertIncrementalAnthropicStream(response);
  process.stdout.write(`Incremental tunnel stream proved with ${incremental.dataChunks} pre-terminal reads.\n`);

  const actualSpend = await finishAndReconcileLocalRun(local);
  const calls = await local.callStore.listCalls(local.run.runId);
  if (calls.length !== 1) throw new Error(`expected exactly one Claude preflight call, found ${calls.length}`);
  const call = calls[0]!;
  if (call.provider !== "anthropic" || call.model !== model) throw new Error("local preflight call was not recorded as the configured Anthropic model");
  if (call.costPending) throw new Error("local preflight spend did not reconcile");
  process.stdout.write(`Actual reconciled model spend: $${actualSpend.toFixed(6)}\n`);
  process.stdout.write("Claude local tunnel configuration checks passed. No Codex or OpenAI model was executed.\n");
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
