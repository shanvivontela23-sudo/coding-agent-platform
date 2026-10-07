import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { PRODUCT_NAME } from "../../src/product-config";
import { cn } from "../../src/ui-utils";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type Invitation = {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: "developer" | "rep";
  readonly expiresAt: string;
};
type InvitesPayload = { readonly invitations: readonly Invitation[] };
type InvitesPageProps = { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> };

async function loadInvitations(): Promise<InvitesPayload> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  const response = await fetch(`${apiOrigin}/api/invitations`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load invitations.");
  return await response.json() as InvitesPayload;
}

export default async function InvitesPage({ searchParams }: InvitesPageProps) {
  const payload = await loadInvitations();
  const params = searchParams ? await searchParams : {};
  const errorValue = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="space-y-2 text-center">
          <p className="text-caption font-semibold uppercase tracking-[0.2em] text-accent">{PRODUCT_NAME}</p>
          <h1 className="text-display font-semibold tracking-tight">Organization invitation</h1>
          <p className="text-muted-foreground">Choose how you want to continue.</p>
        </div>

        {errorValue ? (
          <Alert variant="destructive">
            <AlertDescription>{errorValue}</AlertDescription>
          </Alert>
        ) : null}

        {payload.invitations.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>No active invitations</CardTitle>
              <CardDescription>You can create your own organization instead.</CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/onboarding" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>Create your own organization</Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {payload.invitations.map((invitation) => (
              <Card key={invitation.id}>
                <CardHeader>
                  <CardTitle>{invitation.organizationName}</CardTitle>
                  <CardDescription>
                    You were invited as {invitation.role === "developer" ? "Developer" : "Support rep"}.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form action={`${apiOrigin}/invitations/accept`} method="post">
                    <input type="hidden" name="invitationId" value={invitation.id} />
                    <Button type="submit" variant="outline" className="w-full">Accept invitation</Button>
                  </form>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Link href="/onboarding" className={cn(buttonVariants({ variant: "outline" }), "w-full")}>Create your own organization</Link>
          <form action={`${apiOrigin}/invitations/decline`} method="post">
            <Button type="submit" variant="outline" className="w-full">Decline</Button>
          </form>
        </div>
      </div>
    </main>
  );
}
