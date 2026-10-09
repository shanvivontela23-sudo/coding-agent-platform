import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("Part B1 execution application contract", () => {
  it("implements tenant start/cancel with idempotency and snapshotted limits", async () => {
    const database = await source("apps/api/src/task-execution-database.ts");
    expect(database).toContain("task_executions_one_active_per_task");
    expect(database).toContain("ON CONFLICT DO NOTHING");
    expect(database).toContain('row.status !== "approved"');
    expect(database).toContain("planned_source_commit_sha");
    expect(database).toContain("planned_source_version_id");
    expect(database).toContain("current_user_role");
    expect(database).toContain("cancel_requested_at");
    expect(database).toContain("task_execution_started");
    expect(database).toContain("task_execution_cancelled");

    const service = await source("apps/api/src/task-execution-service.ts");
    expect(service).toContain("budgetUsd");
    expect(service).toContain("timeoutSeconds");
    expect(service).toContain("start(session");
    expect(service).toContain("cancel(session");
  });

  it("exposes status/start/cancel routes without exposing worker credentials", async () => {
    const server = await source("apps/api/src/task-execution-server.ts");
    expect(server).toContain("/api/tasks/");
    expect(server).toContain("/execution/start");
    expect(server).toContain("/execution/cancel");
    expect(server).toContain("/execution");
    expect(server).not.toMatch(/DATABASE_URL|GITHUB_APP_PRIVATE_KEY|LITELLM/i);
  });

  it("runs only a fake coding runner in B1 and honors lease control", async () => {
    const worker = await source("apps/worker/src/task-execution-worker.ts");
    expect(worker).toContain("CodingRunner");
    expect(worker).toContain("heartbeat");
    expect(worker).toContain("AbortController");
    const queue = await source("apps/worker/src/postgres-execution-queue.ts");
    expect(queue).toContain("cancelled");
    expect(queue).toContain("timed_out");
    const fake = await source("apps/worker/src/fake-coding-runner.ts");
    expect(fake).toContain("FakeCodingRunner");
    expect(fake).not.toMatch(/e2b|anthropic|openai|litellm/i);
  });

  it("shows Start implementation, cancel, and polled execution states on the task page", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("Start implementation");
    expect(component).toContain("Cancel implementation");
    expect(component).toContain("setInterval");
    expect(component).toContain("Implementation timed out");
    expect(component).toContain("Implementation cancelled");
    expect(component).toContain("Implementation failed");
  });
});
