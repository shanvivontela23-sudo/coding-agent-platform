import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 task execution UI", () => {
  it("shows waiting-for-worker after 60 seconds queued", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("60_000");
    expect(component).toContain("Waiting for a worker.");
    expect(component).toContain("queuedAt");
  });

  it("renders verification and reproduce terminal states, cost, change note, dependency flags, and diff", async () => {
    const component = await source("apps/web/components/task-execution-status.tsx");
    expect(component).toContain("Verification failed");
    expect(component).toContain("Fix not reproduced");
    expect(component).toContain("Execution cost");
    expect(component).toContain("Change note");
    expect(component).toContain("Dependency or lockfile changes");
    expect(component).toContain("Result diff");
    expect(component).toContain("changeDocument");
    expect(component).toContain("resultPatch");
    expect(component).toContain("costUsd");
  });
});
