import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PRODUCT_NAME } from "../../src/product-config";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type SignUpPageProps = {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
};

export default async function SignUpPage({ searchParams }: SignUpPageProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <p className="text-caption font-semibold uppercase tracking-[0.2em] text-accent">{PRODUCT_NAME}</p>
          <h1 className="text-display font-semibold tracking-tight">Create your account</h1>
          <p className="text-sm text-muted-foreground">Turn support requests into reviewed pull requests.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign up with email</CardTitle>
            <CardDescription>Use your work email. If a teammate invited you, use the address they invited.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <form action={`${apiOrigin}/auth/sign-up`} method="post" className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">Email</label>
                <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@company.com" />
              </div>
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">Password</label>
                <Input id="password" name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
                <p className="text-caption text-muted-foreground">At least 8 characters.</p>
              </div>
              <div className="space-y-2">
                <label htmlFor="confirmPassword" className="text-sm font-medium">Confirm password</label>
                <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" />
              </div>
              <Button type="submit" className="w-full">Create account</Button>
            </form>

            <p className="text-center text-sm text-muted-foreground">
              Already have an account? <a href="/" className="font-medium text-foreground underline underline-offset-4">Sign in</a>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
