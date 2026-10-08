import type { SessionIdentity } from "./auth.js";
import { assertUuid, type MemberRole, type TenantPool, withTenant } from "./database.js";
import type { ProjectReport } from "./repository-analysis.js";

export type UploadProjectVersion = {
  readonly id: string;
  readonly projectId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly sha256: string;
  readonly uploadedByUserId: string;
  readonly createdAt: string;
};
export type UploadProjectView = {
  readonly project: { readonly id: string; readonly name: string };
  readonly source: { readonly type: "upload"; readonly currentVersion: UploadProjectVersion };
  readonly report: ProjectReport;
  readonly currentUserRole: MemberRole;
};
export type GitHubProjectSource = {
  readonly projectId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: number;
  readonly installationId: number;
  readonly installationStatus: "connected" | "disconnected";
};

export interface UploadProjectDatabase {
  createUploadProject(session: SessionIdentity, input: { readonly projectId: string; readonly versionId: string; readonly name: string; readonly storageKey: string; readonly sizeBytes: number; readonly fileCount: number; readonly sha256: string; readonly report: ProjectReport }): Promise<void>;
  getUploadProject(session: SessionIdentity, projectId: string): Promise<UploadProjectView | null>;
  getCurrentUploadVersion(session: SessionIdentity, projectId: string): Promise<UploadProjectVersion | null>;
  getUploadVersion(session: SessionIdentity, projectId: string, versionId: string): Promise<UploadProjectVersion | null>;
  saveUploadReport(session: SessionIdentity, projectId: string, versionId: string, report: ProjectReport): Promise<void>;
  getGitHubProjectSource(session: SessionIdentity, projectId: string): Promise<GitHubProjectSource | null>;
  deleteUploadProject(session: SessionIdentity, projectId: string): Promise<boolean>;
  auditDownload(session: SessionIdentity, projectId: string, versionId: string): Promise<void>;
}

function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }
function version(row: { id: string; project_id: string; version_number: number; storage_key: string; size_bytes: string | number; file_count: number; sha256: string; uploaded_by_user_id: string; created_at: Date | string }): UploadProjectVersion {
  return { id: row.id, projectId: row.project_id, versionNumber: row.version_number, storageKey: row.storage_key, sizeBytes: Number(row.size_bytes), fileCount: row.file_count, sha256: row.sha256, uploadedByUserId: row.uploaded_by_user_id, createdAt: iso(row.created_at) };
}

export function createUploadProjectDatabase(pool: TenantPool): UploadProjectDatabase {
  const versionSelect = `SELECT id,project_id,version_number,storage_key,size_bytes,file_count,sha256,uploaded_by_user_id,created_at FROM project_versions`;
  return {
    async createUploadProject(session, input) {
      assertUuid(input.projectId, "projectId"); assertUuid(input.versionId, "versionId");
      const name = input.name.trim(); if (name.length < 1 || name.length > 120) throw new Error("project name must be between 1 and 120 characters");
      await withTenant(pool, session, async (database) => {
        await database.query("INSERT INTO projects (id,organization_id,name) VALUES ($1,$2,$3)", [input.projectId, session.organizationId, name]);
        await database.query("INSERT INTO repositories (id,organization_id,project_id,provider,external_id,display_name) VALUES (gen_random_uuid(),$1,$2,'upload',$2,$3)", [session.organizationId, input.projectId, name]);
        await database.query(`INSERT INTO project_versions (id,organization_id,project_id,version_number,storage_key,size_bytes,file_count,sha256,uploaded_by_user_id) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)`, [input.versionId, session.organizationId, input.projectId, input.storageKey, input.sizeBytes, input.fileCount, input.sha256, session.userId]);
        await database.query("INSERT INTO project_reports (organization_id,project_id,report,analysed_commit,analysed_version_id) VALUES ($1,$2,$3::jsonb,NULL,$4)", [session.organizationId, input.projectId, JSON.stringify(input.report), input.versionId]);
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'upload_project_created',jsonb_build_object('project_id',$3::text,'version_id',$4::text))`, [session.organizationId, session.userId, input.projectId, input.versionId]);
      });
    },

    async getUploadProject(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ project_id: string; project_name: string; report: ProjectReport; current_user_role: MemberRole; id: string; version_number: number; storage_key: string; size_bytes: string | number; file_count: number; sha256: string; uploaded_by_user_id: string; created_at: Date | string }>(
          `SELECT p.id AS project_id,p.name AS project_name,pr.report,m.role AS current_user_role,pv.id,pv.version_number,pv.storage_key,pv.size_bytes,pv.file_count,pv.sha256,pv.uploaded_by_user_id,pv.created_at FROM projects p JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id AND r.provider='upload' JOIN project_reports pr ON pr.organization_id=p.organization_id AND pr.project_id=p.id JOIN project_versions pv ON pv.organization_id=p.organization_id AND pv.project_id=p.id AND pv.id=pr.analysed_version_id JOIN organization_memberships m ON m.organization_id=p.organization_id AND m.user_id=$3 WHERE p.organization_id=$1 AND p.id=$2 LIMIT 1`,
          [session.organizationId, projectId, session.userId],
        );
        const row = result.rows[0]; if (!row) return null;
        const currentVersion = version({ ...row, project_id: row.project_id });
        return { project: { id: row.project_id, name: row.project_name }, source: { type: "upload", currentVersion }, report: row.report, currentUserRole: row.current_user_role };
      });
    },

    async getCurrentUploadVersion(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string; project_id: string; version_number: number; storage_key: string; size_bytes: string | number; file_count: number; sha256: string; uploaded_by_user_id: string; created_at: Date | string }>(`${versionSelect} WHERE organization_id=$1 AND project_id=$2 ORDER BY version_number DESC LIMIT 1`, [session.organizationId, projectId]);
        const row = result.rows[0]; return row ? version(row) : null;
      });
    },

    async getUploadVersion(session, projectId, versionId) {
      assertUuid(projectId, "projectId"); assertUuid(versionId, "versionId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string; project_id: string; version_number: number; storage_key: string; size_bytes: string | number; file_count: number; sha256: string; uploaded_by_user_id: string; created_at: Date | string }>(`${versionSelect} WHERE organization_id=$1 AND project_id=$2 AND id=$3 LIMIT 1`, [session.organizationId, projectId, versionId]);
        const row = result.rows[0]; return row ? version(row) : null;
      });
    },

    async saveUploadReport(session, projectId, versionId, report) {
      assertUuid(projectId, "projectId"); assertUuid(versionId, "versionId");
      await withTenant(pool, session, async (database) => {
        const updated = await database.query<{ project_id: string }>(`UPDATE project_reports SET report=$4::jsonb,analysed_commit=NULL,analysed_version_id=$3,analysed_at=now() WHERE organization_id=$1 AND project_id=$2 RETURNING project_id`, [session.organizationId, projectId, versionId, JSON.stringify(report)]);
        if (!updated.rows[0]) throw new Error("upload project report was not found");
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'project_reanalysed',jsonb_build_object('project_id',$3::text,'version_id',$4::text,'source','upload'))`, [session.organizationId, session.userId, projectId, versionId]);
      });
    },

    async getGitHubProjectSource(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ project_id: string; repository_id: string; github_repository_id: string | number; installation_id: string | number; installation_status: "connected" | "disconnected" }>(`SELECT p.id AS project_id,r.id AS repository_id,r.github_repository_id,gi.installation_id,gi.status AS installation_status FROM projects p JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id AND r.provider='github' JOIN github_installations gi ON gi.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.id=$2 LIMIT 1`, [session.organizationId, projectId]);
        const row = result.rows[0]; return row ? { projectId: row.project_id, repositoryId: row.repository_id, githubRepositoryId: Number(row.github_repository_id), installationId: Number(row.installation_id), installationStatus: row.installation_status } : null;
      });
    },

    async deleteUploadProject(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const membership = await database.query<{ role: MemberRole }>("SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [session.organizationId, session.userId]);
        if (membership.rows[0]?.role !== "owner") throw new Error("only organization owners can delete upload projects");
        const deleted = await database.query<{ id: string }>(`DELETE FROM projects p USING repositories r WHERE p.organization_id=$1 AND p.id=$2 AND r.organization_id=p.organization_id AND r.project_id=p.id AND r.provider='upload' RETURNING p.id`, [session.organizationId, projectId]);
        return Boolean(deleted.rows[0]);
      });
    },

    async auditDownload(session, projectId, versionId) {
      assertUuid(projectId, "projectId"); assertUuid(versionId, "versionId");
      await withTenant(pool, session, async (database) => {
        await database.query(`INSERT INTO audit_events (id,organization_id,actor_user_id,event_type,payload) VALUES (gen_random_uuid(),$1,$2,'project_version_downloaded',jsonb_build_object('project_id',$3::text,'version_id',$4::text))`, [session.organizationId, session.userId, projectId, versionId]);
      });
    },
  };
}
