import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub App registration documentation", () => {
  it("documents exact permissions, callback, OAuth-on-install and webhook settings", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("Contents: Read");
    expect(readme).toContain("Pull requests: Read & write");
    expect(readme).toContain("Metadata: Read");
    expect(readme).toContain("Request user authorization (OAuth) during installation: On");
    expect(readme).toContain("Webhook: Off");
    expect(readme).toContain("${API_ORIGIN}/auth/github/installation/callback");
    expect(readme).toMatch(/Contents: Write[\s\S]*later pull-request/i);
  });

  it("lists every GitHub App secret/config value in .env.example without values", async () => {
    const env = await readFile(".env.example", "utf8");
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
      expect(env).toContain(`${name}=`);
    }
    expect(env).not.toMatch(/GITHUB_APP_(?:CLIENT_SECRET|PRIVATE_KEY)=\S+/);
  });
});