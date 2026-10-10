import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 owner-run live smoke", () => {
  it("requires explicit paid acknowledgements and claims a queued execution through the real worker composition", async () => {
    const smoke = await text("scripts/b2-live-smoke.ts");
    for (const value of [
      "B2_LIVE_SMOKE",
      "B2_LIVE_PAID_ACK",
      "I_UNDERSTAND_PAID_MODEL_AND_E2B_CHARGES",
      "loadRealWorkerConfig",
      "createRealProductExecutionRunner",
      "PostgresExecutionQueue",
      "runExecutionWorkerOnce",
      "coding_agent_worker",
    ]) expect(smoke).toContain(value);
    for (const removed of [
      "B2_LIVE_SOURCE_ARCHIVE",
      "B2_LIVE_PINNED_COMMIT",
      "B2_LIVE_GATEWAY_URL",
      "B2_LIVE_RUN_TOKEN",
      "B2_LIVE_REQUIREMENT",
      "B2_LIVE_PLAN",
    ]) expect(smoke).not.toContain(removed);
  });

  it("is not part of normal test or CI scripts", async () => {
    const root = JSON.parse(await text("package.json")) as { scripts?: Record<string, string> };
    for (const command of Object.values(root.scripts ?? {})) expect(command).not.toContain("b2-live-smoke");
  });
});
