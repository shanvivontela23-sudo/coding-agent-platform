import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PageTitle, SectionTitle } from "../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly email: string | null };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

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

export default async function HomePage() {
  const home = await loadHome();
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/home">
      <div className="space-y-10">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Overview</p>
          <PageTitle>Welcome to Dhara</PageTitle>
          <p className="max-w-2xl text-muted-foreground">Start with a repository, describe the change you need, and keep developer review at the center.</p>
        </section>

        <section className="space-y-4" aria-labelledby="projects-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <SectionTitle id="projects-heading">Projects</SectionTitle>
              <p className="mt-1 text-sm text-muted-foreground">GitHub repositories and ZIP projects appear here.</p>
            </div>
            <form action={`${apiOrigin}/github/connect/start`} method="get" className="w-full sm:w-auto">
              <Button type="submit" className="w-full sm:w-auto">Connect a repository</Button>
            </form>
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
                      <CardDescription>Project</CardDescription>
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
