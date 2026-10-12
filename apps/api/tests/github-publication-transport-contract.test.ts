import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub publication transport safety", () => {
  it("never force-pushes and exposes no merge operation", async () => {
    const transport = await readFile("apps/api/src/github-publication-client.ts", "utf8");
    const publisher = await readFile("apps/api/src/github-publication.ts", "utf8");
    expect(transport).toContain("force: false");
    expect(transport).not.toContain("force: true");
    expect(`${transport}\n${publisher}`).not.toMatch(/mergePullRequest|\/merges\b|merge_pull_request/);
  });

  it("creates publication commits with the approved SHA as their parent", async () => {
    const transport = await readFile("apps/api/src/github-publication-client.ts", "utf8");
    expect(transport).toContain("parents: [input.approvedSha]");
    expect(transport).toContain("ref: `refs/heads/${input.branchName}`");
  });
});
