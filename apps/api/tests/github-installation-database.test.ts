import { describe, expect, it } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import { createProductDatabase, type TenantPool } from "../src/database.js";

const session: SessionIdentity = {
  userId: "10000000-0000-4000-8000-0000000000b1",
  organizationId: "00000000-0000-4000-8000-0000000000b1",
  expiresAtMs: Date.now() + 60_000,
};

describe("GitHub installation database fallback", () => {
  it("returns the last known installation account from persisted repository metadata", async () => {
    class Client {
      release() {}
      async query<Row = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }> {
        const rows = text.includes("FROM github_installations")
          ? [{ installation_id: 42, status: "connected", account_login: "acme" }]
          : [];
        return { rows: rows as Row[] };
      }
    }
    const client = new Client();
    const database = createProductDatabase({ connect: async () => client, query: client.query.bind(client) } as unknown as TenantPool);

    await expect(database.getGitHubInstallation!(session)).resolves.toEqual({
      installationId: 42,
      status: "connected",
      accountLogin: "acme",
    });
  });
});
