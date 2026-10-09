import { describe, expect, it } from "vitest";
import { FakeCodingRunner } from "../src/fake-coding-runner.js";
import type { ClaimedExecution, ExecutionControlState, ExecutionQueue } from "../src/postgres-execution-queue.js";
import { runExecutionWorkerOnce } from "../src/task-execution-worker.js";

const claimed: ClaimedExecution = {
  executionId: "50000000-0000-4000-8000-000000000121",
  organizationId: "00000000-0000-4000-8000-000000000121",
  taskId: "40000000-0000-4000-8000-000000000121",
  projectId: "20000000-0000-4000-8000-000000000121",
  attempt: 1,
  sourceCommitSha: "a".repeat(40),
  sourceVersionId: null,
  budgetUsd: 1,
  timeoutSeconds: 30,
};

class FakeQueue implements ExecutionQueue {
  finished: string[] = [];
  constructor(private readonly item: ClaimedExecution | null, private readonly controls: ExecutionControlState[] = ["running"]) {}
  async claim() { return this.item; }
  async heartbeat() { return this.controls.shift() ?? "running"; }
  async finish(_executionId: string, _workerId: string, status: "succeeded" | "failed") { this.finished.push(status); return status; }
}

describe("task execution worker", () => {
  it("does nothing when no execution is claimable", async () => {
    const result = await runExecutionWorkerOnce({ queue: new FakeQueue(null), runner: new FakeCodingRunner(), workerId: "worker-1" });
    expect(result).toEqual({ worked: false });
  });

  it("finishes a fake runner success on the same execution", async () => {
    const queue = new FakeQueue(claimed);
    const result = await runExecutionWorkerOnce({ queue, runner: new FakeCodingRunner(), workerId: "worker-1" });
    expect(result).toEqual({ worked: true, executionId: claimed.executionId, status: "succeeded" });
    expect(queue.finished).toEqual(["succeeded"]);
  });

  it("records runner failure without an automatic rerun", async () => {
    const queue = new FakeQueue(claimed);
    const result = await runExecutionWorkerOnce({ queue, runner: new FakeCodingRunner({ fail: true }), workerId: "worker-1" });
    expect(result.status).toBe("failed");
    expect(queue.finished).toEqual(["failed"]);
  });

  it.each(["cancelled", "timed_out"] as const)("lets %s beat a late runner success", async (control) => {
    const queue = new FakeQueue(claimed, [control]);
    const result = await runExecutionWorkerOnce({ queue, runner: new FakeCodingRunner(), workerId: "worker-1" });
    expect(result.status).toBe(control);
    expect(queue.finished).toEqual([]);
  });
});
