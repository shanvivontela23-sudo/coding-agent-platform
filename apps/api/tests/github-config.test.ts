import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const requiredEnv = [
  "GITHUB_APP_SLUG",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_STATE_SECRET",
] as const;

describe("Dhara GitHub App operator setup", () => {
  it("documents the exact GitHub App registration settings", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("Contents: Read-only");
    expect(readme).toContain("Pull requests: Read & write");
    expect(readme).toContain("Metadata: Read-only");
    expect(readme).toContain("http://localhost:3001/github/callback");
    expect(readme).toContain("Request user authorization (OAuth) during installation");
    expect(readme).toMatch(/Request user authorization \(OAuth\) during installation.*On/i);
    expect(readme).toMatch(/Webhook.*Off/i);
    expect(readme).toContain("Contents: Read & write");
    expect(readme).toMatch(/later pull-request/i);
    for (const name of requiredEnv) expect(readme).toContain(name);
  });

  it("lists every required server-side GitHub value in the environment example", async () => {
    const env = await readFile(".env.example", "utf8");
    for (const name of requiredEnv) expect(env).toContain(`${name}=`);
    expect(env).not.toContain("installation-secret-token");
  });

  it("normalizes escaped PEM newlines only on the API server", async () => {
    const main = await readFile("apps/api/src/main.ts", "utf8");
    expect(main).toContain('GITHUB_APP_PRIVATE_KEY');
    expect(main).toContain('.replace(/\\\\n/g, "\\n")');
    expect(main).toContain("GITHUB_APP_STATE_SECRET");
  });
});
