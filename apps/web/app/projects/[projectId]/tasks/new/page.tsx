import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../../../components/app-shell";
import { Alert, AlertDescription } from "../../../../../components/ui/alert";
import { Button } from "../../../../../components/ui/button";
import { Card, CardContent } from "../../../../../components/ui/card";
import { PageTitle } from "../../../../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";
type HomePayload = { readonly organization: { readonly name: string }; readonly user: { readonly email: string | null } };
type ProjectPayload = { readonly project: { readonly id: string; readonly name: string } };
type Props = { readonly params: Promise<{ readonly projectId: string }>; readonly searchParams: Promise<{ readonly error?: string }> };

async function requestHeaders(): Promise<{ cookie?: string }> {
  const store = await cookies(); const value = store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; "); return value ? { cookie: value } : {};
}
async function loadHome(headers: { cookie?: string }): Promise<HomePayload> {
  const response = await fetch(`${apiOrigin}/api/home`, { headers, cache: "no-store" }); if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue."); if (!response.ok) throw new Error("Unable to load organization."); return await response.json() as HomePayload;
}
async function loadProject(projectId: string, headers: { cookie?: string }): Promise<ProjectPayload> {
  const response = await fetch(`${apiOrigin}/api/projects/${encodeURIComponent(projectId)}`, { headers, cache: "no-store" }); if (response.status === 404) notFound(); if (!response.ok) throw new Error("Unable to load project."); return await response.json() as ProjectPayload;
}
async function loadTaskConfiguration(headers: { cookie?: string }): Promise<{ readonly planningConfigured: boolean }> {
  const response = await fetch(`${apiOrigin}/api/tasks/configuration`, { headers, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load task configuration.");
  return await response.json() as { readonly planningConfigured: boolean };
}

export default async function NewTaskPage({ params, searchParams }: Props) {
  const { projectId } = await params; const { error } = await searchParams; const headers = await requestHeaders();
  const [home, project, configuration] = await Promise.all([loadHome(headers), loadProject(projectId, headers), loadTaskConfiguration(headers)]);
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/tasks">
      <div className="mx-auto max-w-3xl space-y-8">
        <section className="space-y-2"><p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">{project.project.name}</p><PageTitle>New task</PageTitle><p className="text-muted-foreground">Paste a ticket or describe a change. English, Hindi, or mixed language is fine.</p></section>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {!configuration.planningConfigured ? (
          <Alert><AlertDescription>Task planning is not configured. Configure the task model gateway before creating a new task.</AlertDescription></Alert>
        ) : (
          <Card><CardContent className="py-6"><form action={`${apiOrigin}/projects/${projectId}/tasks`} method="post" className="space-y-4"><label className="block text-sm font-medium" htmlFor="ticket">Request</label><textarea id="ticket" name="ticket" required maxLength={50000} rows={12} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="Paste a ticket or describe a change" /><div className="flex justify-end"><Button type="submit">Continue</Button></div></form></CardContent></Card>
        )}
      </div>
    </AppShell>
  );
}
