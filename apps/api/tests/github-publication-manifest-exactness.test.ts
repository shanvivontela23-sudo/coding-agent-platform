import { describe, expect, it } from "vitest";
import { GitHubRestPublicationClient } from "../src/github-publication-client.js";

function json(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }

async function operation() {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/repos/acme/demo/installation")) return json({ id: 777 });
    if (url.endsWith("/app/installations/777/access_tokens")) return json({ token: "operation-token" });
    throw new Error(`publication should refuse before repository mutation/read: ${url}`);
  };
  return await new GitHubRestPublicationClient({ appId: "1", privateKey: "unused", createAppJwt: () => "app-jwt", fetchImpl }).beginPublishOperation("acme/demo");
}

const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const common = { branchName: "dhara/execution-50000000-0000-4000-8000-000000000751", approvedSha: "a".repeat(40), patch };

describe("verified publication manifest exactness", () => {
  it("refuses when a patch path is missing from verifiedFiles", async () => {
    await expect((await operation()).ensurePatchedBranch({ ...common, verifiedFiles: [] })).rejects.toMatchObject({ code: "PUBLISHED_CONTENT_MISMATCH" });
  });

  it("refuses when verifiedFiles contains an extra path", async () => {
    await expect((await operation()).ensurePatchedBranch({
      ...common,
      verifiedFiles: [
        { path: "src/a.ts", blobSha: "d".repeat(40), mode: "100644", deleted: false },
        { path: "src/extra.ts", blobSha: "e".repeat(40), mode: "100644", deleted: false },
      ],
    })).rejects.toMatchObject({ code: "PUBLISHED_CONTENT_MISMATCH" });
  });
});
