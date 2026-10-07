import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PRODUCT_NAME } from "../../src/product-config";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type HomePayload = {
  readonly organization: { readonly id: string; readonly name: string };
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
};

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
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div>
          <p>{PRODUCT_NAME}</p>
          <h1>{home.organization.name}</h1>
        </div>
        <form action={`${apiOrigin}/auth/sign-out`} method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <section>
        <h2>Projects</h2>
        {home.projects.length === 0 ? (
          <p>No projects yet.</p>
        ) : (
          <ul>
            {home.projects.map((project) => <li key={project.id}>{project.name}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
