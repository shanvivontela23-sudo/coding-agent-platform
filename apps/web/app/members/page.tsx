import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type Role = "owner" | "developer" | "rep";
type MembersPayload = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly currentUser: { readonly id: string; readonly email: string | null; readonly role: Role };
  readonly members: ReadonlyArray<{ readonly id: string; readonly email: string | null; readonly role: Role }>;
  readonly invitations: ReadonlyArray<{ readonly id: string; readonly email: string; readonly role: "developer" | "rep"; readonly expiresAt: string }>;
};

type MembersPageProps = { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> };

function roleLabel(role: Role): string {
  if (role === "owner") return "Owner";
  if (role === "developer") return "Developer";
  return "Support rep";
}

async function loadMembers(): Promise<MembersPayload> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  const response = await fetch(`${apiOrigin}/api/members`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load members.");
  return await response.json() as MembersPayload;
}

export default async function MembersPage({ searchParams }: MembersPageProps) {
  const members = await loadMembers();
  const params = searchParams ? await searchParams : {};
  const errorValue = Array.isArray(params.error) ? params.error[0] : params.error;
  const canInvite = members.currentUser.role === "owner";

  return (
    <AppShell organizationName={members.organization.name} userEmail={members.currentUser.email}>
      <div className="space-y-8">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Team</p>
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="text-muted-foreground">Manage who can work in {members.organization.name}.</p>
        </section>

        {errorValue ? (
          <Alert variant="destructive">
            <AlertDescription>{errorValue}</AlertDescription>
          </Alert>
        ) : null}

        <section className="space-y-4" aria-labelledby="invite-heading">
          <h2 id="invite-heading" className="text-lg font-semibold tracking-tight">Invite member</h2>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Send an invitation</CardTitle>
              <CardDescription>Invitations expire after seven days.</CardDescription>
            </CardHeader>
            <CardContent>
              {canInvite ? (
                <form action={`${apiOrigin}/members/invitations`} method="post" className="grid gap-4 md:grid-cols-[1fr_12rem_auto] md:items-end">
                  <div className="space-y-2">
                    <label htmlFor="invite-email" className="text-sm font-medium">Email</label>
                    <Input id="invite-email" name="email" type="email" autoComplete="email" required placeholder="teammate@example.com" />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="invite-role" className="text-sm font-medium">Role</label>
                    <select
                      id="invite-role"
                      name="role"
                      defaultValue="developer"
                      className="flex h-10 w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <option value="developer">Developer</option>
                      <option value="rep">Support rep</option>
                    </select>
                  </div>
                  <Button type="submit">Invite member</Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">Only organization owners can send invitations.</p>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="space-y-4" aria-labelledby="current-members-heading">
          <h2 id="current-members-heading" className="text-lg font-semibold tracking-tight">Current members</h2>
          <div className="grid gap-3">
            {members.members.map((member) => (
              <Card key={member.id}>
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold">{member.email ?? "Email unavailable"}</p>
                    <p className="text-sm text-muted-foreground">{roleLabel(member.role)}</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-sm text-success"><span aria-hidden="true">✓</span> Active</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="pending-heading">
          <h2 id="pending-heading" className="text-lg font-semibold tracking-tight">Pending invitations</h2>
          {members.invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invitations.</p>
          ) : (
            <div className="grid gap-3">
              {members.invitations.map((invite) => (
                <Card key={invite.id}>
                  <CardContent className="flex items-center justify-between gap-4 py-4">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold">{invite.email}</p>
                      <p className="text-sm text-muted-foreground">{roleLabel(invite.role)}</p>
                    </div>
                    <span className="inline-flex items-center gap-1.5 text-sm text-warning"><span aria-hidden="true">○</span> Pending</span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
