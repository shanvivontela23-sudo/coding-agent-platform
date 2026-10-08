import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { Card, CardContent } from "../../components/ui/card";
import { PageTitle } from "../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";
type HomePayload = { readonly organization: { readonly name: string }; readonly user: { readonly email: string | null } };
type TaskStatus = "draft" | "waiting_for_answers" | "plan_ready" | "approved";
type TaskItem = { readonly id: string; readonly projectName: string; readonly status: TaskStatus; readonly maskedTicket: string; readonly updatedAt: string };
const statusLabel: Record<TaskStatus, string> = { draft: "Draft", waiting_for_answers: "Waiting for answers", plan_ready: "Plan ready", approved: "Approved" };

async function headers(): Promise<{ cookie?: string }> {
  const store = await cookies(); const value = store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; "); return value ? { cookie: value } : {};
}
async function getJson<T>(path: string, requestHeaders: { cookie?: string }): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, { headers: requestHeaders, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load tasks.");
  return await response.json() as T;
}

export default async function TasksPage() {
  const requestHeaders = await headers();
  const [home, payload] = await Promise.all([getJson<HomePayload>("/api/home", requestHeaders), getJson<{ tasks: readonly TaskItem[] }>("/api/tasks", requestHeaders)]);
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/tasks">
      <div className="space-y-8">
        <section className="space-y-2"><p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Work</p><PageTitle>Tasks</PageTitle><p className="text-muted-foreground">Clarify requests and approve the plan before any code changes begin.</p></section>
        {payload.tasks.length === 0 ? <Card><CardContent className="py-6 text-sm text-muted-foreground">No tasks yet. Open a project and choose New task.</CardContent></Card> : (
          <div className="grid gap-3">{payload.tasks.map((task) => (
            <Link key={task.id} href={`/tasks/${task.id}`} className="rounded-lg border border-border bg-card p-5 transition-colors hover:bg-accent-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{task.projectName}</p><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{task.maskedTicket}</p></div><span className="shrink-0 text-sm font-medium">{statusLabel[task.status]}</span></div>
            </Link>
          ))}</div>
        )}
      </div>
    </AppShell>
  );
}
