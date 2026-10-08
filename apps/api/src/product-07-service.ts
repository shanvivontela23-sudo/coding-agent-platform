import { randomUUID } from "node:crypto";
import type { SessionIdentity } from "./auth.js";
import type { ProductDatabase } from "./database.js";
import { AppError } from "./errors.js";
import type { GitHubAppClient } from "./github-app.js";
import { ProjectDownloadTokenService } from "./project-download-token.js";
import type { ProjectStorage } from "./project-storage.js";
import { validateAndNormalizeZip, type UploadArchiveLimits } from "./upload-archive.js";
import type { UploadProjectDatabase, UploadProjectView } from "./upload-project-database.js";

export type DownloadedProjectVersion = { readonly bytes: Uint8Array; readonly filename: string };

export interface Product07Service {
  createUploadProject(session: SessionIdentity, input: { readonly name: string; readonly zip: Uint8Array }): Promise<{ readonly projectId: string }>;
  getUploadProject(session: SessionIdentity, projectId: string): Promise<UploadProjectView | null>;
  reanalyse(session: SessionIdentity, projectId: string): Promise<void>;
  issueDownloadToken(session: SessionIdentity, projectId: string, versionId: string): Promise<string>;
  download(session: SessionIdentity, token: string): Promise<DownloadedProjectVersion>;
  deleteUploadProject(session: SessionIdentity, projectId: string): Promise<void>;
}

export function createProduct07Service(options: {
  readonly database: UploadProjectDatabase;
  readonly productDatabase: ProductDatabase;
  readonly storage: ProjectStorage;
  readonly githubApp: GitHubAppClient;
  readonly downloadTokens: ProjectDownloadTokenService;
  readonly limits: UploadArchiveLimits;
}): Product07Service {
  const createGitHubProject = options.productDatabase.createGitHubProject;
  if (!createGitHubProject) throw new Error("GitHub project persistence is not configured");

  const storedArchiveLimits: UploadArchiveLimits = { ...options.limits, maxCompressedBytes: Math.max(options.limits.maxCompressedBytes, options.limits.maxUncompressedBytes) };
  return {
    async createUploadProject(session, input) {
      const name = input.name.trim();
      if (!name || name.length > 120) throw new AppError("INVALID_UPLOAD_ARCHIVE", "Project name must be between 1 and 120 characters.", 400);
      const validated = await validateAndNormalizeZip(input.zip, options.limits);
      const projectId = randomUUID(); const versionId = randomUUID();
      const stored = await options.storage.writeVersion({ organizationId: session.organizationId, projectId, versionId, bytes: validated.normalizedZip });
      try {
        await options.database.createUploadProject(session, { projectId, versionId, name, storageKey: stored.storageKey, sizeBytes: validated.sizeBytes, fileCount: validated.fileCount, sha256: validated.sha256, report: validated.report });
      } catch (error) {
        await options.storage.deleteProject(session.organizationId, projectId).catch(() => undefined);
        throw error;
      }
      return { projectId };
    },

    async getUploadProject(session, projectId) { return await options.database.getUploadProject(session, projectId); },

    async reanalyse(session, projectId) {
      const uploadVersion = await options.database.getCurrentUploadVersion(session, projectId);
      if (uploadVersion) {
        const stored = await options.storage.readVersion(uploadVersion.storageKey);
        const validated = await validateAndNormalizeZip(stored, storedArchiveLimits);
        if (validated.sha256 !== uploadVersion.sha256) throw new AppError("INVALID_UPLOAD_ARCHIVE", "Stored project version failed its integrity check.", 409);
        await options.database.saveUploadReport(session, projectId, uploadVersion.id, validated.report);
        return;
      }

      const githubSource = await options.database.getGitHubProjectSource(session, projectId);
      if (!githubSource) throw new AppError("PROJECT_NOT_FOUND", "Project was not found.", 404);
      if (githubSource.installationStatus !== "connected") throw new AppError("GITHUB_INSTALLATION_DISCONNECTED", "GitHub installation is disconnected.", 409);
      const analysis = await options.githubApp.analyseRepository(githubSource.installationId, githubSource.githubRepositoryId, options.limits);
      const updated = await createGitHubProject(session, {
        repositoryId: analysis.repository.id,
        name: analysis.repository.name,
        fullName: analysis.repository.fullName,
        defaultBranch: analysis.repository.defaultBranch,
        commitSha: analysis.commitSha,
        report: analysis.report,
      });
      if (updated.projectId !== projectId) throw new Error("GitHub re-analysis changed the project identity");
    },

    async issueDownloadToken(session, projectId, versionId) {
      const version = await options.database.getUploadVersion(session, projectId, versionId);
      if (!version) throw new AppError("PROJECT_NOT_FOUND", "Project version was not found.", 404);
      return options.downloadTokens.issue({ organizationId: session.organizationId, userId: session.userId, projectId, projectVersionId: versionId });
    },

    async download(session, token) {
      let claims;
      try { claims = options.downloadTokens.verify(token); } catch { throw new AppError("PROJECT_DOWNLOAD_INVALID", "Download link is invalid or expired.", 403); }
      if (claims.organizationId !== session.organizationId || claims.userId !== session.userId) throw new AppError("PROJECT_DOWNLOAD_INVALID", "Download link is invalid or expired.", 403);
      const version = await options.database.getUploadVersion(session, claims.projectId, claims.projectVersionId);
      if (!version) throw new AppError("PROJECT_NOT_FOUND", "Project version was not found.", 404);
      const bytes = await options.storage.readVersion(version.storageKey);
      await options.database.auditDownload(session, claims.projectId, claims.projectVersionId);
      return { bytes, filename: `${claims.projectId}-v${version.versionNumber}.zip` };
    },

    async deleteUploadProject(session, projectId) {
      let deleted: boolean;
      try { deleted = await options.database.deleteUploadProject(session, projectId); }
      catch (error) { if (error instanceof Error && /owners can delete/i.test(error.message)) throw new AppError("PROJECT_DELETE_FORBIDDEN", "Only an organization owner can delete this project.", 403); throw error; }
      if (!deleted) throw new AppError("PROJECT_NOT_FOUND", "Upload project was not found.", 404);
      await options.storage.deleteProject(session.organizationId, projectId);
    },
  };
}
