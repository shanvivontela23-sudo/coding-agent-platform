import type { SessionIdentity, SupabaseIdentity } from "./auth.js";

export type QueryResult<Row> = { readonly rows: Row[] };
export type TenantQuery = <Row = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<QueryResult<Row>>;

export type TenantClient = {
  readonly query: TenantQuery;
  release(): void;
};

export type TenantPool = {
  connect(): Promise<TenantClient>;
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

export type Membership = {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: "owner" | "developer" | "rep";
};

export type HomeData = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

export type ProductDatabase = {
  lookupMemberships(identity: SupabaseIdentity): Promise<Membership[]>;
  createOrganizationWithOwner(identity: SupabaseIdentity, organizationName: string): Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
  getHome(session: SessionIdentity): Promise<HomeData>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${label} must be a UUID`);
}

export async function withTenant<T>(
  pool: Pick<TenantPool, "connect">,
  session: Pick<SessionIdentity, "organizationId">,
  run: (database: Pick<TenantClient, "query">) => Promise<T>,
): Promise<T> {
  assertUuid(session.organizationId, "organizationId");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE coding_agent_app");
    await client.query("SELECT set_config('app.organization_id', $1, true)", [session.organizationId]);
    const result = await run({ query: client.query.bind(client) as TenantQuery });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* release original failure path */ }
    throw error;
  } finally {
    client.release();
  }
}

export function createProductDatabase(pool: TenantPool): ProductDatabase {
  return {
    async lookupMemberships(identity) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{ user_id: string; organization_id: string; role: Membership["role"] }>(
        "SELECT user_id, organization_id, role FROM public.lookup_memberships_for_supabase_user($1)",
        [identity.supabaseUserId],
      );
      return result.rows.map((row) => ({ userId: row.user_id, organizationId: row.organization_id, role: row.role }));
    },

    async createOrganizationWithOwner(identity, organizationName) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{ user_id: string; organization_id: string }>(
        "SELECT user_id, organization_id FROM public.create_organization_with_owner($1, $2, $3)",
        [identity.supabaseUserId, identity.email ?? "", organizationName],
      );
      const row = result.rows[0];
      if (!row) throw new Error("organization onboarding returned no ids");
      return { userId: row.user_id, organizationId: row.organization_id };
    },

    async getHome(session) {
      return await withTenant(pool, session, async (database) => {
        const organization = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM organizations ORDER BY id LIMIT 1",
        );
        const row = organization.rows[0];
        if (!row) throw new Error("tenant organization is not visible");
        const projects = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM projects ORDER BY created_at, id",
        );
        return {
          organization: { id: row.id, name: row.name },
          projects: projects.rows.map((project) => ({ id: project.id, name: project.name })),
        };
      });
    },
  };
}
