import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = { readonly organization: { readonly name: string }; readonly user: { readonly email: string | null } };
type Report = {
  readonly languages: ReadonlyArray<{ readonly name: string; readonly fileCount: number; readonly percentage: number }>;
  readonly frameworks: readonly string[];
  readonly packageManager: string | null;
  readonly buildCommand: string | null;
  readonly testCommand: string | null;
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
  return <Card><CardHeader><CardTitle className="text-base font-medium">{title}</CardTitle></CardHeader><CardContent>{children}</CardContent></Card>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const headers = await requestHeaders();
  const [home, project] = await Promise.all([loadHome(headers), loadProject(projectId, headers)]);
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-8">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Project report</p>
          <h1 className="text-2xl font-semibold tracking-tight">{project.project.name}</h1>
          <p className="text-muted-foreground">{project.repository.fullName}</p>
        </section>

        {project.installation.status === "disconnected" ? (
          <Card><CardContent className="space-y-4 py-6"><div><p className="text-base font-medium">GitHub is disconnected.</p><p className="mt-1 text-sm text-muted-foreground">Reconnect the GitHub App to refresh or work with this project.</p></div><form action={`${apiOrigin}/github/connect/start`} method="get"><Button type="submit">Reconnect GitHub</Button></form></CardContent></Card>
        ) : null}

        <section className="grid gap-4 md:grid-cols-2" aria-label="Repository details">
          <ValueCard title="Default branch"><p className="text-sm">{project.repository.defaultBranch}</p></ValueCard>
          <ValueCard title="Last analysed commit"><code className="break-all text-sm">{project.repository.lastAnalysedCommit}</code></ValueCard>
        </section>

        <section className="space-y-4" aria-labelledby="analysis-heading">
          <h2 id="analysis-heading" className="text-lg font-semibold tracking-tight">Deterministic analysis</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <ValueCard title="Languages">
              {project.report.languages.length ? <ul className="space-y-1 text-sm">{project.report.languages.map((language) => <li key={language.name} className="flex justify-between gap-4"><span>{language.name}</span><span className="text-muted-foreground">{language.percentage.toFixed(2)}% · {language.fileCount} files</span></li>)}</ul> : <p className="text-sm text-muted-foreground">None detected</p>}
            </ValueCard>
            <ValueCard title="Frameworks"><p className="text-sm">{project.report.frameworks.length ? project.report.frameworks.join(", ") : "None detected"}</p></ValueCard>
            <ValueCard title="Package manager"><p className="text-sm">{project.report.packageManager ?? "Not detected"}</p></ValueCard>
            <ValueCard title="Build command"><code className="text-sm">{project.report.buildCommand ?? "Not detected"}</code></ValueCard>
            <ValueCard title="Test command"><code className="text-sm">{project.report.testCommand ?? "Not detected"}</code></ValueCard>
            <ValueCard title="Stack skill"><p className="text-sm">{project.report.stackSkill}</p></ValueCard>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
