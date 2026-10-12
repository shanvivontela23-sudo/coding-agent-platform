import { describe, expect, it, vi } from "vitest";
import { GitHubRestPublicationClient } from "../src/github-publication-client.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GitHub publication protected drift bounds", () => {
  it("uses compare first and fetches content only for protected paths compare reports changed", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/acme/demo/installation")) return json({ id: 777 });
      if (url.endsWith("/app/installations/777/access_tokens")) return json({ token: "operation-token" });
      if (url.includes(`/compare/${"a".repeat(40)}...${"b".repeat(40)}`)) {
        return json({ ahead_by: 3, files: [{ filename: "src/changed.ts" }, { filename: "README.md" }] });
      }
      if (url.includes("/contents/src/changed.ts?ref=")) {
        return json({ sha: url.includes(`ref=${"a".repeat(40)}`) ? "1".repeat(40) : "2".repeat(40) });
      }
      throw new Error(`unexpected GitHub test request ${url}`);
    });
    const client = new GitHubRestPublicationClient({ appId: "1", privateKey: "unused", createAppJwt: () => "app-jwt", fetchImpl });
    const operation = await client.beginPublishOperation("acme/demo");
    await expect(operation.compareCommits({
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      protectedPaths: ["src/changed.ts", "src/untouched.ts", "package.json"],
    })).resolves.toEqual({ aheadBy: 3, files: ["src/changed.ts"] });

    const contentCalls = calls.filter((url) => url.includes("/contents/"));
    expect(contentCalls).toHaveLength(2);
    expect(contentCalls.every((url) => url.includes("src/changed.ts"))).toBe(true);
    expect(contentCalls.some((url) => url.includes("src/untouched.ts"))).toBe(false);
    expect(contentCalls.some((url) => url.includes("package.json"))).toBe(false);
  });
});
