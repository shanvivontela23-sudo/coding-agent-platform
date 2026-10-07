import { PRODUCT_NAME } from "../../src/product-config";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type OnboardingPageProps = {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
};

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main style={{ maxWidth: 520, margin: "64px auto", padding: 24 }}>
      <p>{PRODUCT_NAME}</p>
      <h1>Create your organization</h1>
      <p>This creates your first workspace and makes you its owner.</p>
      {error ? <p role="alert">{error}</p> : null}
      <form action={`${apiOrigin}/onboarding/organization`} method="post" style={{ display: "grid", gap: 12 }}>
        <label>
          Organization name
          <input
            name="organizationName"
            required
            minLength={2}
            maxLength={80}
            autoComplete="organization"
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <button type="submit">Create organization</button>
      </form>
    </main>
  );
}
