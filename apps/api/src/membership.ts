import type { Pool } from "pg";
import type { SessionIdentity, SupabaseIdentity } from "./auth.js";

export function createMembershipResolver(pool: Pick<Pool, "query">) {
  return async (identity: SupabaseIdentity): Promise<Pick<SessionIdentity, "userId" | "organizationId">> => {
    const result = await pool.query<{ id: string; organization_id: string }>(
      `SELECT u.id, m.organization_id
         FROM users u
         JOIN organization_memberships m ON m.user_id = u.id
        WHERE u.supabase_user_id = $1
        ORDER BY m.organization_id
        LIMIT 2`,
      [identity.supabaseUserId],
    );
    if (result.rows.length === 0) throw new Error("no tenant membership is configured for this user");
    if (result.rows.length > 1) throw new Error("multiple tenant memberships require organization selection");
    return { userId: result.rows[0]!.id, organizationId: result.rows[0]!.organization_id };
  };
}
