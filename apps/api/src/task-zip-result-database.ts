import type { SessionIdentity } from "./auth.js";
import { assertUuid, type TenantPool, withTenant } from "./database.js";
import { AppError } from "./errors.js";
import type { VerifiedFile } from "../../worker/src/verification.js";
import type { TaskZipResultArtifact, TaskZipResultContext, TaskZipResultDatabase } from "./task-zip-result.js";

type ContextRow = {
  execution_id: string; task_id: string; project_id: string; status: "succeeded" | "fix_not_reproduced"; source_version_id: string;
  source_storage_key: string; result_patch: string; change_document: string; result_metadata: Record<string, unknown>; role: "owner" | "developer" | "rep";
};
type ArtifactRow = { execution_id: string; task_id: string; project_id: string; storage_key: string; sha256: string; size_bytes: string | number; metadata: Record<string, unknown> };

function verifiedFiles(metadata: Record<string, unknown>): readonly VerifiedFile[] {
  const value = metadata.verifiedFiles;
  if (!Array.isArray(value)) throw new AppError("PUBLISHED_CONTENT_MISMATCH", "Verified file evidence is missing; ZIP result refused.", 409);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new AppError("PUBLISHED_CONTENT_MISMATCH", "Verified file evidence is invalid; ZIP result refused.", 409);
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || typeof row.deleted !== "boolean") throw new AppError("PUBLISHED_CONTENT_MISMATCH", "Verified file evidence is invalid; ZIP result refused.", 409);
    const blobSha = row.blobSha === null ? null : typeof row.blobSha === "string" ? row.blobSha : null;
    const mode = row.mode === null ? null : row.mode === "100644" || row.mode === "100755" ? row.mode : null;
    return { path: row.path, blobSha, mode, deleted: row.deleted };
  });
}
function artifact(row: ArtifactRow): TaskZipResultArtifact {
  const metadata = row.metadata ?? {};
  const sourceVersionId = typeof metadata.sourceVersionId === "string" ? metadata.sourceVersionId : "";
  const artifactVersionId = typeof metadata.artifactVersionId === "string" ? metadata.artifactVersionId : "";
  const fileCount = typeof metadata.fileCount === "number" && Number.isSafeInteger(metadata.fileCount) ? metadata.fileCount : 0;
  const promotedVersionId = typeof metadata.promotedVersionId === "string" ? metadata.promotedVersionId : null;
  const promotedVersionNumber = typeof metadata.promotedVersionNumber === "number" && Number.isSafeInteger(metadata.promotedVersionNumber) ? metadata.promotedVersionNumber : null;
  if (!sourceVersionId || !artifactVersionId || fileCount < 1) throw new Error("ZIP result artifact metadata is invalid");
  return { executionId: row.execution_id, taskId: row.task_id, projectId: row.project_id, sourceVersionId, artifactVersionId, storageKey: row.storage_key, sha256: row.sha256, sizeBytes: Number(row.size_bytes), fileCount, promotedVersionId, promotedVersionNumber };
}
const artifactSelect = `SELECT execution_id,task_id,(SELECT project_id FROM task_executions e WHERE e.organization_id=a.organization_id AND e.id=a.execution_id) AS project_id,storage_key,sha256,size_bytes,metadata FROM task_execution_artifacts a`;

export function createTaskZipResultDatabase(pool: TenantPool): TaskZipResultDatabase {
  return {
    async getContext(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<ContextRow>(
          `SELECT e.id AS execution_id,e.task_id,e.project_id,e.status,e.source_version_id,pv.storage_key AS source_storage_key,
                  e.result_patch,e.change_document,e.result_metadata,m.role
             FROM task_executions e
             JOIN repositories r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.provider='upload'
             JOIN project_versions pv ON pv.organization_id=e.organization_id AND pv.project_id=e.project_id AND pv.id=e.source_version_id
             JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=$3
            WHERE e.organization_id=$1 AND e.task_id=$2 AND e.status IN ('succeeded','fix_not_reproduced')
              AND e.result_patch IS NOT NULL AND e.change_document IS NOT NULL AND e.source_version_id IS NOT NULL
            ORDER BY e.attempt DESC LIMIT 1`,
          [session.organizationId, taskId, session.userId],
        );
        const row = result.rows[0]; if (!row) return null;
        return { executionId: row.execution_id, taskId: row.task_id, projectId: row.project_id, status: row.status, sourceVersionId: row.source_version_id, sourceStorageKey: row.source_storage_key, resultPatch: row.result_patch, changeDocument: row.change_document, verifiedFiles: verifiedFiles(row.result_metadata ?? {}), role: row.role } satisfies TaskZipResultContext;
      });
    },

    async getArtifact(session, executionId) {
      assertUuid(executionId, "executionId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<ArtifactRow>(`${artifactSelect} WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' ORDER BY a.created_at LIMIT 1`, [session.organizationId, executionId]);
        return result.rows[0] ? artifact(result.rows[0]) : null;
      });
    },

    async saveArtifact(session, input) {
      assertUuid(input.executionId, "executionId"); assertUuid(input.artifactVersionId, "artifactVersionId");
      return await withTenant(pool, session, async (database) => {
        await database.query(
          `INSERT INTO task_execution_artifacts (id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata)
           VALUES ($1,$2,$3,$4,'zip_result',$5,$6,$7,$8::jsonb)
           ON CONFLICT DO NOTHING`,
          [input.artifactVersionId, session.organizationId, input.taskId, input.executionId, input.storageKey, input.sha256, input.sizeBytes, JSON.stringify({ sourceVersionId: input.sourceVersionId, artifactVersionId: input.artifactVersionId, fileCount: input.fileCount })],
        );
        const result = await database.query<ArtifactRow>(`${artifactSelect} WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' ORDER BY a.created_at LIMIT 1`, [session.organizationId, input.executionId]);
        if (!result.rows[0]) throw new Error("ZIP result artifact was not persisted");
        return artifact(result.rows[0]);
      });
    },

    async promote(session, input) {
      return await withTenant(pool, session, async (database) => {
        const membership = await database.query<{ role: "owner" | "developer" | "rep" }>("SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [session.organizationId, session.userId]);
        if (membership.rows[0]?.role !== "owner" && membership.rows[0]?.role !== "developer") throw new AppError("ZIP_PROMOTION_FORBIDDEN", "Only a developer or owner can promote an updated ZIP.", 403);
        const locked = await database.query<ArtifactRow>(`${artifactSelect} WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' FOR UPDATE OF a`, [session.organizationId, input.executionId]);
        if (!locked.rows[0]) throw new AppError("ZIP_RESULT_UNAVAILABLE", "Updated ZIP is unavailable.", 409);
        const currentArtifact = artifact(locked.rows[0]);
        if (currentArtifact.promotedVersionId) return currentArtifact;
        const current = await database.query<{ id: string; version_number: number }>(`SELECT id,version_number FROM project_versions WHERE organization_id=$1 AND project_id=$2 ORDER BY version_number DESC LIMIT 1 FOR UPDATE`, [session.organizationId, input.projectId]);
        const version = current.rows[0]; if (!version) throw new AppError("PROJECT_NOT_FOUND", "Project version was not found.", 404);
        if (version.id !== input.sourceVersionId) throw new AppError("SOURCE_CHANGED", "Project source changed since this implementation was approved. Re-plan before promoting.", 409);
        const next = version.version_number + 1;
        await database.query(`INSERT INTO project_versions (id,organization_id,project_id,version_number,storage_key,size_bytes,file_count,sha256,uploaded_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.artifactVersionId, session.organizationId, input.projectId, next, input.storageKey, input.sizeBytes, input.fileCount, input.sha256, session.userId]);
        await database.query(`UPDATE project_reports SET analysed_commit=NULL,analysed_version_id=$3,analysed_at=now() WHERE organization_id=$1 AND project_id=$2`, [session.organizationId, input.projectId, input.artifactVersionId]);
        const updated = await database.query<ArtifactRow>(`UPDATE task_execution_artifacts a SET metadata=a.metadata || $3::jsonb WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' RETURNING a.execution_id,a.task_id,(SELECT project_id FROM task_executions e WHERE e.organization_id=a.organization_id AND e.id=a.execution_id) AS project_id,a.storage_key,a.sha256,a.size_bytes,a.metadata`, [session.organizationId, input.executionId, JSON.stringify({ promotedVersionId: input.artifactVersionId, promotedVersionNumber: next })]);
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,$3,'project_version_promoted',jsonb_build_object('execution_id',$4::text,'project_id',$5::text,'source_version_id',$6::text,'version_id',$7::text,'version_number',$8::int))`, [session.organizationId, session.userId, input.taskId, input.executionId, input.projectId, input.sourceVersionId, input.artifactVersionId, next]);
        if (!updated.rows[0]) throw new Error("ZIP result promotion did not update artifact");
        return artifact(updated.rows[0]);
      });
    },

    async auditDownload(session, input) {
      await withTenant(pool, session, async (database) => {
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,task_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,$3,'task_zip_result_downloaded',jsonb_build_object('execution_id',$4::text,'project_id',$5::text,'artifact_version_id',$6::text))`, [session.organizationId, session.userId, input.taskId, input.executionId, input.projectId, input.artifactVersionId]);
      });
    },
  };
}
