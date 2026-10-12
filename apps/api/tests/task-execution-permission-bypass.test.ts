import { describe, expect, it, vi } from "vitest";
import type { TaskExecutionDatabase, TaskExecutionRecord } from "../src/task-execution-database.js";
import { createTaskExecutionService } from "../src/task-execution-service.js";

const session = { userId: "10000000-0000-4000-8000-000000000761", organizationId: "00000000-0000-4000-8000-000000000761", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000761";
const execution = { id: "50000000-0000-4000-8000-000000000761" } as TaskExecutionRecord;

describe("execution permission cache use", () => {
  it("uses cache for status readiness and bypasses it at Start", async () => {
    const database: TaskExecutionDatabase = {
      async getLatest() { return null; },
      async start() { return { execution, created: true }; },
      async cancel() { return execution; },
    };
    const readinessReader = { get: vi.fn(async () => ({ reportHasInstallCommand: true, githubInstallationId: 777 })) };
    const githubApp = { getInstallationPermissions: vi.fn(async () => ({ contents: "write" as const })) };
    const service = createTaskExecutionService({ database, readinessReader, githubApp, budgetUsd: 1, timeoutSeconds: 600 });

    await service.readiness(session, taskId);
    await service.readiness(session, taskId);
    expect(githubApp.getInstallationPermissions).toHaveBeenNthCalledWith(1, 777, { bypassCache: false });
    expect(githubApp.getInstallationPermissions).toHaveBeenNthCalledWith(2, 777, { bypassCache: false });

    await service.start(session, taskId);
    expect(githubApp.getInstallationPermissions).toHaveBeenNthCalledWith(3, 777, { bypassCache: true });
  });
});
