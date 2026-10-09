import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PageTitle, SectionTitle } from "../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomeProjectSource =
  | { readonly type: "github"; readonly fullName: string; readonly defaultBranch: string }
  | { readonly type: "upload"; readonly versionNumber: number };
type HomeGitHubState =
  | { readonly status: "connected"; readonly accountLogin: string; readonly managementUrl: string }
  | { readonly status: "unknown"; readonly accountLogin: string | null; readonly managementUrl: null }
  | { readonly status: "disconnected"; readonly accountLogin: null; readonly managementUrl: null }
  | null;
type HomePayload = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly source: HomeProjectSource | null }>;
  readonly github: HomeGitHubState;
};
type HomePageProps = { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> };

const howItWorks = [
  { number: "01", title: "Connect a repo", description: "Choose the codebase Dhara should understand and work in." },
  { number: "02", title: "Describe a change", description: "Explain the outcome you need in the same language you use with your team." },
  { number: "03", title: "Review the pull request", description: "Inspect the tested change and keep developer review in control." },
] as const;

async function loadHome(): Promise<HomePayload> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  const response = await fetch(`${apiOrigin}/api/home`, { headers: cookieHeader ? { cookie: cookieHeader } : {}, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load your organization.");
  return await response.json() as HomePayload;
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0 fill-current">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.2c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.39.97.1-.75.4-1.27.74-1.56-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.08-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.75 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.82 1.19 3.08 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const home = await loadHome();
  const params = searchParams ? await searchParams : {};
  const errorValue = Array.isArray(params.error) ? params.error[0] : params.error;
  const githubAvailable = home.github?.status === "connected" || home.github?.status === "unknown";
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-10">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Overview</p>
          <PageTitle>Welcome to Dhara</PageTitle>
          <p className="max-w-2xl text-muted-foreground">Start with a repository, describe the change you need, and keep developer review at the center.</p>
        </section>

        {errorValue ? <Alert variant="destructive"><AlertDescription>{errorValue}</AlertDescription></Alert> : null}

        <section className="space-y-4" aria-labelledby="projects-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionTitle id="projects-heading">Projects</SectionTitle>
              <p className="mt-1 text-sm text-muted-foreground">GitHub repositories and ZIP projects appear here.</p>
            </div>
            {githubAvailable ? (
              <div className="flex flex-col gap-2 sm:items-end">
                <Link href="/github/repositories" className={buttonVariants()}>Add a repository</Link>
                {home.github.status === "connected" ? (
                  <p className="text-sm text-muted-foreground">
                    Connected to GitHub as <span className="font-medium text-foreground">{home.github.accountLogin}</span>{" "}
                    <a href={home.github.managementUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-4">Manage access</a>
                  </p>
                ) : (
                  <div className="text-right text-sm text-muted-foreground">
                    {home.github.accountLogin ? <p>Connected to GitHub as <span className="font-medium text-foreground">{home.github.accountLogin}</span></p> : null}
                    <p className="text-xs">Could not check GitHub right now</p>
                  </div>
                )}
              </div>
            ) : (
              <form action={`${apiOrigin}/github/connect/start`} method="get" className="w-full sm:w-auto">
                <Button type="submit" className="w-full sm:w-auto">Connect a repository</Button>
              </form>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base font-medium">Upload ZIP</CardTitle>
              <CardDescription>Create a project from a ZIP archive when GitHub is not the source.</CardDescription>
            </CardHeader>
            <CardContent>
              <form action={`${apiOrigin}/projects/upload`} method="post" encType="multipart/form-data" className="grid gap-3 md:grid-cols-[1fr_1.4fr_auto] md:items-end">
                <label className="grid gap-1 text-sm font-medium">Project name<Input name="name" required maxLength={120} /></label>
                <label className="grid gap-1 text-sm font-medium">ZIP archive<Input name="zip" type="file" accept=".zip,application/zip" required /></label>
                <Button type="submit" variant="outline">Upload ZIP</Button>
              </form>
            </CardContent>
          </Card>

          {home.projects.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-accent-tint text-lg font-semibold text-accent" aria-hidden="true">+</div>
                <h3 className="text-base font-semibold">No projects yet. Connect a repository or upload a ZIP to get started.</h3>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {home.projects.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Card className="h-full transition-colors hover:bg-muted/50">
                    <CardHeader>
                      <CardTitle className="text-base font-medium">{project.name}</CardTitle>
                      {project.source?.type === "github" ? (
                        <CardDescription className="space-y-1">
                          <span className="flex items-center gap-1.5 text-foreground"><GitHubMark />{project.source.fullName}</span>
                          <span className="block">Default branch: {project.source.defaultBranch}</span>
                        </CardDescription>
                      ) : project.source?.type === "upload" ? (
                        <CardDescription>ZIP upload · Version {project.source.versionNumber}</CardDescription>
                      ) : (
                        <CardDescription>Source unavailable</CardDescription>
                      )}
                    </CardHeader>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4" aria-labelledby="how-it-works-heading">
          <div>
            <SectionTitle id="how-it-works-heading">How it works</SectionTitle>
            <p className="mt-1 text-sm text-muted-foreground">Three steps from request to reviewed code.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {howItWorks.map((step) => (
              <Card key={step.number}>
                <CardHeader>
                  <p className="text-caption font-semibold tracking-[0.16em] text-accent">{step.number}</p>
                  <CardTitle className="text-base font-medium">{step.title}</CardTitle>
                  <CardDescription>{step.description}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
