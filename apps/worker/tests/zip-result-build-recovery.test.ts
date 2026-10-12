import { describe, expect, it, vi } from "vitest";
import { runZipResultBuildWorkerOnce, type ZipResultBuildJob, type ZipResultBuildQueue } from "../src/zip-result-build-worker.js";

const job: ZipResultBuildJob = {
  executionId: "50000000-0000-4000-8000-000000000921",
  organizationId: "00000000-0000-4000-8000-000000000921",
  taskId: "40000000-0000-4000-8000-000000000921",
  projectId: "20000000-0000-4000-8000-000000000921",
  sourceVersionId: "60000000-0000-4000-8000-000000000921",
};

function queue(overrides: Partial<ZipResultBuildQueue> = {}): ZipResultBuildQueue {
  return {
    claimPending: vi.fn(async () => job),
    markReady: vi.fn(async () => true),
    markFailed: vi.fn(async () => true),
    ...overrides,
  };
}

describe("ZIP result build worker", () => {
  it("attempts a failing build exactly once and never retries it on the next poll", async () => {
    const build = vi.fn(async () => { throw new Error("registry token=super-secret build exploded"); });
    const q = queue({ claimPending: vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(null) });

    await runZipResultBuildWorkerOnce({ queue: q, build });
    await runZipResultBuildWorkerOnce({ queue: q, build });

    expect(build).toHaveBeenCalledTimes(1);
    expect(q.markFailed).toHaveBeenCalledTimes(1);
    expect(q.markFailed).toHaveBeenCalledWith(job.executionId, "ZIP_RESULT_FAILED", expect.not.stringContaining("super-secret"));
  });

  it("builds a recovered pending execution exactly once after a worker restart", async () => {
    const build = vi.fn(async () => undefined);
    const q = queue({ claimPending: vi.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(null) });

    await runZipResultBuildWorkerOnce({ queue: q, build });
    await runZipResultBuildWorkerOnce({ queue: q, build });

    expect(build).toHaveBeenCalledTimes(1);
    expect(q.markReady).toHaveBeenCalledTimes(1);
  });
});
