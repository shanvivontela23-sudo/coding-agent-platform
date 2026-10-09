import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 owner-run live smoke", () => {
  it("requires explicit live and paid acknowledgements and real contract inputs", async () => {
    const smoke = await text("scripts/b2-live-smoke.ts");
    for (const value of [
      "B2_LIVE_SMOKE",
      "B2_LIVE_PAID_ACK",
      "I_UNDERSTAND_PAID_MODEL_AND_E2B_CHARGES",
      "B2_LIVE_SOURCE_ARCHIVE",
      "B2_LIVE_PINNED_COMMIT",
      "B2_LIVE_GATEWAY_URL",
      "B2_LIVE_RUN_TOKEN",
      "B2_LIVE_MODEL",
      "E2B_API_KEY",
      "ProductCodingRunner",
      "E2BSandboxProvider",
      "CodexHarnessRunner",
      "verifyExecution",
      "inspectPatchSafety",
    ]) expect(smoke).toContain(value);
  });

  it("is not part of normal test or CI scripts", async () => {
    const root = JSON.parse(await text("package.json")) as { scripts?: Record<string, string> };
    for (const command of Object.values(root.scripts ?? {})) expect(command).not.toContain("b2-live-smoke");
  });
});
