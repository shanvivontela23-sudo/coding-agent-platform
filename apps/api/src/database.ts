import type { OnboardingIdentity, SessionIdentity, SupabaseIdentity } from "./auth.js";
import { AppError } from "./errors.js";
import type { ProjectReport } from "./repository-analysis.js";

export type QueryResult<Row> = { readonly rows: Row[] };
export type TenantQuery = <Row = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<QueryResult<Row>>;
export type TenantClient = { readonly query: TenantQuery; release(): void };
export type TenantPool = {
  connect(): Promise<TenantClient>;
  query<Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<Row>>;
};

export type VerifiedSupabaseUser = Pick<SupabaseIdentity, "supabaseUserId" | "email">;
export type MemberRole = "owner" | "developer" | "rep";
export type InviteRole = Exclude<MemberRole, "owner">;
export type Membership = { readonly userId: string; readonly organizationId: string; readonly role: MemberRole };
export type HomeProjectSource =
  | { readonly type: "github"; readonly fullName: string }
  | { readonly type: "upload"; readonly versionNumber: number };
export type HomeData = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly source: HomeProjectSource | null }>;
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
export type GitHubInstallation = { readonly installationId: number; readonly status: "connected" | "disconnected" };
export type CreateGitHubProjectInput = {
  readonly repositoryId: number;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly commitSha: string;
  readonly report: ProjectReport;
};
export type ProjectReportData = {
  readonly project: { readonly id: string; readonly name: string };
  readonly repository: {
    readonly id: string;
    readonly githubRepositoryId: number;
    readonly name: string;
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly lastAnalysedCommit: string;
  };
  readonly report: ProjectReport;
  readonly installation: GitHubInstallation;
};

export type ProductDatabase = {
  lookupMemberships(identity: VerifiedSupabaseUser): Promise<Membership[]>;
  createOrganizationWithOwner(identity: VerifiedSupabaseUser, organizationName: string): Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
  getHome(session: SessionIdentity): Promise<HomeData>;
  getMembers(session: SessionIdentity): Promise<MembersData>;
  createInvitation(session: SessionIdentity, email: string, role: InviteRole): Promise<Invitation>;
  listVerifiedInvitations(identity: OnboardingIdentity): Promise<Invitation[]>;
  acceptVerifiedInvitation(identity: OnboardingIdentity, invitationId: string): Promise<Pick<SessionIdentity, "userId" | "organizationId">>;
  getMembershipRole?(session: SessionIdentity): Promise<MemberRole>;
  createGitHubConnectionState?(session: SessionIdentity, nonceHash: string, expiresAt: Date): Promise<void>;
  consumeGitHubConnectionState?(session: SessionIdentity, nonceHash: string, now: Date): Promise<boolean>;
  bindGitHubInstallation?(session: SessionIdentity, installationId: number): Promise<void>;
  getGitHubInstallation?(session: SessionIdentity): Promise<GitHubInstallation | null>;
  markGitHubInstallationDisconnected?(session: SessionIdentity): Promise<void>;
  createGitHubProject?(session: SessionIdentity, input: CreateGitHubProjectInput): Promise<{ readonly projectId: string }>;
  getProjectReport?(session: SessionIdentity, projectId: string): Promise<ProjectReportData | null>;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(value: string, label: string): void { if (!uuidPattern.test(value)) throw new Error(`${label} must be a UUID`); }
export function assertRestrictedDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (decodeURIComponent(url.username) !== "coding_agent_api") throw new Error("DATABASE_URL must connect as the restricted coding_agent_api role");
  return value;
}
function normalizeInviteEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !email.includes("@")) throw new Error("invalid invitation email");
  return email;
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : value; }
function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

export async function withTenant<T>(pool: Pick<TenantPool, "connect">, session: Pick<SessionIdentity, "organizationId">, run: (database: Pick<TenantClient, "query">) => Promise<T>): Promise<T> {
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
  } finally { client.release(); }
}

export function createProductDatabase(pool: TenantPool): ProductDatabase {
  return {
    async lookupMemberships(identity) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{ user_id: string; organization_id: string; role: Membership["role"] }>("SELECT user_id, organization_id, role FROM public.lookup_memberships_for_supabase_user($1)", [identity.supabaseUserId]);
      return result.rows.map((row) => ({ userId: row.user_id, organizationId: row.organization_id, role: row.role }));
    },
    async createOrganizationWithOwner(identity, organizationName) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{ user_id: string; organization_id: string }>("SELECT user_id, organization_id FROM public.create_organization_with_owner($1, $2, $3)", [identity.supabaseUserId, identity.email ?? "", organizationName]);
      const row = result.rows[0];
      if (!row) throw new Error("organization onboarding returned no ids");
      return { userId: row.user_id, organizationId: row.organization_id };
    },
    async getHome(session) {
      return await withTenant(pool, session, async (database) => {
        const organization = await database.query<{ id: string; name: string }>("SELECT id, name FROM organizations ORDER BY id LIMIT 1");
        const row = organization.rows[0];
        if (!row) throw new Error("tenant organization is not visible");
        const user = await database.query<{ id: string; email: string | null }>("SELECT id, email FROM users WHERE id = $1 LIMIT 1", [session.userId]);
        const currentUser = user.rows[0];
        if (!currentUser) throw new Error("tenant user is not visible");
        const projects = await database.query<{ id: string; name: string; provider: string | null; full_name: string | null; version_number: number | null }>(`SELECT p.id,p.name,r.provider,r.full_name,pv.version_number FROM projects p LEFT JOIN LATERAL (SELECT provider,full_name FROM repositories WHERE organization_id=p.organization_id AND project_id=p.id ORDER BY created_at,id LIMIT 1) r ON true LEFT JOIN LATERAL (SELECT version_number FROM project_versions WHERE organization_id=p.organization_id AND project_id=p.id ORDER BY version_number DESC LIMIT 1) pv ON r.provider='upload' ORDER BY p.created_at,p.id`);
        return {
          organization: { id: row.id, name: row.name },
          user: { id: currentUser.id, email: currentUser.email },
          projects: projects.rows.map((project) => {
            const source: HomeProjectSource | null = project.provider === "github" && project.full_name
              ? { type: "github", fullName: project.full_name }
              : project.provider === "upload" && project.version_number !== null
                ? { type: "upload", versionNumber: project.version_number }
                : null;
            return { id: project.id, name: project.name, source };
          }),
        };
      });
    },
    async getMembers(session) {
      return await withTenant(pool, session, async (database) => {
        const organization = await database.query<{ id: string; name: string }>("SELECT id, name FROM organizations ORDER BY id LIMIT 1");
        const organizationRow = organization.rows[0];
        if (!organizationRow) throw new Error("tenant organization is not visible");
        const current = await database.query<{ id: string; email: string | null; role: MemberRole }>(`SELECT u.id, u.email, m.role FROM organization_memberships AS m JOIN users AS u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.user_id = $2 LIMIT 1`, [session.organizationId, session.userId]);
        const currentUser = current.rows[0];
        if (!currentUser) throw new Error("tenant membership is not visible");
        const members = await database.query<{ id: string; email: string | null; role: MemberRole }>(`SELECT u.id, u.email, m.role FROM organization_memberships AS m JOIN users AS u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.created_at, u.id`, [session.organizationId]);
        const invitations = await database.query<{ id: string; email: string; role: InviteRole; expires_at: Date | string }>(`SELECT id, email, role, expires_at FROM organization_invitations WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at, id`, [session.organizationId]);
        return { organization: { id: organizationRow.id, name: organizationRow.name }, currentUser, members: members.rows, invitations: invitations.rows.map((invite) => ({ id: invite.id, email: invite.email, role: invite.role, expiresAt: iso(invite.expires_at) })) };
      });
    },
    async createInvitation(session, emailValue, role) {
      if (role !== "developer" && role !== "rep") throw new Error("invalid invitation role");
      const email = normalizeInviteEmail(emailValue);
      return await withTenant(pool, session, async (database) => {
        const owner = await database.query<{ role: MemberRole }>("SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 LIMIT 1", [session.organizationId, session.userId]);
        if (owner.rows[0]?.role !== "owner") throw new Error("only organization owners can invite members");
        const result = await database.query<{ id: string; email: string; role: InviteRole; expires_at: Date | string }>(`INSERT INTO organization_invitations (id, organization_id, email, role, invited_by_user_id) VALUES (gen_random_uuid(), $1, $2, $3, $4) ON CONFLICT (organization_id, (lower(btrim(email)))) WHERE accepted_at IS NULL DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id, created_at = now(), expires_at = now() + interval '7 days' RETURNING id, email, role, expires_at`, [session.organizationId, email, role, session.userId]);
        const row = result.rows[0];
        if (!row) throw new Error("invitation creation returned no invitation");
        const organization = await database.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1 LIMIT 1", [session.organizationId]);
        const organizationName = organization.rows[0]?.name;
        if (!organizationName) throw new Error("tenant organization is not visible");
        return { id: row.id, organizationId: session.organizationId, organizationName, email: row.email, role: row.role, expiresAt: iso(row.expires_at) };
      });
    },
    async listVerifiedInvitations(identity) {
      assertUuid(identity.supabaseUserId, "supabaseUserId");
      const result = await pool.query<{ invitation_id: string; organization_id: string; organization_name: string; email: string; role: InviteRole; expires_at: Date | string }>("SELECT invitation_id, organization_id, organization_name, email, role, expires_at FROM public.list_invitations_for_verified_email($1, $2, $3)", [identity.supabaseUserId, identity.email ?? "", identity.emailConfirmed === true]);
      return result.rows.map((row) => ({ id: row.invitation_id, organizationId: row.organization_id, organizationName: row.organization_name, email: row.email, role: row.role, expiresAt: iso(row.expires_at) }));
    },
    async acceptVerifiedInvitation(identity, invitationId) {
      assertUuid(identity.supabaseUserId, "supabaseUserId"); assertUuid(invitationId, "invitationId");
      const result = await pool.query<{ user_id: string; organization_id: string }>("SELECT user_id, organization_id FROM public.accept_invitation_for_verified_email($1, $2, $3, $4)", [identity.supabaseUserId, identity.email ?? "", identity.emailConfirmed === true, invitationId]);
      const row = result.rows[0];
      if (!row) throw new Error("invitation acceptance returned no membership");
      return { userId: row.user_id, organizationId: row.organization_id };
    },
    async getMembershipRole(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ role: MemberRole }>("SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 LIMIT 1", [session.organizationId, session.userId]);
        const role = result.rows[0]?.role;
        if (!role) throw new AppError("AUTH_REQUIRED", "Authentication required.", 401);
        return role;
      });
    },
    async createGitHubConnectionState(session, nonceHash, expiresAt) {
      if (!/^[0-9a-f]{64}$/.test(nonceHash)) throw new AppError("GITHUB_STATE_INVALID", "GitHub connection state is invalid.", 400);
      await withTenant(pool, session, async (database) => {
        await database.query("INSERT INTO github_connection_states (nonce_hash, organization_id, user_id, expires_at) VALUES ($1,$2,$3,$4)", [nonceHash, session.organizationId, session.userId, expiresAt]);
      });
    },
    async consumeGitHubConnectionState(session, nonceHash, now) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ nonce_hash: string }>("UPDATE github_connection_states SET consumed_at=$4 WHERE nonce_hash=$1 AND organization_id=$2 AND user_id=$3 AND consumed_at IS NULL AND expires_at > $4 RETURNING nonce_hash", [nonceHash, session.organizationId, session.userId, now]);
        return result.rows.length === 1;
      });
    },
    async bindGitHubInstallation(session, installationId) {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new AppError("GITHUB_INSTALLATION_FORBIDDEN", "GitHub installation could not be verified.", 403);
      try {
        await withTenant(pool, session, async (database) => {
          await database.query(`INSERT INTO github_installations (organization_id, installation_id, connected_by_user_id, status) VALUES ($1,$2,$3,'connected') ON CONFLICT (organization_id) DO UPDATE SET installation_id=EXCLUDED.installation_id, connected_by_user_id=EXCLUDED.connected_by_user_id, status='connected', updated_at=now()`, [session.organizationId, installationId, session.userId]);
        });
      } catch (error) {
        if (pgCode(error) === "23505") throw new AppError("GITHUB_INSTALLATION_BOUND", "That GitHub installation is already connected to another Dhara organization.", 409);
        throw error;
      }
    },
    async getGitHubInstallation(session) {
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{ installation_id: string | number; status: "connected" | "disconnected" }>("SELECT installation_id, status FROM github_installations WHERE organization_id=$1 LIMIT 1", [session.organizationId]);
        const row = result.rows[0];
        return row ? { installationId: Number(row.installation_id), status: row.status } : null;
      });
    },
    async markGitHubInstallationDisconnected(session) {
      await withTenant(pool, session, async (database) => { await database.query("UPDATE github_installations SET status='disconnected', updated_at=now() WHERE organization_id=$1", [session.organizationId]); });
    },
    async createGitHubProject(session, input) {
      if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !/^[0-9a-f]{40}$/.test(input.commitSha)) throw new AppError("GITHUB_REPOSITORY_FORBIDDEN", "Repository metadata is invalid.", 400);
      return await withTenant(pool, session, async (database) => {
        const existing = await database.query<{ project_id: string }>("SELECT project_id FROM repositories WHERE organization_id=$1 AND github_repository_id=$2 LIMIT 1", [session.organizationId, input.repositoryId]);
        let projectId = existing.rows[0]?.project_id;
        if (!projectId) {
          const project = await database.query<{ id: string }>("INSERT INTO projects (id, organization_id, name) VALUES (gen_random_uuid(),$1,$2) RETURNING id", [session.organizationId, input.name]);
          projectId = project.rows[0]?.id;
          if (!projectId) throw new Error("project creation returned no id");
          await database.query(`INSERT INTO repositories (id, organization_id, project_id, provider, external_id, display_name, github_repository_id, full_name, default_branch, last_analysed_commit) VALUES (gen_random_uuid(),$1,$2,'github',$3,$4,$5,$6,$7,$8)`, [session.organizationId, projectId, String(input.repositoryId), input.name, input.repositoryId, input.fullName, input.defaultBranch, input.commitSha]);
        } else {
          await database.query("UPDATE projects SET name=$3 WHERE organization_id=$1 AND id=$2", [session.organizationId, projectId, input.name]);
          await database.query("UPDATE repositories SET display_name=$3, full_name=$4, default_branch=$5, last_analysed_commit=$6 WHERE organization_id=$1 AND project_id=$2", [session.organizationId, projectId, input.name, input.fullName, input.defaultBranch, input.commitSha]);
        }
        await database.query(`INSERT INTO project_reports (organization_id, project_id, report, analysed_commit) VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT (organization_id, project_id) DO UPDATE SET report=EXCLUDED.report, analysed_commit=EXCLUDED.analysed_commit, analysed_at=now()`, [session.organizationId, projectId, JSON.stringify(input.report), input.commitSha]);
        return { projectId };
      });
    },
    async getProjectReport(session, projectId) {
      assertUuid(projectId, "projectId");
      return await withTenant(pool, session, async (database) => {
        const result = await database.query<{
          project_id: string; project_name: string; repository_id: string; github_repository_id: string | number; display_name: string; full_name: string; default_branch: string; last_analysed_commit: string; report: ProjectReport; installation_id: string | number; installation_status: "connected" | "disconnected";
        }>(`SELECT p.id AS project_id, p.name AS project_name, r.id AS repository_id, r.github_repository_id, r.display_name, r.full_name, r.default_branch, r.last_analysed_commit, pr.report, gi.installation_id, gi.status AS installation_status FROM projects p JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id JOIN project_reports pr ON pr.organization_id=p.organization_id AND pr.project_id=p.id LEFT JOIN github_installations gi ON gi.organization_id=p.organization_id WHERE p.organization_id=$1 AND p.id=$2 LIMIT 1`, [session.organizationId, projectId]);
        const row = result.rows[0];
        if (!row || !row.installation_id) return null;
        return {
          project: { id: row.project_id, name: row.project_name },
          repository: { id: row.repository_id, githubRepositoryId: Number(row.github_repository_id), name: row.display_name, fullName: row.full_name, defaultBranch: row.default_branch, lastAnalysedCommit: row.last_analysed_commit },
          report: row.report,
          installation: { installationId: Number(row.installation_id), status: row.installation_status },
        };
      });
    },
  };
}
