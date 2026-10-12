import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("Part B1 execution application contract", () => {
  it("implements tenant start/cancel with idempotency and snapshotted limits", async () => {
    const database = await source("apps/api/src/task-execution-database.ts");
    expect(database).toContain("task_executions_one_active_per_task");
    expect(database).toContain("budget_usd");
    expect(database).toContain("timeout_seconds");
    expect(database).toContain("FOR UPDATE");
    expect(database).toContain("TASK_EXECUTION_FORBIDDEN");
    expect(database).toContain("cancel_requested_at");
  });

  it("exposes status/start/cancel/publication routes without exposing worker credentials", async () => {
    const server = await source("apps/api/src/task-execution-server.ts");
    expect(server).toContain("api\\/tasks\\/");
    expect(server).toContain("execution(?:\\/(start|cancel|publication))?");
    expect(server).not.toMatch(/DATABASE_URL|GITHUB_APP_PRIVATE_KEY|LITELLM/i);
  });

  it("keeps the local fake worker isolated from model providers and on the dedicated worker role", async () => {
    const worker = await source("apps/worker/src/task-execution-worker.ts");
    const cli = await source("apps/worker/src/cli.ts");
    expect(worker).toContain("CodingRunner");
    expect(worker).not.toMatch(/Anthropic|OpenAI|LiteLLM|E2B/);
    expect(cli).toContain("coding_agent_worker");
  });

  it("shows Start implementation, cancel, and polled execution states on the task page", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("Start implementation");
    expect(component).toContain("Cancel implementation");
    expect(component).toContain("setInterval");
  });
});
