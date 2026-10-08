import { describe, expect, it } from "vitest";
import { RunTokenService } from "../../../evals/src/gateway/run-token.js";
import type { ModelGateway } from "../../../evals/src/gateway/types.js";
import { ExistingGatewayTaskModelGateway } from "../src/task-intake.js";

const emptySummary = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningTokens: 0, modelCostUsd: 0 } as const;

describe("task gateway restart recovery", () => {
  it("reissues a signed token for the existing persisted task run without starting a second run", async () => {
    const tokenService = new RunTokenService({ secret: "test-run-token-secret-that-is-long-enough-12345" });
    let starts = 0;
    let seenRunId = "";
    const gateway: ModelGateway = {
      async startRun() { starts += 1; throw new Error("must not start a second run"); },
      async call(token, request) {
        tokenService.verify(token, request.runId);
        seenRunId = request.runId;
        return {
          body: { choices: [{ message: { content: JSON.stringify({ ok: true }) } }] },
          replayed: false,
          costRecord: {
            runId: request.runId,
            idempotencyKey: request.idempotencyKey,
            provider: request.provider,
            model: request.model,
            modelSettings: request.modelSettings,
            inputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 1,
            reasoningTokens: 0,
            latencyMs: 1,
            listPriceCostUsd: 0.01,
            createdAtMs: Date.now(),
          },
        };
      },
      async finishRun() {},
      async getRunCostSummary() { return emptySummary; },
    };
    const adapter = new ExistingGatewayTaskModelGateway({ gateway, tokenService, provider: "fake", model: "fake-model", runDurationMs: 60_000 });

    await expect(adapter.call("task-123", "plan", [{ role: "user", content: "untrusted" }])).resolves.toEqual({ ok: true });
    expect(seenRunId).toBe("task:task-123");
    expect(starts).toBe(0);
  });
});
