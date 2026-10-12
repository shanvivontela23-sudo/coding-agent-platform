import { parsePatchFiles } from "../../worker/src/patch-parser.js";

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
};

export interface GitHubPublicationClient {
  getDefaultBranchHead(input: { readonly repositoryFullName: string; readonly defaultBranch: string }): Promise<{ readonly sha: string }>;
  compareCommits(input: { readonly repositoryFullName: string; readonly baseSha: string; readonly headSha: string }): Promise<{ readonly aheadBy: number; readonly files: readonly string[] }>;
  ensurePatchedBranch(input: { readonly repositoryFullName: string; readonly branchName: string; readonly approvedSha: string; readonly patch: string }): Promise<{ readonly headSha: string }>;
  findOpenPullRequest(input: { readonly repositoryFullName: string; readonly branchName: string; readonly baseBranch: string }): Promise<{ readonly number: number; readonly url: string } | null>;
  createPullRequest(input: { readonly repositoryFullName: string; readonly branchName: string; readonly baseBranch: string; readonly title: string; readonly body: string }): Promise<{ readonly number: number; readonly url: string }>;
}

export function deterministicPublicationBranch(executionId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(executionId)) throw new Error("execution id must be a UUID");
  return `dhara/execution-${executionId.toLowerCase()}`;
}

function safePlanPath(value: string): string | null {
  const trimmed = value.trim().replace(/^[`'"(]+|[`'"),.;:]+$/g, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("..") || !trimmed.includes("/")) return null;
  if (!/^[A-Za-z0-9._@+/-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function protectedPublicationPaths(approvedPlan: string, patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const file of parsePatchFiles(patch)) for (const path of [file.oldPath, file.newPath]) if (path) paths.add(path);
  for (const match of approvedPlan.matchAll(/`([^`]+)`/g)) {
    const path = safePlanPath(match[1] ?? "");
    if (path) paths.add(path);
  }
  for (const token of approvedPlan.split(/\s+/)) {
    const path = safePlanPath(token);
    if (path) paths.add(path);
  }
  return [...paths].sort();
}

export class GitHubExecutionPublisher {
  constructor(private readonly client: GitHubPublicationClient) {}

  async publish(input: GitHubPublicationInput): Promise<PublicationResult> {
    if (!/^[0-9a-f]{40}$/i.test(input.approvedSha)) throw new Error("approved SHA must be 40 hexadecimal characters");
    const branchName = deterministicPublicationBranch(input.executionId);
    const current = await this.client.getDefaultBranchHead({ repositoryFullName: input.repositoryFullName, defaultBranch: input.defaultBranch });
    const comparison = current.sha.toLowerCase() === input.approvedSha.toLowerCase()
      ? { aheadBy: 0, files: [] as readonly string[] }
      : await this.client.compareCommits({ repositoryFullName: input.repositoryFullName, baseSha: input.approvedSha, headSha: current.sha });
    const protectedPaths = new Set(protectedPublicationPaths(input.approvedPlan, input.patch));
    const changedProtectedFiles = comparison.files.filter((path) => protectedPaths.has(path));
    if (changedProtectedFiles.length > 0) return { status: "source_changed", branchName, baseMovedCommits: comparison.aheadBy, currentHeadSha: current.sha, changedProtectedFiles };

    const branch = await this.client.ensurePatchedBranch({ repositoryFullName: input.repositoryFullName, branchName, approvedSha: input.approvedSha, patch: input.patch });
    const existing = await this.client.findOpenPullRequest({ repositoryFullName: input.repositoryFullName, branchName, baseBranch: input.defaultBranch });
    const pullRequest = existing ?? await this.client.createPullRequest({
      repositoryFullName: input.repositoryFullName,
      branchName,
      baseBranch: input.defaultBranch,
      title: input.unproven ? `[UNPROVEN] Dhara implementation ${input.executionId.slice(0, 8)}` : `Dhara implementation ${input.executionId.slice(0, 8)}`,
      body: input.changeDocument,
    });
    return { status: "published", branchName, baseMovedCommits: comparison.aheadBy, currentHeadSha: current.sha, branchHeadSha: branch.headSha, pullRequestNumber: pullRequest.number, pullRequestUrl: pullRequest.url };
  }
}
