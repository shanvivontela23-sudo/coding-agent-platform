import { PRODUCT_NAME } from "../src/product-config";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type LoginPageProps = {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main style={{ maxWidth: 440, margin: "64px auto", padding: 24 }}>
      <h1>{PRODUCT_NAME}</h1>
      <p>Sign in with email</p>
      {error ? (
        <p role="alert" style={{ padding: 12, border: "1px solid currentColor", borderRadius: 6 }}>
          {error}
        </p>
      ) : null}
      <form action={`${apiOrigin}/auth/email`} method="post" style={{ display: "grid", gap: 12 }}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="email" style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" style={{ display: "block", width: "100%" }} />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <hr style={{ margin: "24px 0" }} />
      <p>Developers can optionally use GitHub through Supabase Auth.</p>
      <a href={`${apiOrigin}/auth/github/start`}>Continue with GitHub</a>
    </main>
  );
}
