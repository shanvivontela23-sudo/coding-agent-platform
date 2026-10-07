import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { PageTitle } from "../../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
};
type Repository = { readonly id: number; readonly name: string; readonly fullName: string; readonly defaultBranch: string; readonly private: boolean };
type PickerProps = { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> };

async function cookieHeader(): Promise<string> {
  const store = await cookies();
  return store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
}
async function loadHome(header: string): Promise<HomePayload> {
  const response = await fetch(`${apiOrigin}/api/home`, { headers: header ? { cookie: header } : {}, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load your organization.");
  return await response.json() as HomePayload;
}
async function loadRepositories(header: string): Promise<{ repositories: readonly Repository[]; disconnected: boolean }> {
  const response = await fetch(`${apiOrigin}/api/github/repositories`, { headers: header ? { cookie: header } : {}, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (response.status === 409) return { repositories: [], disconnected: true };
  if (!response.ok) throw new Error("Unable to load GitHub repositories.");
  const payload = await response.json() as { readonly repositories: readonly Repository[] };
  return { repositories: payload.repositories, disconnected: false };
}

export default async function GitHubRepositoriesPage({ searchParams }: PickerProps) {
  const params = searchParams ? await searchParams : {};
  const status = Array.isArray(params.status) ? params.status[0] : params.status;
  const errorValue = Array.isArray(params.error) ? params.error[0] : params.error;
  const header = await cookieHeader();
  const home = await loadHome(header);
  const pending = status === "pending";
  const result = pending ? { repositories: [] as readonly Repository[], disconnected: false } : await loadRepositories(header);

  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-8">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">GitHub</p>
          <PageTitle>Select a repository</PageTitle>
          <p className="text-muted-foreground">Choose a repository for Dhara to learn.</p>
        </section>

        {errorValue ? <Alert variant="destructive"><AlertDescription>{errorValue}</AlertDescription></Alert> : null}

        {pending ? (
          <Card><CardContent className="py-8"><p className="text-base font-medium">Waiting for your GitHub admin to approve.</p><p className="mt-2 text-sm text-muted-foreground">No installation is connected until GitHub approves the request.</p></CardContent></Card>
        ) : result.disconnected ? (
          <Card><CardContent className="space-y-4 py-8"><p className="text-base font-medium">GitHub needs to be reconnected.</p><form action={`${apiOrigin}/github/connect/start`} method="get"><Button type="submit">Reconnect GitHub</Button></form></CardContent></Card>
        ) : result.repositories.length === 0 ? (
          <Card><CardContent className="py-8 text-sm text-muted-foreground">No repositories are available to this installation.</CardContent></Card>
        ) : (
          <div className="grid gap-3">
            {result.repositories.map((repository) => (
              <Card key={repository.id}>
                <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="truncate text-base font-medium">{repository.fullName}</p><p className="text-sm text-muted-foreground">Default branch: {repository.defaultBranch}{repository.private ? " · Private" : ""}</p></div>
                  <form action={`${apiOrigin}/github/projects`} method="post">
                    <input type="hidden" name="repositoryId" value={repository.id} />
                    <Button type="submit" variant="outline">Select</Button>
                  </form>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
