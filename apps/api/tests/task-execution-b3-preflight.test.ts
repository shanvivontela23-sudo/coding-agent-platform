import { describe, expect, it, vi } from "vitest";
import { createTaskExecutionService } from "../src/task-execution-service.js";

const session = { userId: "10000000-0000-4000-8000-000000000401", organizationId: "00000000-0000-4000-8000-000000000401", expiresAtMs: Date.now() + 60_000 };
const taskId = "40000000-0000-4000-8000-000000000401";
const execution = { id: "50000000-0000-4000-8000-000000000401", taskId, projectId: "20000000-0000-4000-8000-000000000401", attempt: 1, status: "queued" };

function database(readiness: { reportHasInstallCommand: boolean; githubInstallationId: number | null }) {
  const start = vi.fn(async () => ({ execution, created: true }));
  return {
    getLatest: async () => null,
    cancel: async () => execution,
    start,
    getStartReadiness: async () => readiness,
  } as any;
}

function github(contents: "read" | "write") {
  return { getInstallationPermissions: vi.fn(async () => ({ contents })) } as any;
}

describe("B3 execution start preflight", () => {
  it("blocks a legacy project report before an execution is queued", async () => {
    const db = database({ reportHasInstallCommand: false, githubInstallationId: null });
    const service = createTaskExecutionService({ database: db, githubApp: github("write"), budgetUsd: 1, timeoutSeconds: 600 });

    await expect(service.start(session, taskId)).rejects.toMatchObject({
      publicMessage: "Re-analyse this project before implementation",
    });
    expect(db.start).not.toHaveBeenCalled();
  });

  it("blocks GitHub Start before spend when Contents write is missing", async () => {
    const db = database({ reportHasInstallCommand: true, githubInstallationId: 777 });
    const service = createTaskExecutionService({ database: db, githubApp: github("read"), budgetUsd: 1, timeoutSeconds: 600 });

    await expect(service.start(session, taskId)).rejects.toMatchObject({
      publicMessage: expect.stringContaining("Contents: Read and write"),
    });
    expect(db.start).not.toHaveBeenCalled();
  });

  it("does not confuse a current report with explicit installCommand null for a legacy report", async () => {
    const db = database({ reportHasInstallCommand: true, githubInstallationId: null });
    const service = createTaskExecutionService({ database: db, githubApp: github("read"), budgetUsd: 1, timeoutSeconds: 600 });

    await expect(service.start(session, taskId)).resolves.toMatchObject({ created: true });
    expect(db.start).toHaveBeenCalledTimes(1);
  });
});
