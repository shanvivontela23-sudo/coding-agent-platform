import type { OnboardingIdentity, SessionIdentity, SupabaseIdentity } from "./auth.js";

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

export type VerifiedSupabaseUser = Pick<SupabaseIdentity, "supabaseUserId" | "email">;
export type MemberRole = "owner" | "developer" | "rep";
export type InviteRole = Exclude<MemberRole, "owner">;

export type Membership = {
  readonly userId: string;
  readonly organizationId: string;
  readonly role: MemberRole;
};

export type HomeData = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

export type Invitation = {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: InviteRole;
  readonly expiresAt: string;
};

export type MembersData = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly currentUser: { readonly id: string; readonly email: string | null; readonly role: MemberRole };
  readonly members: ReadonlyArray<{ readonly id: string; readonly email: string | null; readonly role: MemberRole }>;
  readonly invitations: ReadonlyArray<{ readonly id: string; readonly email: string; readonly role: InviteRole; readonly expiresAt: string }>;
};

export type ProductDatabase = {
  lookupMemberships(identity: VerifiedSupabaseUser): Promise<Membership[]>;
  createOrganizationWithOwner(identity: VerifiedSupabaseUser, organizationName: string): Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
  getHome(session: SessionIdentity): Promise<HomeData>;
  getMembers(session: SessionIdentity): Promise<MembersData>;
  createInvitation(session: SessionIdentity, email: string, role: InviteRole): Promise<Invitation>;
  listVerifiedInvitations(identity: OnboardingIdentity): Promise<Invitation[]>;
  acceptVerifiedInvitation(identity: OnboardingIdentity, invitationId: string): Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) throw new Error(`${label} must be a UUID`);
}

export function assertRestrictedDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (decodeURIComponent(url.username) !== "coding_agent_api") {
    throw new Error("DATABASE_URL must connect as the restricted coding_agent_api role");
  }
  return value;
}

function normalizeInviteEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !email.includes("@")) throw new Error("invalid invitation email");
  return email;
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
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
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
        const user = await database.query<{ id: string; email: string | null }>(
          "SELECT id, email FROM users WHERE id = $1 LIMIT 1",
          [session.userId],
        );
        const currentUser = user.rows[0];
        if (!currentUser) throw new Error("tenant user is not visible");
        const projects = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM projects ORDER BY created_at, id",
        );
        return {
          organization: { id: row.id, name: row.name },
          user: { id: currentUser.id, email: currentUser.email },
          projects: projects.rows.map((project) => ({ id: project.id, name: project.name })),
        };
      });
    },

    async getMembers(session) {
      return await withTenant(pool, session, async (database) => {
        const organization = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM organizations ORDER BY id LIMIT 1",
        );
        const organizationRow = organization.rows[0];
        if (!organizationRow) throw new Error("tenant organization is not visible");

        const current = await database.query<{ id: string; email: string | null; role: MemberRole }>(
          `SELECT u.id, u.email, m.role
             FROM organization_memberships AS m
             JOIN users AS u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND m.user_id = $2
            LIMIT 1`,
          [session.organizationId, session.userId],
        );
        const currentUser = current.rows[0];
        if (!currentUser) throw new Error("tenant membership is not visible");

        const members = await database.query<{ id: string; email: string | null; role: MemberRole }>(
          `SELECT u.id, u.email, m.role
             FROM organization_memberships AS m
             JOIN users AS u ON u.id = m.user_id
            WHERE m.organization_id = $1
            ORDER BY m.created_at, u.id`,
          [session.organizationId],
        );
        const invitations = currentUser.role === "owner"
          ? await database.query<{ id: string; email: string; role: InviteRole; expires_at: Date | string }>(
            `SELECT id, email, role, expires_at
               FROM organization_invitations
              WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now()
              ORDER BY created_at, id`,
            [session.organizationId],
          )
          : { rows: [] };

        return {
          organization: { id: organizationRow.id, name: organizationRow.name },
          currentUser,
          members: members.rows,
          invitations: invitations.rows.map((invite) => ({
            id: invite.id,
            email: invite.email,
            role: invite.role,
            expiresAt: invite.expires_at instanceof Date ? invite.expires_at.toISOString() : invite.expires_at,
          })),
        };
      });
    },

    async createInvitation(session, emailValue, role) {
      if (role !== "developer" && role !== "rep") throw new Error("invalid invitation role");
      const email = normalizeInviteEmail(emailValue);
      return await withTenant(pool, session, async (database) => {
        const owner = await database.query<{ role: MemberRole }>(
          "SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 LIMIT 1",
          [session.organizationId, session.userId],
        );
        if (owner.rows[0]?.role !== "owner") throw new Error("only organization owners can invite members");

        const result = await database.query<{ id: string; email: string; role: InviteRole; expires_at: Date | string }>(
          `INSERT INTO organization_invitations (id, organization_id, email, role, invited_by_user_id)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           ON CONFLICT (organization_id, (lower(btrim(email)))) WHERE accepted_at IS NULL
           DO UPDATE SET
             email = EXCLUDED.email,
             role = EXCLUDED.role,
             invited_by_user_id = EXCLUDED.invited_by_user_id,
             created_at = now(),
             expires_at = now() + interval '7 days'
           RETURNING id, email, role, expires_at`,
          [session.organizationId, email, role, session.userId],
        );
        const row = result.rows[0];
        if (!row) throw new Error("invitation creation returned no invitation");
        const organization = await database.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1 LIMIT 1", [session.organizationId]);
        const organizationName = organization.rows[0]?.name;
        if (!organizationName) throw new Error("tenant organization is not visible");
        return {
          id: row.id,
          organizationId: session.organizationId,
          organizationName,
          email: row.email,
          role: row.role,
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        };
      });
    },

    async listVerifiedInvitations(identity) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{
        invitation_id: string;
        organization_id: string;
        organization_name: string;
        email: string;
        role: InviteRole;
        expires_at: Date | string;
      }>(
        "SELECT invitation_id, organization_id, organization_name, email, role, expires_at FROM public.list_invitations_for_verified_email($1, $2, $3)",
        [identity.supabaseUserId, identity.email ?? "", identity.emailConfirmed === true],
      );
      return result.rows.map((row) => ({
        id: row.invitation_id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        email: row.email,
        role: row.role,
        expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
      }));
    },

    async acceptVerifiedInvitation(identity, invitationId) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      assertUuid(invitationId, "invitationId");
      const result = await pool.query<{ user_id: string; organization_id: string; role: InviteRole }>(
        "SELECT user_id, organization_id, role FROM public.accept_invitation_for_verified_email($1, $2, $3, $4)",
        [identity.supabaseUserId, identity.email ?? "", identity.emailConfirmed === true, invitationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("invitation acceptance returned no membership");
      return { userId: row.user_id, organizationId: row.organization_id };
    },
  };
}
