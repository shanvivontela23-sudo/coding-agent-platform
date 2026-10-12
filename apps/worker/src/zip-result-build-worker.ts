import { boundedDependencyInstallFailureDetail } from "./change-document.js";

export type ZipResultBuildJob = {
  readonly executionId: string;
  readonly organizationId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceVersionId: string;
  readonly sourceStorageKey?: string;
  readonly sourceSha256?: string;
  readonly resultPatch?: string;
  readonly changeDocument?: string;
  readonly resultMetadata?: Readonly<Record<string, unknown>>;
};

export interface ZipResultBuildQueue {
  claimPending(): Promise<ZipResultBuildJob | null>;
  markReady(executionId: string): Promise<boolean>;
  markFailed(executionId: string, code: "ZIP_RESULT_FAILED" | "ZIP_RESULT_INTERRUPTED", message: string): Promise<boolean>;
}

export type ZipResultBuild = (job: ZipResultBuildJob) => Promise<void>;

export function sanitizeZipResultBuildFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "ZIP result build failed.";
  const detail = boundedDependencyInstallFailureDetail(raw, 2_000);
  return detail ? `ZIP result build failed: ${detail}` : "ZIP result build failed.";
}

export async function processClaimedZipResultBuild(options: {
  readonly job: ZipResultBuildJob;
  readonly queue: Pick<ZipResultBuildQueue, "markReady" | "markFailed">;
  readonly build: ZipResultBuild;
}): Promise<void> {
  try {
    await options.build(options.job);
    await options.queue.markReady(options.job.executionId);
  } catch (error) {
    await options.queue.markFailed(options.job.executionId, "ZIP_RESULT_FAILED", sanitizeZipResultBuildFailure(error));
  }
}

export async function runZipResultBuildWorkerOnce(options: {
  readonly queue: ZipResultBuildQueue;
  readonly build: ZipResultBuild;
}): Promise<{ readonly worked: boolean; readonly executionId?: string }> {
  const job = await options.queue.claimPending();
  if (!job) return { worked: false };
  await processClaimedZipResultBuild({ job, queue: options.queue, build: options.build });
  return { worked: true, executionId: job.executionId };
}
