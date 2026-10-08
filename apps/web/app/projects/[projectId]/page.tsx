import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { PageTitle, SectionTitle } from "../../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = { readonly organization: { readonly name: string }; readonly user: { readonly email: string | null } };
type WorkspaceCommand = { readonly name: string; readonly path: string; readonly buildCommand: string | null; readonly testCommand: string | null };
type Report = {
  readonly languages: ReadonlyArray<{ readonly name: string; readonly fileCount: number; readonly percentage: number }>;
  readonly frameworks: readonly string[];
  readonly packageManager: string | null;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
  readonly workspaceCommands?: readonly WorkspaceCommand[];
  readonly stackSkill: string;
};
type ProjectPayload = {
  readonly project: { readonly id: string; readonly name: string };
  readonly repository: { readonly fullName: string; readonly defaultBranch: string; readonly lastAnalysedCommit: string };
  readonly report: Report;
  readonly installation: { readonly status: "connected" | "disconnected" };
};
type ProjectPageProps = { readonly params: Promise<{ readonly projectId: string }> };

async function requestHeaders(): Promise<{ cookie?: string }> {
  const store = await cookies();
  const cookie = store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  return cookie ? { cookie } : {};
}
async function loadHome(headers: { cookie?: string }): Promise<HomePayload> {
  const response = await fetch(`${apiOrigin}/api/home`, { headers, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load your organization.");
  return await response.json() as HomePayload;
}
async function loadProject(projectId: string, headers: { cookie?: string }): Promise<ProjectPayload> {
  const response = await fetch(`${apiOrigin}/api/projects/${encodeURIComponent(projectId)}`, { headers, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("Unable to load project report.");
  return await response.json() as ProjectPayload;
}

function ValueCard({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>;
}

function WorkspaceCommands({ workspaces, kind }: { readonly workspaces: readonly WorkspaceCommand[]; readonly kind: "build" | "test" }) {
  const rows = workspaces.filter((workspace) => kind === "build" ? workspace.buildCommand !== null : workspace.testCommand !== null);
  if (rows.length === 0) return <code className="text-sm">Not detected</code>;
  return (
    <ul className="space-y-3 text-sm">
      {rows.map((workspace) => {
        const command = kind === "build" ? workspace.buildCommand : workspace.testCommand;
        return (
          <li key={`${kind}:${workspace.path}`} className="space-y-1">
            <p className="font-medium">{workspace.name}</p>
            <p className="text-xs text-muted-foreground">{workspace.path}</p>
            <code>{command}</code>
          </li>
        );
      })}
    </ul>
  );
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const headers = await requestHeaders();
  const [home, project] = await Promise.all([loadHome(headers), loadProject(projectId, headers)]);
  const workspaceCommands = project.report.workspaceCommands ?? [];
  const commitUrl = `https://github.com/${project.repository.fullName}/commit/${project.repository.lastAnalysedCommit}`;
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-8">
        <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Project report</p>
            <PageTitle>{project.project.name}</PageTitle>
            <p className="text-muted-foreground">{project.repository.fullName}</p>
          </div>
          <form action={`/projects/${projectId}/tasks/new`} method="get"><Button type="submit" variant="outline">New task</Button></form>
        </section>

        {project.installation.status === "disconnected" ? (
          <Card><CardContent className="space-y-4 py-6"><div><p className="text-base font-medium">GitHub is disconnected.</p><p className="mt-1 text-sm text-muted-foreground">Reconnect the GitHub App to refresh or work with this project.</p></div><form action={`${apiOrigin}/github/connect/start`} method="get"><Button type="submit">Reconnect GitHub</Button></form></CardContent></Card>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2" aria-label="Repository details">
          <ValueCard title="Default branch"><p className="text-sm">{project.repository.defaultBranch}</p></ValueCard>
          <ValueCard title="Last analysed commit"><a className="text-sm text-accent underline underline-offset-4" href={commitUrl} target="_blank" rel="noreferrer"><code>{project.repository.lastAnalysedCommit.slice(0, 7)}</code></a></ValueCard>
        </section>

        <section className="space-y-4" aria-labelledby="analysis-heading">
          <SectionTitle id="analysis-heading">What Dhara found</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <ValueCard title="Languages">
              {project.report.languages.length ? <ul className="space-y-1 text-sm">{project.report.languages.map((language) => <li key={language.name} className="flex justify-between gap-4"><span>{language.name}</span><span className="text-muted-foreground">{language.percentage.toFixed(2)}% · {language.fileCount} files</span></li>)}</ul> : <p className="text-sm text-muted-foreground">None detected</p>}
            </ValueCard>
            <ValueCard title="Frameworks"><p className="text-sm">{project.report.frameworks.length ? project.report.frameworks.join(", ") : "None detected"}</p></ValueCard>
            <ValueCard title="Package manager"><p className="text-sm">{project.report.packageManager ?? "Not detected"}</p></ValueCard>
            <ValueCard title="Build command">{project.report.buildCommand ? <code className="text-sm">{project.report.buildCommand}</code> : <WorkspaceCommands workspaces={workspaceCommands} kind="build" />}</ValueCard>
            <ValueCard title="Test command">{project.report.testCommand ? <code className="text-sm">{project.report.testCommand}</code> : <WorkspaceCommands workspaces={workspaceCommands} kind="test" />}</ValueCard>
            <ValueCard title="Stack skill"><p className="text-sm">{project.report.stackSkill}</p></ValueCard>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
