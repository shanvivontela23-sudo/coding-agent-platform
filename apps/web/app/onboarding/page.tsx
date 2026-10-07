import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { PRODUCT_NAME } from "../../src/product-config";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

type OnboardingPageProps = {
  readonly searchParams: Promise<{ readonly error?: string | string[] }>;
};

export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
  const params = await searchParams;
  const error = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <p className="text-caption font-semibold uppercase tracking-[0.2em] text-accent">{PRODUCT_NAME}</p>
          <h1 className="text-display font-semibold tracking-tight">Create your organization</h1>
          <p className="text-sm text-muted-foreground">Set up your workspace so your team can start turning requests into reviewed changes.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Organization details</CardTitle>
            <CardDescription>This creates your first workspace and makes you its owner.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <form action={`${apiOrigin}/onboarding/organization`} method="post" className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="organizationName" className="text-sm font-medium">Organization name</label>
                <Input
                  id="organizationName"
                  name="organizationName"
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="organization"
                  placeholder="Acme Support"
                />
              </div>
              <Button type="submit" className="w-full">Create organization</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
