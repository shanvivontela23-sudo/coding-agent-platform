import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Product 07 task model local configuration", () => {
  it("defaults task planning to Anthropic and documents the exact paid local path", async () => {
    const main = await readFile("apps/api/src/main.ts", "utf8");
    expect(main).toContain('TASK_MODEL_PROVIDER?.trim() || "anthropic"');
    const readme = await readFile("README.md", "utf8");
    for (const value of [
      "compose.local.yaml",
      "TASK_MODEL_GATEWAY_BASE_URL=http://127.0.0.1:4000",
      "TASK_MODEL_GATEWAY_ADMIN_TOKEN",
      "TASK_MODEL_PROVIDER=anthropic",
      "TASK_MODEL_NAME=anthropic/",
      "ANTHROPIC_API_KEY",
      "paid model calls",
    ]) expect(readme).toContain(value);
  });
});
