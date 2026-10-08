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
type UploadVersion = { readonly id: string; readonly versionNumber: number; readonly sizeBytes: number; readonly fileCount: number; readonly sha256: string; readonly createdAt: string };
type ProjectPayload = {
  readonly project: { readonly id: string; readonly name: string };
  readonly source:
    | { readonly type: "github"; readonly fullName: string; readonly defaultBranch: string; readonly lastAnalysedCommit: string; readonly status: "connected" | "disconnected" }
    | { readonly type: "upload"; readonly currentVersion: UploadVersion };
  readonly report: Report;
  readonly currentUserRole?: "owner" | "developer" | "rep";
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
  const raw = await response.json() as {
    readonly project: ProjectPayload["project"];
    readonly source?: ProjectPayload["source"];
    readonly repository?: { readonly fullName: string; readonly defaultBranch: string; readonly lastAnalysedCommit: string };
    readonly installation?: { readonly status: "connected" | "disconnected" };
    readonly report: Report;
    readonly currentUserRole?: "owner" | "developer" | "rep";
  };
  if (raw.source) return { project: raw.project, source: raw.source, report: raw.report, ...(raw.currentUserRole ? { currentUserRole: raw.currentUserRole } : {}) };
  if (!raw.repository || !raw.installation) throw new Error("Project source is missing.");
  return { project: raw.project, source: { type: "github", fullName: raw.repository.fullName, defaultBranch: raw.repository.defaultBranch, lastAnalysedCommit: raw.repository.lastAnalysedCommit, status: raw.installation.status }, report: raw.report, ...(raw.currentUserRole ? { currentUserRole: raw.currentUserRole } : {}) };
}

function ValueCard({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>;
}
function WorkspaceCommands({ workspaces, kind }: { readonly workspaces: readonly WorkspaceCommand[]; readonly kind: "build" | "test" }) {
  const rows = workspaces.filter((workspace) => kind === "build" ? workspace.buildCommand !== null : workspace.testCommand !== null);
  if (rows.length === 0) return <code className="text-sm">Not detected</code>;
  return <ul className="space-y-3 text-sm">{rows.map((workspace) => { const command = kind === "build" ? workspace.buildCommand : workspace.testCommand; return <li key={`${kind}:${workspace.path}`} className="space-y-1"><p className="font-medium">{workspace.name}</p><p className="text-xs text-muted-foreground">{workspace.path}</p><code>{command}</code></li>; })}</ul>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const headers = await requestHeaders();
  const [home, project] = await Promise.all([loadHome(headers), loadProject(projectId, headers)]);
  const workspaceCommands = project.report.workspaceCommands ?? [];
  const commitUrl = project.source.type === "github" ? `https://github.com/${project.source.fullName}/commit/${project.source.lastAnalysedCommit}` : null;
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-8">
        <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Project report</p>
            <PageTitle>{project.project.name}</PageTitle>
            <p className="text-muted-foreground">Source: {project.source.type === "github" ? project.source.fullName : "Uploaded ZIP"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <form action={`${apiOrigin}/projects/${projectId}/reanalyse`} method="post"><Button type="submit">Re-analyse</Button></form>
            <form action={`/projects/${projectId}/tasks/new`} method="get"><Button type="submit" variant="outline">New task</Button></form>
          </div>
        </section>

        {project.source.type === "github" && project.source.status === "disconnected" ? (
          <Card><CardContent className="space-y-4 py-6"><div><p className="text-base font-medium">GitHub is disconnected.</p><p className="mt-1 text-sm text-muted-foreground">Reconnect the GitHub App to refresh or work with this project.</p></div><form action={`${apiOrigin}/github/connect/start`} method="get"><Button type="submit" variant="outline">Reconnect GitHub</Button></form></CardContent></Card>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2" aria-label="Repository details">
          <ValueCard title="Source"><p className="text-sm">{project.source.type === "github" ? "GitHub" : "ZIP upload"}</p></ValueCard>
          {project.source.type === "github" ? (
            <>
              <ValueCard title="Default branch"><p className="text-sm">{project.source.defaultBranch}</p></ValueCard>
              <ValueCard title="Last analysed commit"><a className="text-sm text-accent underline underline-offset-4" href={commitUrl ?? undefined} target="_blank" rel="noreferrer"><code>{project.source.lastAnalysedCommit.slice(0, 7)}</code></a></ValueCard>
            </>
          ) : (
            <>
              <ValueCard title="Current version"><p className="text-sm">Version {project.source.currentVersion.versionNumber} · {project.source.currentVersion.fileCount} files</p><p className="mt-1 text-xs text-muted-foreground"><code>{project.source.currentVersion.sha256.slice(0, 12)}</code></p></ValueCard>
              <ValueCard title="Download">
                <form action={`${apiOrigin}/projects/${projectId}/versions/${project.source.currentVersion.id}/download-token`} method="post"><Button type="submit" variant="outline">Download current ZIP</Button></form>
              </ValueCard>
            </>
          )}
        </section>

        <section className="space-y-4" aria-labelledby="analysis-heading">
          <SectionTitle id="analysis-heading">What Dhara found</SectionTitle>
          <div className="grid gap-4 md:grid-cols-2">
            <ValueCard title="Languages">{project.report.languages.length ? <ul className="space-y-1 text-sm">{project.report.languages.map((language) => <li key={language.name} className="flex justify-between gap-4"><span>{language.name}</span><span className="text-muted-foreground">{language.percentage.toFixed(2)}% · {language.fileCount} files</span></li>)}</ul> : <p className="text-sm text-muted-foreground">None detected</p>}</ValueCard>
            <ValueCard title="Frameworks"><p className="text-sm">{project.report.frameworks.length ? project.report.frameworks.join(", ") : "None detected"}</p></ValueCard>
            <ValueCard title="Package manager"><p className="text-sm">{project.report.packageManager ?? "Not detected"}</p></ValueCard>
            <ValueCard title="Build command">{project.report.buildCommand ? <code className="text-sm">{project.report.buildCommand}</code> : <WorkspaceCommands workspaces={workspaceCommands} kind="build" />}</ValueCard>
            <ValueCard title="Test command">{project.report.testCommand ? <code className="text-sm">{project.report.testCommand}</code> : <WorkspaceCommands workspaces={workspaceCommands} kind="test" />}</ValueCard>
            <ValueCard title="Stack skill"><p className="text-sm">{project.report.stackSkill}</p></ValueCard>
          </div>
        </section>

        {project.source.type === "upload" && project.currentUserRole === "owner" ? (
          <section className="border-t border-border pt-6"><form action={`${apiOrigin}/projects/${projectId}/delete`} method="post"><Button type="submit" variant="outline">Delete project</Button></form></section>
        ) : null}
      </div>
    </AppShell>
  );
}
