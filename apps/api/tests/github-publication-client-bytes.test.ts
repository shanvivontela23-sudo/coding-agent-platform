import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubRestPublicationClient, applyUnifiedFilePatchBytes } from "../src/github-publication-client.js";

function gitBlobSha(content: Uint8Array): string {
  return createHash("sha1").update(Buffer.from(`blob ${content.byteLength}\0`)).update(content).digest("hex");
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub publication byte fidelity", () => {
  it("applies CRLF hunks without normalizing line endings", () => {
    const source = Buffer.from("first\r\nold\r\n", "utf8");
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n first\r\n-old\r\n+new\r\n";
    expect(applyUnifiedFilePatchBytes(source, patch, "utf8")).toEqual(Buffer.from("first\r\nnew\r\n", "utf8"));
  });

  it("supports Latin-1 source bytes rather than forcing UTF-8", () => {
    const source = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6c, 0x64, 0x0a]);
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n café\n-old\n+new\n";
    expect(applyUnifiedFilePatchBytes(source, patch, "latin1")).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6e, 0x65, 0x77, 0x0a]));
  });

  it("preserves a missing trailing newline", () => {
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    expect(applyUnifiedFilePatchBytes(Buffer.from("old"), patch, "utf8")).toEqual(Buffer.from("new"));
  });

  it("uses one installation token for the whole operation and publishes verified 100755 mode", async () => {
    const approvedSha = "a".repeat(40);
    const source = Buffer.from("#!/bin/sh\necho hi\n");
    const sourceSha = gitBlobSha(source);
    let installationCalls = 0;
    let tokenCalls = 0;
    let commitCreates = 0;
    let treeBody: { tree?: Array<{ path: string; mode: string; sha: string | null }> } | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/repos/acme/demo/installation")) { installationCalls += 1; return json({ id: 777 }); }
      if (url.endsWith("/app/installations/777/access_tokens")) { tokenCalls += 1; return json({ token: "operation-token" }); }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operation-token");
      if (url.endsWith(`/git/commits/${approvedSha}`) && method === "GET") return json({ tree: { sha: "treebase" } });
      if (url.includes("/git/trees/treebase?recursive=1")) return json({ tree: [{ path: "src/tool.sh", mode: "100644", type: "blob", sha: sourceSha }] });
      if (url.endsWith(`/git/blobs/${sourceSha}`) && method === "GET") return json({ content: source.toString("base64"), encoding: "base64" });
      if (url.endsWith("/git/blobs") && method === "POST") return json({ sha: sourceSha });
      if (url.endsWith("/git/trees") && method === "POST") { treeBody = JSON.parse(String(init?.body)); return json({ sha: "treenew" }); }
      if (url.endsWith("/git/commits") && method === "POST") { commitCreates += 1; return json({ sha: "commitnew" }); }
      if (url.includes("/git/ref/heads/dhara/execution-") && method === "GET") return json({}, 404);
      if (url.endsWith("/git/refs") && method === "POST") return json({});
      if (url.includes("/git/refs/heads/dhara/execution-") && method === "PATCH") return json({});
      throw new Error(`unexpected GitHub test request ${method} ${url}`);
    });
    const client = new GitHubRestPublicationClient({ appId: "1", privateKey: "unused", createAppJwt: () => "app-jwt", fetchImpl });
    const operation = await client.beginPublishOperation("acme/demo");
    await operation.ensurePatchedBranch({
      branchName: "dhara/execution-50000000-0000-4000-8000-000000000700",
      approvedSha,
      patch: "diff --git a/src/tool.sh b/src/tool.sh\nold mode 100644\nnew mode 100755\n",
      verifiedFiles: [{ path: "src/tool.sh", blobSha: sourceSha, mode: "100755", deleted: false }],
    });
    expect(installationCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(commitCreates).toBe(1);
    expect(treeBody?.tree?.find((entry) => entry.path === "src/tool.sh")?.mode).toBe("100755");
  });

  it("refuses PUBLISHED_CONTENT_MISMATCH before blob or commit creation", async () => {
    const approvedSha = "a".repeat(40);
    const source = Buffer.from("old\n");
    const sourceSha = gitBlobSha(source);
    let blobCreates = 0;
    let commitCreates = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/repos/acme/demo/installation")) return json({ id: 777 });
      if (url.endsWith("/app/installations/777/access_tokens")) return json({ token: "operation-token" });
      if (url.endsWith(`/git/commits/${approvedSha}`) && method === "GET") return json({ tree: { sha: "treebase" } });
      if (url.includes("/git/trees/treebase?recursive=1")) return json({ tree: [{ path: "src/a.txt", mode: "100644", type: "blob", sha: sourceSha }] });
      if (url.endsWith(`/git/blobs/${sourceSha}`) && method === "GET") return json({ content: source.toString("base64"), encoding: "base64" });
      if (url.endsWith("/git/blobs") && method === "POST") { blobCreates += 1; return json({ sha: "e".repeat(40) }); }
      if (url.endsWith("/git/commits") && method === "POST") { commitCreates += 1; return json({ sha: "commitnew" }); }
      throw new Error(`unexpected GitHub test request ${method} ${url}`);
    };
    const client = new GitHubRestPublicationClient({ appId: "1", privateKey: "unused", createAppJwt: () => "app-jwt", fetchImpl });
    const operation = await client.beginPublishOperation("acme/demo");
    await expect(operation.ensurePatchedBranch({
      branchName: "dhara/execution-50000000-0000-4000-8000-000000000701",
      approvedSha,
      patch: "diff --git a/src/a.txt b/src/a.txt\n--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
      verifiedFiles: [{ path: "src/a.txt", blobSha: "f".repeat(40), mode: "100644", deleted: false }],
    })).rejects.toMatchObject({ code: "PUBLISHED_CONTENT_MISMATCH" });
    expect(blobCreates).toBe(0);
    expect(commitCreates).toBe(0);
  });
});
