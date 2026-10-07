import type { ProjectReport } from "../../../packages/project-analysis/index.js";
import type { OnboardingIdentity, SessionIdentity, SupabaseIdentity } from "./auth.js";
import { ApiError } from "./errors.js";

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

export type GitHubProjectInput = {
  readonly repositoryId: number;
  readonly repositoryName: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly report: ProjectReport;
};

export type ProjectData = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly repository: {
      readonly id: string;
      readonly externalId: string;
      readonly fullName: string;
      readonly defaultBranch: string;
      readonly lastAnalyzedCommitSha: string;
    };
    readonly report: ProjectReport;
  };
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

export type GitHubDatabase = {
  getCurrentMemberRole(session: SessionIdentity): Promise<MemberRole>;
  createGitHubInstallState(session: SessionIdentity, expiresAtMs: number): Promise<{ readonly id: string; readonly expiresAtMs: number }>;
  consumeGitHubInstallState(session: SessionIdentity, stateId: string): Promise<void>;
  bindGitHubInstallation(session: SessionIdentity, installationId: number): Promise<void>;
  getGitHubInstallation(session: SessionIdentity): Promise<number | null>;
  createProjectFromRepository(session: SessionIdentity, input: GitHubProjectInput): Promise<{ readonly projectId: string }>;
  getProject(session: SessionIdentity, projectId: string): Promise<ProjectData>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commitShaPattern = /^[0-9a-f]{40}$/;

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

function isConnectorRole(role: MemberRole): boolean {
  return role === "owner" || role === "developer";
}

function databaseErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof (error as { readonly code?: unknown }).code === "string" ? (error as { readonly code: string }).code : null;
}

function validateProjectInput(input: GitHubProjectInput): void {
  if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new ApiError("invalid_request", 400);
  if (!input.repositoryName.trim() || input.repositoryName.length > 255) throw new ApiError("invalid_request", 400);
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.fullName) || input.fullName.length > 255) throw new ApiError("invalid_request", 400);
  if (!input.defaultBranch.trim() || input.defaultBranch.length > 255) throw new ApiError("invalid_request", 400);
  if (!commitShaPattern.test(input.commitSha)) throw new ApiError("invalid_request", 400);
}

async function currentMemberRole(database: Pick<TenantClient, "query">, session: Pick<SessionIdentity, "organizationId" | "userId">): Promise<MemberRole> {
  const membership = await database.query<{ role: MemberRole }>(
    "SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 LIMIT 1",
    [session.organizationId, session.userId],
  );
  const role = membership.rows[0]?.role;
  if (role !== "owner" && role !== "developer" && role !== "rep") throw new ApiError("auth_required", 401);
  return role;
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

export function createProductDatabase(pool: TenantPool): ProductDatabase & GitHubDatabase {
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

    async getCurrentMemberRole(session) {
      return await withTenant(pool, session, async (database) => await currentMemberRole(database, session));
    },

    async createGitHubInstallState(session, expiresAtMs) {
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new ApiError("github_state_invalid", 400);
      return await withTenant(pool, session, async (database) => {
        const role = await currentMemberRole(database, session);
        if (!isConnectorRole(role)) throw new ApiError("forbidden", 403);
        const result = await database.query<{ id: string; expires_at: Date | string }>(
          `INSERT INTO github_installation_states (id, organization_id, user_id, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3)
           RETURNING id, expires_at`,
          [session.organizationId, session.userId, new Date(expiresAtMs)],
        );
        const row = result.rows[0];
        if (!row) throw new ApiError("internal_error", 500);
        const parsedExpiry = row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime();
        if (!Number.isFinite(parsedExpiry)) throw new ApiError("internal_error", 500);
        return { id: row.id, expiresAtMs: parsedExpiry };
      });
    },

    async consumeGitHubInstallState(session, stateId) {
      assertUuid(stateId, "stateId");
      await withTenant(pool, session, async (database) => {
        const result = await database.query<{ id: string }>(
          `UPDATE github_installation_states
              SET consumed_at = now()
            WHERE id = $1
              AND organization_id = $2
              AND user_id = $3
              AND consumed_at IS NULL
              AND expires_at > now()
          RETURNING id`,
          [stateId, session.organizationId, session.userId],
        );
        if (!result.rows[0]) throw new ApiError("github_state_invalid", 400);
      });
    },

    async bindGitHubInstallation(session, installationId) {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new ApiError("github_installation_unverified", 400);
      try {
        await withTenant(pool, session, async (database) => {
          const role = await currentMemberRole(database, session);
          if (!isConnectorRole(role)) throw new ApiError("forbidden", 403);
          await database.query(
            `INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (organization_id) DO UPDATE SET
               installation_id = EXCLUDED.installation_id,
               connected_by_user_id = EXCLUDED.connected_by_user_id,
               updated_at = now()`,
            [session.organizationId, installationId, session.userId],
          );
        });
      } catch (error) {
        if (databaseErrorCode(error) === "23505") throw new ApiError("github_installation_conflict", 409);
        throw error;
      }
    },

    async getGitHubInstallation(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ installation_id: number | string }>(
          "SELECT installation_id FROM github_installations WHERE organization_id = $1 LIMIT 1",
          [session.organizationId],
        );
        const raw = result.rows[0]?.installation_id;
        if (raw === undefined) return null;
        const installationId = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
        if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new ApiError("internal_error", 500);
        return installationId;
      });
    },

    async createProjectFromRepository(session, input) {
      validateProjectInput(input);
      try {
        return await withTenant(pool, session, async (database) => {
          const role = await currentMemberRole(database, session);
          if (!isConnectorRole(role)) throw new ApiError("forbidden", 403);
          const externalId = String(input.repositoryId);
          const existing = await database.query<{ id: string }>(
            "SELECT id FROM repositories WHERE provider = 'github' AND external_id = $1 LIMIT 1",
            [externalId],
          );
          if (existing.rows[0]) throw new ApiError("conflict", 409);
          const project = await database.query<{ id: string }>(
            `INSERT INTO projects (id, organization_id, name)
             VALUES (gen_random_uuid(), $1, $2)
             RETURNING id`,
            [session.organizationId, input.repositoryName.trim()],
          );
          const projectId = project.rows[0]?.id;
          if (!projectId) throw new ApiError("internal_error", 500);
          await database.query(
            `INSERT INTO repositories (
               id, organization_id, project_id, provider, external_id, display_name,
               github_full_name, default_branch, last_analyzed_commit_sha, analysis_report
             ) VALUES (gen_random_uuid(), $1, $2, 'github', $3, $4, $5, $6, $7, $8::jsonb)`,
            [
              session.organizationId,
              projectId,
              externalId,
              input.repositoryName.trim(),
              input.fullName,
              input.defaultBranch,
              input.commitSha,
              JSON.stringify(input.report),
            ],
          );
          return { projectId };
        });
      } catch (error) {
        if (databaseErrorCode(error) === "23505") throw new ApiError("conflict", 409);
        throw error;
      }
    },

    async getProject(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const organization = await database.query<{ id: string; name: string }>(
          "SELECT id, name FROM organizations WHERE id = $1 LIMIT 1",
          [session.organizationId],
        );
        const organizationRow = organization.rows[0];
        if (!organizationRow) throw new ApiError("not_found", 404);
        const user = await database.query<{ id: string; email: string | null }>(
          "SELECT id, email FROM users WHERE id = $1 LIMIT 1",
          [session.userId],
        );
        const userRow = user.rows[0];
        if (!userRow) throw new ApiError("auth_required", 401);
        const result = await database.query<{
          project_id: string;
          project_name: string;
          repository_id: string;
          external_id: string;
          github_full_name: string | null;
          default_branch: string | null;
          last_analyzed_commit_sha: string | null;
          analysis_report: ProjectReport | null;
        }>(
          `SELECT p.id AS project_id, p.name AS project_name,
                  r.id AS repository_id, r.external_id, r.github_full_name,
                  r.default_branch, r.last_analyzed_commit_sha, r.analysis_report
             FROM projects AS p
             JOIN repositories AS r ON r.project_id = p.id AND r.organization_id = p.organization_id
            WHERE p.id = $1 AND p.organization_id = $2
            LIMIT 1`,
          [projectId, session.organizationId],
        );
        const row = result.rows[0];
        if (!row || !row.github_full_name || !row.default_branch || !row.last_analyzed_commit_sha || !row.analysis_report) throw new ApiError("not_found", 404);
        return {
          organization: { id: organizationRow.id, name: organizationRow.name },
          user: { id: userRow.id, email: userRow.email },
          project: {
            id: row.project_id,
            name: row.project_name,
            repository: {
              id: row.repository_id,
              externalId: row.external_id,
              fullName: row.github_full_name,
              defaultBranch: row.default_branch,
              lastAnalyzedCommitSha: row.last_analyzed_commit_sha,
            },
            report: row.analysis_report,
          },
        };
      });
    },
  };
}
