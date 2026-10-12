import { describe, expect, it, vi } from "vitest";
import { GitHubExecutionPublisher, deterministicPublicationBranch, protectedPublicationPaths } from "../src/github-publication.js";

const executionId = "50000000-0000-4000-8000-000000000501";
const approvedSha = "a".repeat(40);
const currentSha = "b".repeat(40);
const patch = "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-old\n+new\n";
const changeDocument = "## What was asked\nFix retry\n\n## Checks and results\n- test: passed";
const verifiedFiles = [{ path: "src/retry.ts", blobSha: "d".repeat(40), mode: "100644" as const, deleted: false }];

function client(options: { changedFiles?: readonly string[]; existingPr?: { number: number; url: string } | null } = {}) {
  const operation = {
    getDefaultBranchHead: vi.fn(async () => ({ sha: currentSha })),
    compareCommits: vi.fn(async () => ({ aheadBy: 4, files: options.changedFiles ?? ["README.md"] })),
    ensurePatchedBranch: vi.fn(async () => ({ headSha: "c".repeat(40) })),
    findOpenPullRequest: vi.fn(async () => options.existingPr ?? null),
    createPullRequest: vi.fn(async () => ({ number: 42, url: "https://github.com/acme/demo/pull/42" })),
  };
  return { beginPublishOperation: vi.fn(async () => operation), operation };
}

const input = {
  executionId,
  repositoryFullName: "acme/demo",
  defaultBranch: "main",
  approvedSha,
  approvedPlan: "Update `src/retry.ts` and package.json, then add regression coverage.",
  patch,
  changeDocument,
  unproven: false,
  verifiedFiles,
};

describe("B3 GitHub execution publication", () => {
  it("uses one deterministic branch per execution and protects plan + patch paths including root-level files", () => {
    expect(deterministicPublicationBranch(executionId)).toBe(`dhara/execution-${executionId}`);
    expect(protectedPublicationPaths(input.approvedPlan, patch)).toEqual(["package.json", "src/retry.ts"]);
  });

  it("branches from the approved SHA, tolerates unrelated base movement, records distance, and uses the stored change note as PR body", async () => {
    const fake = client({ changedFiles: ["README.md", "docs/ops.md"] });
    const publisher = new GitHubExecutionPublisher(fake);
    const result = await publisher.publish(input);
    expect(result).toMatchObject({ status: "published", baseMovedCommits: 4, pullRequestNumber: 42 });
    expect(fake.beginPublishOperation).toHaveBeenCalledTimes(1);
    expect(fake.beginPublishOperation).toHaveBeenCalledWith("acme/demo");
    expect(fake.operation.ensurePatchedBranch).toHaveBeenCalledWith(expect.objectContaining({ branchName: deterministicPublicationBranch(executionId), approvedSha, patch, verifiedFiles }));
    expect(fake.operation.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ branchName: deterministicPublicationBranch(executionId), baseBranch: "main", body: changeDocument }));
  });

  it.each(["src/retry.ts", "package.json"])("blocks source_changed when protected file %s moved", async (changedFile) => {
    const fake = client({ changedFiles: [changedFile] });
    const result = await new GitHubExecutionPublisher(fake).publish(input);
    expect(result).toMatchObject({ status: "source_changed", baseMovedCommits: 4 });
    expect(fake.operation.ensurePatchedBranch).not.toHaveBeenCalled();
    expect(fake.operation.createPullRequest).not.toHaveBeenCalled();
  });

  it("adopts the existing deterministic PR after restart without creating a duplicate", async () => {
    const existing = { number: 41, url: "https://github.com/acme/demo/pull/41" };
    const fake = client({ existingPr: existing });
    const result = await new GitHubExecutionPublisher(fake).publish(input);
    expect(result).toMatchObject({ status: "published", pullRequestNumber: 41, pullRequestUrl: existing.url });
    expect(fake.operation.createPullRequest).not.toHaveBeenCalled();
  });

  it("labels an explicitly published fix_not_reproduced result as unproven without changing the stored PR body", async () => {
    const fake = client();
    await new GitHubExecutionPublisher(fake).publish({ ...input, unproven: true });
    expect(fake.operation.createPullRequest).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining("UNPROVEN"), body: changeDocument }));
  });
});
