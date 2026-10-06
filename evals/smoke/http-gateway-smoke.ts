import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileGatewayStore,
  RunTokenService,
  type GatewayRunRecord,
} from "../src/gateway/index.js";
import {
  FileHarnessCallStore,
  HarnessSpendReconciler,
  LiteLLMHarnessTransport,
  LiteLLMSpendClient,
  loadHarnessHttpConfig,
  protocolTranscriptSha256,
  proxyMeteredStream,
  type HarnessCallRecord,
  type HarnessDispatchRequest,
  type LiteLLMSpendRecord,
  type ProtocolTranscript,
} from "../src/gateway/http/index.js";
import {
  HTTP_GATEWAY_SMOKE_ASSERTIONS,
  requireLiveSmoke,
  writeSmokeEvidence,
  type SmokeAssertionId,
  type SmokeEvidenceRow,
} from "./contracts.js";

// The live preflight intentionally executes this as a real install, not --dry-run:
// python -m pip install --require-hashes -r evals/litellm/requirements.txt
const HASH_LOCK_INSTALL_ARGS = [
  "-m",
  "pip",
  "install",
  "--require-hashes",
  "-r",
  "evals/litellm/requirements.txt",
] as const;

const emptyUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live smoke`);
  return value;
}

function requiredDigest(name: string): string {
  const value = requiredEnv(name);
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error(`${name} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function gatewayBaseUrl(): string {
  const url = new URL(requiredEnv("SMOKE_GATEWAY_BASE_URL"));
  if (url.protocol !== "https:") throw new Error("SMOKE_GATEWAY_BASE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function litellmBaseUrl(): string {
  const url = new URL(requiredEnv("SMOKE_LITELLM_BASE_URL"));
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("SMOKE_LITELLM_BASE_URL must use HTTPS or loopback HTTP");
  }
  return url.toString().replace(/\/$/, "");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function errorCode(body: Readonly<Record<string, unknown>>): string | null {
  const error = body.error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

async function gatewayRequest(
  baseUrl: string,
  path: string,
  token: string | null,
  body: unknown,
  authMode: "bearer" | "x-api-key" = "bearer",
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json", ...extraHeaders });
  if (token) {
    if (authMode === "bearer") headers.set("authorization", `Bearer ${token}`);
    else headers.set("x-api-key", token);
  }
  return await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function createLiteLLMVirtualKey(
  baseUrl: string,
  adminToken: string,
  runId: string,
  spendCapUsd: number,
  ttlSeconds: number,
): Promise<string> {
  const response = await fetch(`${baseUrl}/key/generate`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      max_budget: spendCapUsd,
      duration: `${ttlSeconds}s`,
      metadata: { run_id: runId },
    }),
  });
  if (!response.ok) throw new Error(`LiteLLM key generation failed with status ${response.status}`);
  const body = await responseJson(response);
  if (typeof body.key !== "string" || body.key.length === 0) {
    throw new Error("LiteLLM key generation response did not contain a key");
  }
  return body.key;
}

type SmokeRun = {
  readonly run: GatewayRunRecord;
  readonly token: string;
};

async function createSmokeRun(
  gatewayStore: FileGatewayStore,
  tokenService: RunTokenService,
  litellmUrl: string,
  adminToken: string,
  allowedModels: readonly string[],
  spendCapUsd = 10,
): Promise<SmokeRun> {
  const runId = `smoke-${randomUUID()}`;
  const expiresAtMs = Date.now() + 30 * 60_000;
  const upstreamCredential = await createLiteLLMVirtualKey(
    litellmUrl,
    adminToken,
    runId,
    spendCapUsd,
    30 * 60,
  );
  const run: GatewayRunRecord = {
    runId,
    expiresAtMs,
    spendCapUsd,
    upstreamCredential,
    allowedModels: [...new Set(allowedModels)],
    status: "active",
  };
  await gatewayStore.createRun(run);
  return { run, token: tokenService.issue(runId, expiresAtMs) };
}

async function latestNewCall(
  store: FileHarnessCallStore,
  runId: string,
  before: ReadonlySet<string>,
): Promise<HarnessCallRecord> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const calls = await store.listCalls(runId);
    const created = calls.filter((call) => !before.has(call.callId));
    if (created.length > 0) return created.sort((a, b) => b.createdAtMs - a.createdAtMs)[0]!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("gateway call record was not persisted within smoke timeout");
}

async function waitForSettledCall(
  store: FileHarnessCallStore,
  runId: string,
  callId: string,
): Promise<HarnessCallRecord> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const call = await store.getCall(runId, callId);
    if (!call.costPending && call.state !== "accepted" && call.state !== "streaming") return call;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`call ${callId} did not settle within smoke timeout`);
}

async function waitForSpendRow(
  source: LiteLLMSpendClient,
  credential: string,
  callId: string,
): Promise<LiteLLMSpendRecord> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await source.listCallSpend(credential, callId);
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) throw new Error(`duplicate spend rows for ${callId}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`LiteLLM spend row missing for ${callId}`);
}

function assertUsageParity(
  call: HarnessCallRecord,
  row: LiteLLMSpendRecord,
  requireCached: boolean,
): void {
  const checks = [
    ["input", call.usage.inputTokens, row.inputTokens],
    ["cached", call.usage.cachedInputTokens, row.cachedInputTokens],
    ["cache-write", call.usage.cacheWriteInputTokens, row.cacheWriteInputTokens],
    ["output", call.usage.outputTokens, row.outputTokens],
    ["reasoning", call.usage.reasoningTokens, row.reasoningTokens],
  ] as const;
  for (const [name, gateway, litellm] of checks) {
    if (litellm !== null && gateway !== litellm) {
      throw new Error(`${name} token mismatch: gateway=${gateway} litellm=${litellm}`);
    }
  }
  if (requireCached && call.usage.cachedInputTokens <= 0) {
    throw new Error("cached token parity probe did not produce cached input tokens");
  }
}

async function callAndRecord(
  baseUrl: string,
  callStore: FileHarnessCallStore,
  run: SmokeRun,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly response: Response; readonly call: HarnessCallRecord }> {
  const before = new Set((await callStore.listCalls(run.run.runId)).map((call) => call.callId));
  const response = await gatewayRequest(baseUrl, path, run.token, body);
  const call = await latestNewCall(callStore, run.run.runId, before);
  return { response, call };
}

async function verifyTranscript(pathEnv: string, digestEnv: string, expectedName: string): Promise<void> {
  const path = requiredEnv(pathEnv);
  const expectedDigest = requiredDigest(digestEnv);
  const transcript = JSON.parse(await readFile(path, "utf8")) as ProtocolTranscript;
  if (transcript.harness.name !== expectedName) {
    throw new Error(`${pathEnv} did not contain a ${expectedName} transcript`);
  }
  const actual = protocolTranscriptSha256(transcript);
  if (actual !== expectedDigest) throw new Error(`${pathEnv} SHA-256 does not match reviewed evidence`);
}

async function runControlledTimeoutAssertions(): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};

  const firstResponseStream = new ReadableStream<Uint8Array>({ start() {} });
  const first = proxyMeteredStream({
    upstream: firstResponseStream,
    wireApi: "responses",
    abort: () => undefined,
    firstResponseTimeoutMs: 5,
    idleTimeoutMs: 1_000,
    maxDurationMs: 1_000,
  });
  first.body.getReader();
  result.first_response_timeout = (await first.completion).state === "timeout";

  const idleStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
    },
  });
  const idle = proxyMeteredStream({
    upstream: idleStream,
    wireApi: "responses",
    abort: () => undefined,
    firstResponseTimeoutMs: 1_000,
    idleTimeoutMs: 5,
    maxDurationMs: 1_000,
  });
  await idle.body.getReader().read();
  result.stream_idle_timeout = (await idle.completion).state === "timeout";

  const maxStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
    },
  });
  const maximum = proxyMeteredStream({
    upstream: maxStream,
    wireApi: "responses",
    abort: () => undefined,
    firstResponseTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxDurationMs: 5,
  });
  await maximum.body.getReader().read();
  result.maximum_stream_duration = (await maximum.completion).state === "timeout";

  const root = await mkdtemp(join(tmpdir(), "coding-agent-live-timeout-"));
  try {
    const gatewayStore = new FileGatewayStore({ rootDir: join(root, "gateway") });
    const callStore = new FileHarnessCallStore({ rootDir: join(root, "http") });
    const localRun: GatewayRunRecord = {
      runId: "timeout-run",
      expiresAtMs: Date.now() + 60_000,
      spendCapUsd: 10,
      upstreamCredential: "synthetic-timeout-key",
      allowedModels: ["timeout-model"],
      status: "active",
    };
    await gatewayStore.createRun(localRun);
    const fetchImpl: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const transport = new LiteLLMHarnessTransport({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
      gatewayStore,
      callStore,
      nonStreamingTimeoutMs: 5,
    });
    const request: HarnessDispatchRequest = {
      run: localRun,
      route: {
        method: "POST",
        path: "/v1/responses",
        wireApi: "responses",
        enabled: true,
        streamingAllowed: true,
        paid: true,
        modelField: "model",
        forwardRequestHeaders: [],
        safeResponseHeaders: [],
        modelSettingFields: [],
      },
      requestHeaders: {},
      body: { model: "timeout-model", input: "synthetic" },
      callId: "timeout-call",
      provider: "openai",
      model: "timeout-model",
      modelSettings: {},
    };
    const response = await transport.forward(request);
    result.non_streaming_timeout = response.status === 504;
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return result;
}

async function main(): Promise<void> {
  requireLiveSmoke();

  const baseUrl = gatewayBaseUrl();
  const litellmUrl = litellmBaseUrl();
  const adminToken = requiredEnv("LITELLM_ADMIN_TOKEN");
  const signingSecret = requiredEnv("MODEL_GATEWAY_RUN_TOKEN_SECRET");
  const openaiModel = requiredEnv("SMOKE_OPENAI_MODEL");
  const anthropicModel = requiredEnv("SMOKE_ANTHROPIC_MODEL");
  const backgroundModel = requiredEnv("SMOKE_BACKGROUND_MODEL");
  const gatewayStore = new FileGatewayStore({ rootDir: requiredEnv("SMOKE_GATEWAY_STORE_DIR") });
  const callStore = new FileHarnessCallStore({ rootDir: requiredEnv("SMOKE_HARNESS_CALL_STORE_DIR") });
  const tokenService = new RunTokenService({ secret: signingSecret });
  const spendSource = new LiteLLMSpendClient({ baseUrl: litellmUrl, adminToken });
  const evidence: SmokeEvidenceRow[] = [];

  const record = async (
    assertion: SmokeAssertionId,
    operation: () => Promise<Readonly<Record<string, unknown>> | void>,
  ): Promise<void> => {
    try {
      const detail = await operation();
      evidence.push({ assertion, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      evidence.push({
        assertion,
        ok: false,
        detail: { error: error instanceof Error ? error.message : "assertion failed" },
      });
    }
  };

  await record("hash_locked_litellm_install", async () => {
    execFileSync("python", [...HASH_LOCK_INSTALL_ARGS], { stdio: "pipe" });
    return { command: "python -m pip install --require-hashes -r evals/litellm/requirements.txt" };
  });

  await record("pinned_harness_transcripts", async () => {
    await verifyTranscript("SMOKE_CLAUDE_TRANSCRIPT_PATH", "SMOKE_CLAUDE_TRANSCRIPT_SHA256", "claude-code");
    await verifyTranscript("SMOKE_CODEX_TRANSCRIPT_PATH", "SMOKE_CODEX_TRANSCRIPT_SHA256", "codex");
    return { transcripts: 2 };
  });

  const primaryRun = await createSmokeRun(
    gatewayStore,
    tokenService,
    litellmUrl,
    adminToken,
    [openaiModel, anthropicModel, backgroundModel],
  );

  const tokenCountBody = { model: backgroundModel, messages: [{ role: "user", content: "synthetic token count" }] };

  await record("bearer_auth", async () => {
    const response = await gatewayRequest(baseUrl, "/v1/messages/count_tokens", primaryRun.token, tokenCountBody);
    if (!response.ok) throw new Error(`bearer auth returned ${response.status}`);
    return { status: response.status };
  });

  await record("x_api_key_auth", async () => {
    const response = await gatewayRequest(baseUrl, "/v1/messages/count_tokens", primaryRun.token, tokenCountBody, "x-api-key");
    if (!response.ok) throw new Error(`x-api-key auth returned ${response.status}`);
    return { status: response.status };
  });

  await record("claim_derived_run_id", async () => {
    const before = new Set((await callStore.listCalls(primaryRun.run.runId)).map((call) => call.callId));
    const response = await gatewayRequest(
      baseUrl,
      "/v1/messages/count_tokens",
      primaryRun.token,
      tokenCountBody,
      "bearer",
      { "x-run-id": "attacker-controlled-run" },
    );
    if (!response.ok) throw new Error(`claim-derived run probe returned ${response.status}`);
    const call = await latestNewCall(callStore, primaryRun.run.runId, before);
    if (call.runId !== primaryRun.run.runId) throw new Error("gateway trusted an external run id");
    return { status: response.status, persistedUnderSignedRun: true };
  });

  await record("main_background_model_allowlist", async () => {
    const background = await gatewayRequest(baseUrl, "/v1/messages/count_tokens", primaryRun.token, tokenCountBody);
    const denied = await gatewayRequest(baseUrl, "/v1/responses", primaryRun.token, {
      model: `not-allowed-${randomUUID()}`,
      input: "synthetic",
      max_output_tokens: 1,
    });
    if (!background.ok || denied.status !== 400) {
      throw new Error(`allowlist probe statuses background=${background.status} denied=${denied.status}`);
    }
    return { backgroundStatus: background.status, deniedStatus: denied.status };
  });

  await record("unknown_route_refusal", async () => {
    const response = await gatewayRequest(baseUrl, "/v1/unknown-smoke", primaryRun.token, {});
    if (response.status !== 404) throw new Error(`unknown route returned ${response.status}`);
    return { status: response.status };
  });

  await record("chat_completions_disabled", async () => {
    const response = await gatewayRequest(baseUrl, "/v1/chat/completions", primaryRun.token, {
      model: openaiModel,
      messages: [{ role: "user", content: "synthetic" }],
    });
    if (response.status !== 404) throw new Error(`chat completions returned ${response.status}`);
    return { status: response.status };
  });

  let zeroCostCall: HarnessCallRecord | undefined;
  await record("zero_cost_token_count", async () => {
    const { response, call } = await callAndRecord(
      baseUrl,
      callStore,
      primaryRun,
      "/v1/messages/count_tokens",
      tokenCountBody,
    );
    if (!response.ok || call.paid || call.listPriceCostUsd !== 0) {
      throw new Error("token-count call was not persisted as zero cost");
    }
    zeroCostCall = call;
    return { status: response.status, paid: call.paid, costUsd: call.listPriceCostUsd };
  });

  const syntheticCachePrefix = "cache-probe ".repeat(2_500);
  const openaiBody = {
    model: openaiModel,
    input: `${syntheticCachePrefix}\nReturn the word ok.`,
    max_output_tokens: 8,
  } as const;
  const anthropicBody = {
    model: anthropicModel,
    max_tokens: 8,
    system: [{ type: "text", text: syntheticCachePrefix, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "Return the word ok." }],
  } as const;

  const parityProbe = async (
    assertion: SmokeAssertionId,
    path: string,
    body: Readonly<Record<string, unknown>>,
    requireCached: boolean,
  ): Promise<HarnessCallRecord | undefined> => {
    let captured: HarnessCallRecord | undefined;
    await record(assertion, async () => {
      const { response, call } = await callAndRecord(baseUrl, callStore, primaryRun, path, body);
      if (!response.ok) throw new Error(`provider parity request returned ${response.status}`);
      const settled = await waitForSettledCall(callStore, primaryRun.run.runId, call.callId);
      const row = await waitForSpendRow(spendSource, primaryRun.run.upstreamCredential, call.callId);
      assertUsageParity(settled, row, requireCached);
      captured = settled;
      return {
        status: response.status,
        inputTokens: settled.usage.inputTokens,
        cachedInputTokens: settled.usage.cachedInputTokens,
        cacheWriteInputTokens: settled.usage.cacheWriteInputTokens,
        outputTokens: settled.usage.outputTokens,
      };
    });
    return captured;
  };

  const openaiUncached = await parityProbe(
    "token_parity_openai_uncached",
    "/v1/responses",
    openaiBody,
    false,
  );
  const openaiCached = await parityProbe(
    "token_parity_openai_cached",
    "/v1/responses",
    openaiBody,
    true,
  );
  const anthropicUncached = await parityProbe(
    "token_parity_anthropic_uncached",
    "/v1/messages",
    anthropicBody,
    false,
  );
  const anthropicCached = await parityProbe(
    "token_parity_anthropic_cached",
    "/v1/messages",
    anthropicBody,
    true,
  );

  let streamCall: HarnessCallRecord | undefined;
  await record("incremental_sse_through_caddy", async () => {
    const before = new Set((await callStore.listCalls(primaryRun.run.runId)).map((call) => call.callId));
    const response = await gatewayRequest(baseUrl, "/v1/responses", primaryRun.token, {
      model: openaiModel,
      input: "Count from one to four, one number per token.",
      max_output_tokens: 32,
      stream: true,
    });
    if (!response.ok || !response.body) throw new Error(`stream returned ${response.status}`);
    const reader = response.body.getReader();
    let chunks = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks += 1;
    }
    if (chunks < 2) throw new Error(`Caddy stream arrived in only ${chunks} chunk(s)`);
    const call = await latestNewCall(callStore, primaryRun.run.runId, before);
    streamCall = await waitForSettledCall(callStore, primaryRun.run.runId, call.callId);
    return { status: response.status, chunks };
  });

  await record("terminal_stream_usage", async () => {
    if (!streamCall || streamCall.state !== "completed" || streamCall.usage.outputTokens <= 0) {
      throw new Error("stream did not persist completed terminal usage");
    }
    return {
      state: streamCall.state,
      inputTokens: streamCall.usage.inputTokens,
      outputTokens: streamCall.usage.outputTokens,
    };
  });

  await record("delayed_spend_reconciliation", async () => {
    if (!streamCall || streamCall.costPending || streamCall.listPriceCostUsd === null) {
      throw new Error("stream cost did not reconcile from LiteLLM");
    }
    return { settled: true, costUsd: streamCall.listPriceCostUsd };
  });

  const controlledTimeouts = await runControlledTimeoutAssertions();
  for (const assertion of [
    "first_response_timeout",
    "stream_idle_timeout",
    "maximum_stream_duration",
    "non_streaming_timeout",
  ] as const) {
    await record(assertion, async () => {
      if (controlledTimeouts[assertion] !== true) throw new Error(`${assertion} controlled probe failed`);
      return { controlledFixture: true };
    });
  }

  await record("distinct_harness_call_ids", async () => {
    if (!openaiUncached || !openaiCached || openaiUncached.callId === openaiCached.callId) {
      throw new Error("repeated harness calls did not receive distinct call ids");
    }
    return { distinct: true };
  });

  await record("crash_rerun_spend_retained", async () => {
    if (!openaiUncached || !openaiCached) throw new Error("paid rerun probes were unavailable");
    const first = openaiUncached.listPriceCostUsd ?? 0;
    const second = openaiCached.listPriceCostUsd ?? 0;
    if (first <= 0 || second <= 0) throw new Error("both paid attempts must retain positive spend");
    return { paidAttempts: 2, aggregateCostUsd: first + second };
  });

  await record("intentional_reconciliation_mismatch", async () => {
    const target = anthropicUncached ?? openaiUncached;
    if (!target) throw new Error("no paid call available for mismatch probe");
    const original = await callStore.getCall(primaryRun.run.runId, target.callId);
    await callStore.saveCall({
      ...original,
      listPriceCostUsd: (original.listPriceCostUsd ?? 0) + 1,
      updatedAtMs: Date.now(),
    });
    const config = loadHarnessHttpConfig();
    const reconciler = new HarnessSpendReconciler({
      callStore,
      spendSource,
      timeoutMs: config.limits.reconciliationTimeoutMs,
      initialDelayMs: config.limits.reconciliationInitialDelayMs,
      maxDelayMs: config.limits.reconciliationMaxDelayMs,
      costToleranceUsd: config.limits.costToleranceUsd,
    });
    let failed = false;
    try {
      await reconciler.reconcileRun(primaryRun.run);
    } catch {
      failed = true;
    } finally {
      await callStore.saveCall(original);
    }
    if (!failed) throw new Error("intentional reconciliation mismatch did not fail");
    return { failedLoudly: true };
  });

  await record("per_run_spend_cap", async () => {
    const capRun = await createSmokeRun(
      gatewayStore,
      tokenService,
      litellmUrl,
      adminToken,
      [openaiModel],
      0.01,
    );
    await gatewayStore.saveStoredCall(capRun.run.runId, "preloaded-cap", {
      requestHash: "smoke-preloaded-cap",
      response: {},
      costRecord: {
        runId: capRun.run.runId,
        idempotencyKey: "preloaded-cap",
        provider: "openai",
        model: openaiModel,
        modelSettings: {},
        ...emptyUsage,
        latencyMs: 0,
        listPriceCostUsd: 0.01,
        createdAtMs: Date.now(),
      },
    });
    const response = await gatewayRequest(baseUrl, "/v1/responses", capRun.token, {
      model: openaiModel,
      input: "must not dispatch",
      max_output_tokens: 1,
    });
    const body = await responseJson(response);
    if (response.status !== 429 || errorCode(body) !== "spend_limit") {
      throw new Error(`spend-cap probe returned ${response.status}/${errorCode(body)}`);
    }
    return { status: response.status, code: "spend_limit" };
  });

  await record("spend_reserved_refusal_count", async () => {
    const reserveRun = await createSmokeRun(
      gatewayStore,
      tokenService,
      litellmUrl,
      adminToken,
      [openaiModel],
      0.000001,
    );
    const responses = await Promise.all([
      gatewayRequest(baseUrl, "/v1/responses", reserveRun.token, {
        model: openaiModel,
        input: "reservation probe",
        max_output_tokens: 128,
      }),
      gatewayRequest(baseUrl, "/v1/responses", reserveRun.token, {
        model: openaiModel,
        input: "reservation probe",
        max_output_tokens: 128,
      }),
    ]);
    let refusals = 0;
    for (const response of responses) {
      const body = await responseJson(response);
      if (response.status === 429 && errorCode(body) === "spend_reserved") refusals += 1;
    }
    if (refusals < 1) throw new Error("no spend_reserved refusal was observed");
    return { spendReservedRefusals: refusals };
  });

  await record("auth_before_body", async () => {
    const oversized = `{"model":"${openaiModel}","input":"${"x".repeat(8 * 1024 * 1024 + 1024)}"}`;
    const response = await gatewayRequest(baseUrl, "/v1/responses", null, oversized);
    if (response.status !== 401) throw new Error(`unauthenticated oversized request returned ${response.status}`);
    return { status: response.status };
  });

  await record("request_body_limit", async () => {
    const oversized = `{"model":"${openaiModel}","input":"${"x".repeat(8 * 1024 * 1024 + 1024)}"}`;
    const response = await gatewayRequest(baseUrl, "/v1/responses", primaryRun.token, oversized);
    if (response.status !== 413) throw new Error(`oversized authenticated request returned ${response.status}`);
    return { status: response.status };
  });

  await record("per_run_rate_limit", async () => {
    const rateRun = await createSmokeRun(
      gatewayStore,
      tokenService,
      litellmUrl,
      adminToken,
      [openaiModel],
    );
    const responses = await Promise.all(
      Array.from({ length: 21 }, async () =>
        await gatewayRequest(baseUrl, "/v1/unknown-rate-probe", rateRun.token, {}),
      ),
    );
    const limited = responses.filter((response) => response.status === 429).length;
    if (limited < 1) throw new Error("burst rate limit did not reject any request");
    return { rejected: limited };
  });

  if (zeroCostCall?.listPriceCostUsd !== 0 || anthropicCached === undefined) {
    // Keep both variables live so accidental removal of either smoke phase is a type-visible edit.
  }

  const missingAssertions = HTTP_GATEWAY_SMOKE_ASSERTIONS.filter(
    (assertion) => !evidence.some((row) => row.assertion === assertion),
  );
  for (const assertion of missingAssertions) {
    evidence.push({ assertion, ok: false, detail: { error: "assertion was not executed" } });
  }

  const path = await writeSmokeEvidence("http-gateway-live", evidence);
  const failed = evidence.filter((row) => !row.ok);
  console.log(`HTTP gateway live smoke evidence: ${path}; passed=${evidence.length - failed.length}; failed=${failed.length}`);
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "HTTP gateway live smoke failed");
  process.exitCode = 1;
});
