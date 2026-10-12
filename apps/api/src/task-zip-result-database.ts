import { assertUuid, type TenantPool, withTenant } from "./database.js";
import { AppError } from "./errors.js";
import type { VerifiedFile } from "../../worker/src/verification.js";
import type { TaskZipResultArtifact, TaskZipResultBuildState, TaskZipResultContext, TaskZipResultDatabase, ZipResultBuildStatus } from "./task-zip-result.js";

type ContextRow = {
  execution_id: string; task_id: string; project_id: string; status: "succeeded" | "fix_not_reproduced"; source_version_id: string;
  source_storage_key: string; source_sha256: string; result_patch: string; change_document: string; result_metadata: Record<string, unknown>; role: "owner" | "developer" | "rep";
};
type ArtifactRow = { execution_id: string; task_id: string; project_id: string; storage_key: string; sha256: string; size_bytes: string | number; metadata: Record<string, unknown> };
type StatusRow = { execution_id: string; zip_build_status: ZipResultBuildStatus | null; zip_build_started_at: string | null; zip_build_error_code: string | null; zip_build_error_message: string | null };

type DatabaseClient = Parameters<Parameters<typeof withTenant>[2]>[0];

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

async function contextByExecution(database: DatabaseClient, organizationId: string, userId: string, executionId: string): Promise<TaskZipResultContext | null> {
  const result = await database.query<ContextRow>(
    `SELECT e.id AS execution_id,e.task_id,e.project_id,e.status,e.source_version_id,pv.storage_key AS source_storage_key,pv.sha256 AS source_sha256,
            e.result_patch,e.change_document,e.result_metadata,m.role
       FROM task_executions e
       JOIN repositories r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.provider='upload'
       JOIN project_versions pv ON pv.organization_id=e.organization_id AND pv.project_id=e.project_id AND pv.id=e.source_version_id
       JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=$3
      WHERE e.organization_id=$1 AND e.id=$2 AND e.status IN ('succeeded','fix_not_reproduced')
        AND e.result_patch IS NOT NULL AND e.change_document IS NOT NULL AND e.source_version_id IS NOT NULL
      LIMIT 1`,
    [organizationId, executionId, userId],
  );
  const row = result.rows[0]; if (!row) return null;
  return { executionId: row.execution_id, taskId: row.task_id, projectId: row.project_id, status: row.status, sourceVersionId: row.source_version_id, sourceStorageKey: row.source_storage_key, sourceSha256: row.source_sha256, resultPatch: row.result_patch, changeDocument: row.change_document, verifiedFiles: verifiedFiles(row.result_metadata ?? {}), role: row.role };
}
async function latestExecutionId(database: DatabaseClient, organizationId: string, userId: string, taskId: string): Promise<{ executionId: string; role: "owner" | "developer" | "rep"; status: "succeeded" | "fix_not_reproduced" } | null> {
  const result = await database.query<{ execution_id: string; role: "owner" | "developer" | "rep"; status: "succeeded" | "fix_not_reproduced" }>(
    `SELECT e.id AS execution_id,m.role,e.status
       FROM task_executions e
       JOIN repositories r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.provider='upload'
       JOIN organization_memberships m ON m.organization_id=e.organization_id AND m.user_id=$3
      WHERE e.organization_id=$1 AND e.task_id=$2 AND e.status IN ('succeeded','fix_not_reproduced')
      ORDER BY e.attempt DESC LIMIT 1`, [organizationId, taskId, userId],
  );
  const row = result.rows[0];
  return row ? { executionId: row.execution_id, role: row.role, status: row.status } : null;
}
function requireBuilderRole(role: "owner" | "developer" | "rep"): void {
  if (role !== "owner" && role !== "developer") throw new AppError("ZIP_UNPROVEN_ACCEPT_FORBIDDEN", "Only a developer or owner can build an updated ZIP.", 403);
}

export function createTaskZipResultDatabase(pool: TenantPool): TaskZipResultDatabase {
  return {
    async getStatus(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const latest = await latestExecutionId(database, session.organizationId, session.userId, taskId);
        if (!latest) return { status: null, errorCode: null, errorMessage: null, artifact: null } satisfies TaskZipResultBuildState;
        const state = await database.query<StatusRow>(`SELECT id AS execution_id,zip_build_status,zip_build_started_at,zip_build_error_code,zip_build_error_message FROM task_executions WHERE organization_id=$1 AND id=$2`, [session.organizationId, latest.executionId]);
        const row = state.rows[0];
        const stale = row?.zip_build_status === "building" && row.zip_build_started_at !== null && Date.now() - new Date(row.zip_build_started_at).getTime() >= 10 * 60_000;
        const result = await database.query<ArtifactRow>(`${artifactSelect} WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' ORDER BY a.created_at LIMIT 1`, [session.organizationId, latest.executionId]);
        return {
          status: stale ? "failed" : row?.zip_build_status ?? null,
          errorCode: stale ? "ZIP_RESULT_INTERRUPTED" : row?.zip_build_error_code ?? null,
          errorMessage: stale ? "ZIP result build was interrupted. Retry building the ZIP." : row?.zip_build_error_message ?? null,
          artifact: result.rows[0] ? artifact(result.rows[0]) : null,
        } satisfies TaskZipResultBuildState;
      });
    },

    async getContext(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const latest = await latestExecutionId(database, session.organizationId, session.userId, taskId);
        return latest ? await contextByExecution(database, session.organizationId, session.userId, latest.executionId) : null;
      });
    },

    async getArtifact(session, executionId) {
      assertUuid(executionId, "executionId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<ArtifactRow>(`${artifactSelect} WHERE a.organization_id=$1 AND a.execution_id=$2 AND a.kind='zip_result' ORDER BY a.created_at LIMIT 1`, [session.organizationId, executionId]);
        return result.rows[0] ? artifact(result.rows[0]) : null;
      });
    },

    async insertArtifact(session, input) {
      assertUuid(input.executionId, "executionId"); assertUuid(input.artifactVersionId, "artifactVersionId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>(
          `INSERT INTO task_execution_artifacts (id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata)
           VALUES ($1,$2,$3,$4,'zip_result',$5,$6,$7,$8::jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [input.artifactVersionId, session.organizationId, input.taskId, input.executionId, input.storageKey, input.sha256, input.sizeBytes, JSON.stringify({ sourceVersionId: input.sourceVersionId, artifactVersionId: input.artifactVersionId, fileCount: input.fileCount })],
        );
        return result.rows.length === 1;
      });
    },

    async acceptUnproven(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const latest = await latestExecutionId(database, session.organizationId, session.userId, taskId); if (!latest) return null;
        requireBuilderRole(latest.role);
        if (latest.status !== "fix_not_reproduced") throw new AppError("ZIP_RESULT_UNAVAILABLE", "Only an unproven ZIP result can be accepted here.", 409);
        await database.query(`UPDATE task_executions SET zip_build_status='pending',zip_build_started_at=NULL,zip_build_error_code=NULL,zip_build_error_message=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status IS NULL`, [session.organizationId, latest.executionId]);
        const claimed = await database.query<{ id: string }>(`UPDATE task_executions SET zip_build_status='building',zip_build_started_at=clock_timestamp(),zip_build_error_code=NULL,zip_build_error_message=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status='pending' RETURNING id`, [session.organizationId, latest.executionId]);
        return claimed.rows[0] ? await contextByExecution(database, session.organizationId, session.userId, latest.executionId) : null;
      });
    },

    async retryBuild(session, taskId) {
      assertUuid(taskId, "taskId");
      return await withTenant(pool, session, async (database) => {
        const latest = await latestExecutionId(database, session.organizationId, session.userId, taskId); if (!latest) return null;
        requireBuilderRole(latest.role);
        await database.query(`UPDATE task_executions SET zip_build_status='failed',zip_build_started_at=NULL,zip_build_error_code='ZIP_RESULT_INTERRUPTED',zip_build_error_message='ZIP result build was interrupted. Retry building the ZIP.',updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status='building' AND zip_build_started_at IS NOT NULL AND zip_build_started_at <= clock_timestamp() - interval '10 minutes'`, [session.organizationId, latest.executionId]);
        const claimed = await database.query<{ id: string }>(`UPDATE task_executions SET zip_build_status='building',zip_build_started_at=clock_timestamp(),zip_build_error_code=NULL,zip_build_error_message=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status='failed' RETURNING id`, [session.organizationId, latest.executionId]);
        return claimed.rows[0] ? await contextByExecution(database, session.organizationId, session.userId, latest.executionId) : null;
      });
    },

    async markReady(session, executionId) {
      return await withTenant(pool, session, async (database) => (await database.query<{ id: string }>(`UPDATE task_executions SET zip_build_status='ready',zip_build_started_at=NULL,zip_build_error_code=NULL,zip_build_error_message=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status='building' RETURNING id`, [session.organizationId, executionId])).rows.length === 1);
    },

    async markFailed(session, executionId, code, message) {
      return await withTenant(pool, session, async (database) => (await database.query<{ id: string }>(`UPDATE task_executions SET zip_build_status='failed',zip_build_started_at=NULL,zip_build_error_code=$3,zip_build_error_message=$4,updated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND zip_build_status='building' RETURNING id`, [session.organizationId, executionId, code, message])).rows.length === 1);
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
