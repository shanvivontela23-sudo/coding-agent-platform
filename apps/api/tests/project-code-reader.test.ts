import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import { GitHubProjectCodeReader } from "../src/project-code-reader.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function blob(content: string): Response {
  return json({ encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content, "utf8").toString("base64") });
}

describe("GitHub project code retrieval", () => {
  it("reads the current default-branch commit and builds bounded deterministic path/manifest/text context", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const revision = "abcdef0123456789abcdef0123456789abcdef01";
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/app/installations/42/access_tokens")) return json({ token: "installation-token" });
      if (url.endsWith("/repositories/99")) return json({ full_name: "acme/shop", default_branch: "main" });
      if (url.endsWith("/repos/acme/shop/commits/main")) return json({ sha: revision });
      if (url.includes(`/repos/acme/shop/git/trees/${revision}`)) return json({ truncated: false, tree: [
        { path: "package.json", type: "blob", sha: "manifest", size: 80 },
        { path: "src/cart.ts", type: "blob", sha: "cart", size: 100 },
        { path: "src/profile.ts", type: "blob", sha: "profile", size: 100 },
        { path: "node_modules/ignored/index.ts", type: "blob", sha: "ignored", size: 100 },
      ] });
      if (url.endsWith("/git/blobs/manifest")) return blob('{"scripts":{"test":"vitest"},"dependencies":{"react":"19"}}');
      if (url.endsWith("/git/blobs/cart")) return blob("export function retryCartSave() { return 'retry cart save'; }");
      if (url.endsWith("/git/blobs/profile")) return blob("export const profile = 'unrelated';");
      throw new Error(`unexpected fetch ${url}`);
    };
    const session: SessionIdentity = { userId: "10000000-0000-4000-8000-000000000001", organizationId: "00000000-0000-4000-8000-000000000001", expiresAtMs: Date.now() + 60_000 };
    const reader = new GitHubProjectCodeReader({
      database: { getProjectSource: async () => ({ projectId: "20000000-0000-4000-8000-000000000001", repositoryId: "30000000-0000-4000-8000-000000000001", githubRepositoryId: 99, installationId: 42, installationStatus: "connected" }) },
      appId: "123",
      privateKey: pem,
      fetchImpl,
      nowMs: () => 1_800_000_000_000,
      maxCandidateFiles: 8,
      maxContextChars: 10_000,
    });

    const context = await reader.readContext(session, "20000000-0000-4000-8000-000000000001", "retry cart save");
    expect(context.source).toBe("github");
    expect(context.revision).toBe(revision);
    expect(context.text).toContain(`Revision: ${revision}`);
    expect(context.text).toContain("--- package.json ---");
    expect(context.text).toContain("--- src/cart.ts ---");
    expect(context.text).toContain("retry cart save");
    expect(context.text).not.toContain("node_modules/ignored");
    expect(calls).toContain(`https://api.github.com/repos/acme/shop/commits/main`);
  });
});
