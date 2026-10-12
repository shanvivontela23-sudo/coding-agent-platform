import type { RestrictedQueryPool } from "./postgres-execution-queue.js";
import type { ZipResultBuildJob, ZipResultBuildQueue } from "./zip-result-build-worker.js";

type BuildRow = {
  execution_id: string;
  organization_id: string;
  task_id: string;
  project_id: string;
  source_version_id: string;
  source_storage_key: string;
  source_sha256: string;
  result_patch: string;
  change_document: string;
  result_metadata: Record<string, unknown>;
};

export class PostgresZipResultBuildQueue implements ZipResultBuildQueue {
  constructor(private readonly pool: RestrictedQueryPool) {}

  async claimPending(): Promise<ZipResultBuildJob | null> {
    const result = await this.pool.query<BuildRow>("SELECT * FROM public.claim_pending_zip_result_build()");
    const row = result.rows[0];
    return row ? {
      executionId: row.execution_id,
      organizationId: row.organization_id,
      taskId: row.task_id,
      projectId: row.project_id,
      sourceVersionId: row.source_version_id,
      sourceStorageKey: row.source_storage_key,
      sourceSha256: row.source_sha256,
      resultPatch: row.result_patch,
      changeDocument: row.change_document,
      resultMetadata: row.result_metadata ?? {},
    } : null;
  }

  async markFailed(executionId: string, code: "ZIP_RESULT_FAILED" | "ZIP_RESULT_INTERRUPTED", message: string): Promise<boolean> {
    const result = await this.pool.query<{ fail_zip_result_build: boolean }>("SELECT public.fail_zip_result_build($1,$2,$3)", [executionId, code, message]);
    return result.rows[0]?.fail_zip_result_build === true;
  }
}

export type ZipResultCompletion = "inserted" | "existing" | "lost";

export class PostgresZipResultArtifactStore {
  constructor(private readonly pool: RestrictedQueryPool) {}

  async complete(input: {
    readonly executionId: string;
    readonly artifactId: string;
    readonly storageKey: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly fileCount: number;
  }): Promise<ZipResultCompletion> {
    const result = await this.pool.query<{ complete_zip_result_build: ZipResultCompletion }>(
      "SELECT public.complete_zip_result_build($1,$2,$3,$4,$5,$6)",
      [input.executionId, input.artifactId, input.storageKey, input.sha256, input.sizeBytes, input.fileCount],
    );
    return result.rows[0]?.complete_zip_result_build ?? "lost";
  }
}
