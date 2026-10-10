import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileGatewayStore, RunTokenService } from "../../../evals/src/gateway/index.js";
import { FileBackedExecutionGatewayControl } from "../src/execution-gateway.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("execution gateway control", () => {
  it("creates a short-lived run token and LiteLLM key capped at the execution budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-gateway-"));
    roots.push(root);
    const gatewayStoreDir = join(root, "runs");
    const harnessCallStoreDir = join(root, "calls");
    const nowMs = 1_800_000_000_000;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { max_budget: number; duration: string; metadata: { run_id: string } };
      expect(body).toEqual({ max_budget: 1.25, duration: "120s", metadata: { run_id: "execution-123" } });
      return new Response(JSON.stringify({ key: "temporary-litellm-key" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const secret = "s".repeat(32);
    const control = new FileBackedExecutionGatewayControl({
      gatewayUrl: "http://gateway.local",
      model: "test-model",
      runTokenSecret: secret,
      gatewayStoreDir,
      harnessCallStoreDir,
      litellmGatewayUrl: "http://litellm.local",
      litellmAdminToken: "admin",
      fetchImpl,
      nowMs: () => nowMs,
    });

    const session = await control.open({ executionId: "execution-123", budgetUsd: 1.25, timeoutSeconds: 120 });
    const stored = await new FileGatewayStore({ rootDir: gatewayStoreDir }).getRun("execution-123");
    expect(stored).toMatchObject({ runId: "execution-123", spendCapUsd: 1.25, expiresAtMs: nowMs + 120_000, upstreamCredential: "temporary-litellm-key", allowedModels: ["test-model"], status: "active" });
    expect(new RunTokenService({ secret, clock: () => nowMs }).verify(session.runToken)).toMatchObject({ runId: "execution-123", expiresAtMs: nowMs + 120_000 });
    await session.finish();
    expect((await new FileGatewayStore({ rootDir: gatewayStoreDir }).getRun("execution-123")).status).toBe("completed");
  });
});
