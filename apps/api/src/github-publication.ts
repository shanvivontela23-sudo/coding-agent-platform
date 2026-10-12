import { AppError } from "./errors.js";
import { parsePatchFiles } from "../../worker/src/patch-parser.js";
import type { VerifiedFile } from "../../worker/src/verification.js";

export type PublicationResult =
  | { readonly status: "published"; readonly branchName: string; readonly baseMovedCommits: number; readonly currentHeadSha: string; readonly branchHeadSha: string; readonly pullRequestNumber: number; readonly pullRequestUrl: string }
  | { readonly status: "source_changed"; readonly branchName: string; readonly baseMovedCommits: number; readonly currentHeadSha: string; readonly changedProtectedFiles: readonly string[] };

export type GitHubPublicationInput = {
  readonly executionId: string;
  readonly repositoryFullName: string;
  readonly defaultBranch: string;
  readonly approvedSha: string;
  readonly approvedPlan: string;
  readonly patch: string;
  readonly changeDocument: string;
  readonly unproven: boolean;
  readonly verifiedFiles: readonly VerifiedFile[];
};

export interface GitHubPublicationOperation {
  getDefaultBranchHead(defaultBranch: string): Promise<{ readonly sha: string }>;
  compareCommits(input: { readonly baseSha: string; readonly headSha: string; readonly protectedPaths: readonly string[] }): Promise<{ readonly aheadBy: number; readonly files: readonly string[] }>;
  ensurePatchedBranch(input: { readonly branchName: string; readonly approvedSha: string; readonly patch: string; readonly verifiedFiles: readonly VerifiedFile[] }): Promise<{ readonly headSha: string }>;
  findOpenPullRequest(input: { readonly branchName: string; readonly baseBranch: string }): Promise<{ readonly number: number; readonly url: string } | null>;
  createPullRequest(input: { readonly branchName: string; readonly baseBranch: string; readonly title: string; readonly body: string }): Promise<{ readonly number: number; readonly url: string }>;
}

export interface GitHubPublicationClient {
  beginPublishOperation(repositoryFullName: string): Promise<GitHubPublicationOperation>;
}

export function deterministicPublicationBranch(executionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(executionId)) throw new Error("execution id must be a UUID");
  return `dhara/execution-${executionId.toLowerCase()}`;
}

const rootFileExtensions = new Set([
  "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "html", "java", "js", "json", "jsx", "kt", "kts", "md", "mjs", "cjs", "php", "py", "rb", "rs", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "vue", "yaml", "yml",
]);
const MAX_PROTECTED_PATHS = 200;

function safePlanPath(value: string): string | null {
  const trimmed = value.trim().replace(/^[`'"(]+|[`'"),.;:]+$/g, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  if (!/^[A-Za-z0-9._@+/-]+$/.test(trimmed)) return null;
  if (!trimmed.includes("/")) {
    const extension = trimmed.includes(".") ? trimmed.split(".").at(-1)?.toLowerCase() : undefined;
    if (!extension || !rootFileExtensions.has(extension)) return null;
  }
  return trimmed;
}

export function protectedPublicationPaths(approvedPlan: string, patch: string): readonly string[] {
  const paths = new Set<string>();
  const add = (path: string) => {
    paths.add(path);
    if (paths.size > MAX_PROTECTED_PATHS) throw new AppError("TASK_PUBLICATION_NOT_ALLOWED", "Approved plan names more than 200 protected repository paths. Re-plan with a narrower file scope.", 409);
  };
  for (const file of parsePatchFiles(patch)) for (const path of [file.oldPath, file.newPath]) if (path) add(path);
  for (const match of approvedPlan.matchAll(/`([^`]+)`/g)) {
    const path = safePlanPath(match[1] ?? "");
    if (path) add(path);
  }
  for (const token of approvedPlan.split(/\s+/)) {
    const path = safePlanPath(token);
    if (path) add(path);
  }
  return [...paths].sort();
}

export class GitHubExecutionPublisher {
  constructor(private readonly client: GitHubPublicationClient) {}

  async publish(input: GitHubPublicationInput): Promise<PublicationResult> {
    if (!/^[0-9a-f]{40}$/i.test(input.approvedSha)) throw new Error("approved SHA must be 40 hexadecimal characters");
    if (input.verifiedFiles.length === 0) throw new AppError("PUBLISHED_CONTENT_MISMATCH", "Verified file evidence is missing; publication refused.", 409);
    const branchName = deterministicPublicationBranch(input.executionId);
    const protectedPaths = protectedPublicationPaths(input.approvedPlan, input.patch);
    const protectedPathSet = new Set(protectedPaths);
    const operation = await this.client.beginPublishOperation(input.repositoryFullName);
    const current = await operation.getDefaultBranchHead(input.defaultBranch);
    const comparison = current.sha.toLowerCase() === input.approvedSha.toLowerCase()
      ? { aheadBy: 0, files: [] as readonly string[] }
      : await operation.compareCommits({ baseSha: input.approvedSha, headSha: current.sha, protectedPaths });
    const changedProtectedFiles = comparison.files.filter((path) => protectedPathSet.has(path));
    if (changedProtectedFiles.length > 0) return { status: "source_changed", branchName, baseMovedCommits: comparison.aheadBy, currentHeadSha: current.sha, changedProtectedFiles };

    const branch = await operation.ensurePatchedBranch({ branchName, approvedSha: input.approvedSha, patch: input.patch, verifiedFiles: input.verifiedFiles });
    const existing = await operation.findOpenPullRequest({ branchName, baseBranch: input.defaultBranch });
    const pullRequest = existing ?? await operation.createPullRequest({
      branchName,
      baseBranch: input.defaultBranch,
      title: input.unproven ? `[UNPROVEN] Dhara implementation ${input.executionId.slice(0, 8)}` : `Dhara implementation ${input.executionId.slice(0, 8)}`,
      body: input.changeDocument,
    });
    return { status: "published", branchName, baseMovedCommits: comparison.aheadBy, currentHeadSha: current.sha, branchHeadSha: branch.headSha, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url };
  }
}
