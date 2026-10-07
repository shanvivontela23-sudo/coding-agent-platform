import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = {
  readonly organization: { readonly id: string; readonly name: string };
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
  const response = await fetch(`${apiOrigin}/api/home`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load your organization.");
  return await response.json() as HomePayload;
}

export default async function HomePage() {
  const home = await loadHome();

  return (
    <AppShell organizationName={home.organization.name}>
      <div className="space-y-10">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Overview</p>
          <h1 className="text-display font-semibold tracking-tight">Welcome to Dhara</h1>
          <p className="max-w-2xl text-muted-foreground">
            Start with a repository, describe the change you need, and keep developer review at the center.
          </p>
        </section>

        <section className="space-y-4" aria-labelledby="projects-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="projects-heading" className="text-heading font-semibold tracking-tight">Projects</h2>
              <p className="mt-1 text-sm text-muted-foreground">Repositories and active work will appear here.</p>
            </div>
            <Button disabled className="w-full sm:w-auto">
              Connect a repository
              <span className="rounded bg-accent-foreground/15 px-1.5 py-0.5 text-caption">Coming soon</span>
            </Button>
          </div>

          {home.projects.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="mb-4 flex size-11 items-center justify-center rounded-full bg-accent/10 text-lg font-semibold text-accent">+</div>
                <h3 className="font-semibold">No projects yet.</h3>
                <p className="mt-2 max-w-md text-sm text-muted-foreground">
                  Repository connection arrives in the next product slice. Your workspace is ready for it.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {home.projects.map((project) => (
                <Card key={project.id}>
                  <CardHeader>
                    <CardTitle>{project.name}</CardTitle>
                    <CardDescription>Connected project</CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-4" aria-labelledby="how-it-works-heading">
          <div>
            <h2 id="how-it-works-heading" className="text-heading font-semibold tracking-tight">How it works</h2>
            <p className="mt-1 text-sm text-muted-foreground">Three steps from request to reviewed code.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {howItWorks.map((step) => (
              <Card key={step.number}>
                <CardHeader>
                  <p className="text-caption font-semibold tracking-[0.16em] text-accent">{step.number}</p>
                  <CardTitle>{step.title}</CardTitle>
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
