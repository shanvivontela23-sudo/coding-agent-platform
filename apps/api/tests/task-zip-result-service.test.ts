import { describe, expect, it, vi } from "vitest";
import { createTaskZipResultService, type TaskZipResultArtifact, type TaskZipResultDatabase, type TaskZipResultContext } from "../src/task-zip-result.js";
import type { ProjectStorage } from "../src/project-storage.js";

const session = { organizationId: "00000000-0000-4000-8000-000000000811", userId: "10000000-0000-4000-8000-000000000811", expiresAtMs: Date.now() + 60_000 };
const artifact: TaskZipResultArtifact = { executionId: "50000000-0000-4000-8000-000000000811", taskId: "40000000-0000-4000-8000-000000000811", projectId: "20000000-0000-4000-8000-000000000811", sourceVersionId: "60000000-0000-4000-8000-000000000811", artifactVersionId: "70000000-0000-4000-8000-000000000811", storageKey: "result.zip", sha256: "a".repeat(64), sizeBytes: 10, fileCount: 2, promotedVersionId: null, promotedVersionNumber: null };
function context(role: "owner" | "developer" | "rep"): TaskZipResultContext { return { executionId: artifact.executionId, taskId: artifact.taskId, projectId: artifact.projectId, status: "fix_not_reproduced", sourceVersionId: artifact.sourceVersionId, sourceStorageKey: "source.zip", resultPatch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n", changeDocument: "note", verifiedFiles: [{ path: "a.txt", blobSha: "b".repeat(40), mode: "100644", deleted: false }], role }; }
function service(role: "owner" | "developer" | "rep", existing: TaskZipResultArtifact | null = artifact) {
  const db: TaskZipResultDatabase = { getContext: vi.fn(async () => context(role)), getArtifact: vi.fn(async () => existing), saveArtifact: vi.fn(async (_session, input) => input), promote: vi.fn(async (_session, input) => ({ ...input, promotedVersionId: input.artifactVersionId, promotedVersionNumber: 2 })), auditDownload: vi.fn(async () => undefined) };
  const storage = { readVersion: vi.fn(async () => new Uint8Array()), writeVersion: vi.fn(), deleteProject: vi.fn() } as unknown as ProjectStorage;
  return { api: createTaskZipResultService({ database: db, storage, downloadTokens: { issue: () => "signed", verify: () => ({ organizationId: session.organizationId, userId: session.userId, projectId: artifact.projectId, projectVersionId: artifact.artifactVersionId }) } as never, limits: { maxCompressedBytes: 1024, maxUncompressedBytes: 2048, maxFiles: 20, maxFileBytes: 1024, maxNestedArchiveDepth: 1 } }), db };
}

describe("B4 ZIP result service", () => {
  it("does not expose fix_not_reproduced until a developer or owner explicitly accepts it", async () => {
    const developer = service("developer");
    await expect(developer.api.getOrCreate(session, artifact.taskId)).resolves.toBe(artifact);
    // Existing artifact means acceptance already happened; a fresh unproven execution remains hidden.
    const fresh = service("developer", null);
    await expect(fresh.api.getOrCreate(session, artifact.taskId)).resolves.toBeNull();
  });

  it("refuses a rep attempting to accept an unproven ZIP result", async () => {
    const rep = service("rep", null);
    await expect(rep.api.acceptUnproven(session, artifact.taskId)).rejects.toMatchObject({ code: "ZIP_UNPROVEN_ACCEPT_FORBIDDEN" });
  });

  it("allows a developer to promote an existing ZIP result without rebuilding it", async () => {
    const developer = service("developer");
    const promoted = await developer.api.promote(session, artifact.taskId);
    expect(promoted.promotedVersionNumber).toBe(2);
    expect(developer.db.promote).toHaveBeenCalledTimes(1);
  });
});
