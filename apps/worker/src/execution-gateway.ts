import { FileGatewayStore, RunTokenService, type GatewayRunRecord } from "../../../evals/src/gateway/index.js";
import { FileHarnessCallStore, HarnessSpendReconciler, LiteLLMSpendClient, loadHarnessHttpConfig } from "../../../evals/src/gateway/http/index.js";

export type ExecutionGatewaySession = {
  readonly gatewayUrl: string;
  readonly runToken: string;
  readonly model: string;
  readCostUsd(): Promise<number>;
  finish(): Promise<void>;
};

export interface ExecutionGatewayControl {
  open(input: { readonly executionId: string; readonly budgetUsd: number; readonly timeoutSeconds: number }): Promise<ExecutionGatewaySession>;
}

async function responseObject(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("LiteLLM key generation response was invalid");
  return value as Record<string, unknown>;
}

export class FileBackedExecutionGatewayControl implements ExecutionGatewayControl {
  private readonly gatewayStore: FileGatewayStore;
  private readonly callStore: FileHarnessCallStore;
  private readonly tokenService: RunTokenService;
  private readonly spendSource: LiteLLMSpendClient;
  private readonly reconciler: HarnessSpendReconciler;
  constructor(private readonly options: {
    readonly gatewayUrl: string;
    readonly model: string;
    readonly runTokenSecret: string;
    readonly gatewayStoreDir: string;
    readonly harnessCallStoreDir: string;
    readonly litellmGatewayUrl: string;
    readonly litellmAdminToken: string;
    readonly fetchImpl?: typeof fetch;
    readonly nowMs?: () => number;
  }) {
    this.gatewayStore = new FileGatewayStore({ rootDir: options.gatewayStoreDir });
    this.callStore = new FileHarnessCallStore({ rootDir: options.harnessCallStoreDir });
    this.tokenService = new RunTokenService({ secret: options.runTokenSecret, ...(options.nowMs ? { clock: options.nowMs } : {}) });
    this.spendSource = new LiteLLMSpendClient({ baseUrl: options.litellmGatewayUrl, adminToken: options.litellmAdminToken, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    const config = loadHarnessHttpConfig();
    this.reconciler = new HarnessSpendReconciler({
      callStore: this.callStore,
      spendSource: this.spendSource,
      timeoutMs: config.limits.reconciliationTimeoutMs,
      initialDelayMs: config.limits.reconciliationInitialDelayMs,
      maxDelayMs: config.limits.reconciliationMaxDelayMs,
      costToleranceUsd: config.limits.costToleranceUsd,
      ...(options.nowMs ? { clock: options.nowMs } : {}),
    });
  }

  async open(input: { readonly executionId: string; readonly budgetUsd: number; readonly timeoutSeconds: number }): Promise<ExecutionGatewaySession> {
    if (!Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) throw new Error("execution budget must be positive");
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0) throw new Error("execution timeout must be positive");
    const now = (this.options.nowMs ?? Date.now)();
    const expiresAtMs = now + input.timeoutSeconds * 1_000;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.litellmGatewayUrl.replace(/\/$/, "");
    const keyResponse = await fetchImpl(`${base}/key/generate`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.litellmAdminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ max_budget: input.budgetUsd, duration: `${input.timeoutSeconds}s`, metadata: { run_id: input.executionId } }),
    });
    if (!keyResponse.ok) throw new Error(`LiteLLM run key generation failed with status ${keyResponse.status}`);
    const body = await responseObject(keyResponse);
    if (typeof body.key !== "string" || !body.key) throw new Error("LiteLLM run key generation response did not contain a key");
    const run: GatewayRunRecord = {
      runId: input.executionId,
      expiresAtMs,
      spendCapUsd: input.budgetUsd,
      upstreamCredential: body.key,
      allowedModels: [this.options.model],
      status: "active",
    };
    await this.gatewayStore.createRun(run);
    const token = this.tokenService.issue(input.executionId, expiresAtMs);
    let finished = false;
    return {
      gatewayUrl: this.options.gatewayUrl,
      runToken: token,
      model: this.options.model,
      readCostUsd: async () => (await this.reconciler.reconcileRun(await this.gatewayStore.getRun(input.executionId))).totalCostUsd,
      finish: async () => {
        if (finished) return;
        finished = true;
        const current = await this.gatewayStore.getRun(input.executionId);
        await this.gatewayStore.saveRun({ ...current, status: current.status === "active" ? "completed" : current.status });
      },
    };
  }
}
