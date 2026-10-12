import { describe, expect, it, vi } from "vitest";
import { createTaskZipResultService, type TaskZipResultDatabase } from "../src/task-zip-result.js";
import type { ProjectStorage } from "../src/project-storage.js";

const session = {
  organizationId: "00000000-0000-4000-8000-000000000911",
  userId: "10000000-0000-4000-8000-000000000911",
  expiresAtMs: Date.now() + 60_000,
};

describe("ZIP result polling", () => {
  it("keeps ten concurrent reads storage-write free", async () => {
    const writeVersion = vi.fn();
    const insertArtifact = vi.fn(async () => { throw new Error("must not save during GET"); });
    const database: TaskZipResultDatabase = {
      getStatus: vi.fn(async () => ({ status: "pending", errorCode: null, errorMessage: null, artifact: null })),
      getContext: vi.fn(async () => null),
      getArtifact: vi.fn(async () => null),
      insertArtifact,
      acceptUnproven: vi.fn(async () => null),
      retryBuild: vi.fn(async () => null),
      markReady: vi.fn(async () => false),
      markFailed: vi.fn(async () => false),
      promote: vi.fn(async () => { throw new Error("not used"); }),
      auditDownload: vi.fn(async () => undefined),
    };
    const storage = { readVersion: vi.fn(), writeVersion, deleteVersion: vi.fn(), deleteProject: vi.fn() } as unknown as ProjectStorage;
    const service = createTaskZipResultService({ database, storage, downloadTokens: {} as never, limits: { maxCompressedBytes: 1024, maxUncompressedBytes: 2048, maxFiles: 20, maxFileBytes: 1024, maxNestedArchiveDepth: 1 } });

    const results = await Promise.all(Array.from({ length: 10 }, () => service.readStatus(session, "40000000-0000-4000-8000-000000000911")));

    expect(results).toHaveLength(10);
    expect(writeVersion).not.toHaveBeenCalled();
    expect(insertArtifact).not.toHaveBeenCalled();
  });
});
