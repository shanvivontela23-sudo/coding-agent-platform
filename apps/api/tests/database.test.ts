import { describe, expect, it } from "vitest";
import { assertRestrictedDatabaseUrl, createProductDatabase, withTenant, type TenantPool } from "../src/database.js";
import type { SessionIdentity } from "../src/auth.js";

type QueryRecord = { readonly text: string; readonly values?: readonly unknown[] };

class FakeClient {
  readonly queries: QueryRecord[] = [];
  released = false;
  async query(text: string, values?: readonly unknown[]) {
    this.queries.push(values ? { text, values } : { text });
    if (text === "SELECT fail") throw new Error("boom");
    return { rows: [] };
  }
  release() { this.released = true; }
}

const session: SessionIdentity = {
  userId: "10000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000001",
  expiresAtMs: Date.now() + 60_000,
};

describe("database boundary", () => {
  it("accepts only coding_agent_api as the runtime database login", () => {
    expect(assertRestrictedDatabaseUrl("postgresql://coding_agent_api:secret@localhost:5432/app")).toBe("postgresql://coding_agent_api:secret@localhost:5432/app");
    expect(() => assertRestrictedDatabaseUrl("postgresql://postgres:secret@localhost:5432/app")).toThrow("coding_agent_api");
    expect(() => assertRestrictedDatabaseUrl("postgresql://coding_agent_app:secret@localhost:5432/app")).toThrow("coding_agent_api");
  });

  it("validates organization UUID and uses a bound transaction-local set_config", async () => {
    const client = new FakeClient();
    const pool = { connect: async () => client };

    await withTenant(pool, session, async (db) => {
      await db.query("SELECT ok");
      return "done";
    });

    expect(client.queries).toEqual([
      { text: "BEGIN" },
      { text: "SET LOCAL ROLE coding_agent_app" },
      { text: "SELECT set_config('app.organization_id', $1, true)", values: [session.organizationId] },
      { text: "SELECT ok" },
      { text: "COMMIT" },
    ]);
    expect(client.released).toBe(true);
  });

  it("rejects a non-UUID organization before acquiring a pooled connection", async () => {
    let connects = 0;
    await expect(withTenant({ connect: async () => { connects += 1; return new FakeClient(); } }, { ...session, organizationId: "not-a-uuid" }, async () => undefined)).rejects.toThrow("organizationId must be a UUID");
    expect(connects).toBe(0);
  });

  it("rolls back failures and releases the client", async () => {
    const client = new FakeClient();
    await expect(withTenant({ connect: async () => client }, session, async (db) => {
      await db.query("SELECT fail");
    })).rejects.toThrow("boom");
    expect(client.queries.at(-1)).toEqual({ text: "ROLLBACK" });
    expect(client.released).toBe(true);
  });

  it("returns GitHub repo names, default branches and current ZIP version numbers with home projects", async () => {
    class HomeClient {
      release() {}
      async query<Row = Record<string, unknown>>(text: string): Promise<{ rows: Row[] }> {
        let rows: unknown[] = [];
        if (text.includes("FROM organizations")) rows = [{ id: session.organizationId, name: "Acme" }];
        else if (text.includes("FROM users")) rows = [{ id: session.userId, email: "owner@example.com" }];
        else if (text.includes("FROM projects")) rows = [
          { id: "20000000-0000-4000-8000-000000000001", name: "GitHub demo", provider: "github", full_name: "acme/backend", default_branch: "main", version_number: null },
          { id: "20000000-0000-4000-8000-000000000002", name: "ZIP demo", provider: "upload", full_name: null, default_branch: null, version_number: 3 },
        ];
        return { rows: rows as Row[] };
      }
    }
    const client = new HomeClient();
    const database = createProductDatabase({ connect: async () => client, query: client.query.bind(client) } as unknown as TenantPool);

    const home = await database.getHome(session);

    expect(home.projects).toEqual([
      { id: "20000000-0000-4000-8000-000000000001", name: "GitHub demo", source: { type: "github", fullName: "acme/backend", defaultBranch: "main" } },
      { id: "20000000-0000-4000-8000-000000000002", name: "ZIP demo", source: { type: "upload", versionNumber: 3 } },
    ]);
  });
});