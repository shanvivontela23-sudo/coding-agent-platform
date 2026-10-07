import { Alert, AlertDescription } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { PRODUCT_NAME } from "../src/product-config";
import { cn } from "../src/ui-utils";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type LoginPageProps = {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <p className="text-caption font-semibold uppercase tracking-[0.2em] text-accent">{PRODUCT_NAME}</p>
          <h1 className="text-display font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-muted-foreground">Turn support requests into reviewed pull requests.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in with email</CardTitle>
            <CardDescription>Use your work account to continue to your organization.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <form action={`${apiOrigin}/auth/email`} method="post" className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">Email</label>
                <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              </div>
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">Password</label>
                <Input id="password" name="password" type="password" required autoComplete="current-password" />
              </div>
              <Button type="submit" className="w-full">Sign in</Button>
            </form>

            <div className="flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-border" />
              <span className="text-caption uppercase tracking-wide text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="space-y-2">
              <a href={`${apiOrigin}/auth/github/start`} className={cn(buttonVariants({ variant: "outline" }), "w-full")}>
                Continue with GitHub
              </a>
              <p className="text-center text-caption text-muted-foreground">
                Developers can optionally use GitHub through Supabase Auth.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
