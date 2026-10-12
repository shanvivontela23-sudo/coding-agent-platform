import { createHash, randomUUID } from "node:crypto";
import { buildVerifiedZipResult } from "../../api/src/task-zip-result.js";
import type { ProjectStorage } from "../../api/src/project-storage.js";
import type { UploadArchiveLimits } from "../../api/src/upload-archive.js";
import type { VerifiedFile } from "./verification.js";
import type { ZipResultBuildJob } from "./zip-result-build-worker.js";
import type { ZipResultCompletion } from "./postgres-zip-result-build-queue.js";

export interface ZipResultArtifactStore {
  complete(input: { readonly executionId: string; readonly artifactId: string; readonly storageKey: string; readonly sha256: string; readonly sizeBytes: number; readonly fileCount: number }): Promise<ZipResultCompletion>;
}

type CleanupStorage = ProjectStorage & { deleteVersion?(storageKey: string): Promise<void> };

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function verifiedFiles(metadata: Readonly<Record<string, unknown>>): readonly VerifiedFile[] {
  const value = metadata.verifiedFiles;
  if (!Array.isArray(value)) throw new Error("Verified file evidence is missing; ZIP result refused.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Verified file evidence is invalid; ZIP result refused.");
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || typeof row.deleted !== "boolean") throw new Error("Verified file evidence is invalid; ZIP result refused.");
    const blobSha = row.blobSha === null ? null : typeof row.blobSha === "string" ? row.blobSha : null;
    const mode = row.mode === null ? null : row.mode === "100644" || row.mode === "100755" ? row.mode : null;
    return { path: row.path, blobSha, mode, deleted: row.deleted };
  });
}
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`${label} is unavailable`); return value; }

export function createZipResultBuilder(options: { readonly storage: CleanupStorage; readonly artifacts: ZipResultArtifactStore; readonly limits: UploadArchiveLimits }) {
  return async (job: ZipResultBuildJob): Promise<void> => {
    const sourceStorageKey = required(job.sourceStorageKey, "approved ZIP storage key");
    const sourceSha256 = required(job.sourceSha256, "approved ZIP digest");
    const patch = required(job.resultPatch, "result patch");
    const changeDocument = required(job.changeDocument, "change note");
    const metadata = job.resultMetadata ?? {};
    const approvedZip = await options.storage.readVersion(sourceStorageKey);
    if (sha256(approvedZip) !== sourceSha256.toLowerCase()) throw new Error("Stored approved ZIP digest does not match the approved project version; ZIP result refused.");
    const built = await buildVerifiedZipResult({ approvedZip, patch, verifiedFiles: verifiedFiles(metadata), changeDocument, limits: options.limits });
    const artifactId = randomUUID();
    const stored = await options.storage.writeVersion({ organizationId: job.organizationId, projectId: job.projectId, versionId: artifactId, bytes: built.bytes });
    try {
      const completion = await options.artifacts.complete({ executionId: job.executionId, artifactId, storageKey: stored.storageKey, sha256: built.sha256, sizeBytes: built.sizeBytes, fileCount: built.fileCount });
      if (completion !== "inserted") {
        if (!options.storage.deleteVersion) throw new Error("ZIP result artifact was not adopted but storage cleanup is unavailable.");
        await options.storage.deleteVersion(stored.storageKey);
        if (completion === "lost") throw new Error("ZIP result build ownership was lost before completion.");
      }
    } catch (error) {
      if (options.storage.deleteVersion) await options.storage.deleteVersion(stored.storageKey).catch(() => undefined);
      throw error;
    }
  };
}
