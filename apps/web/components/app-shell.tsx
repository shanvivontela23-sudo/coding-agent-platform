import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../src/product-config";
import { Button } from "./ui/button";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";

const navigation = ["Projects", "Tasks", "Members", "Settings"] as const;

type AppShellProps = {
  readonly organizationName: string;
  readonly children: ReactNode;
};

function Navigation({ compact = false }: { readonly compact?: boolean }) {
  return (
    <nav
      aria-label="Primary navigation"
      className={compact ? "flex gap-1 overflow-x-auto px-4 py-2 md:hidden" : "space-y-1"}
    >
      {navigation.map((item, index) => (
        <div
          key={item}
          aria-current={index === 0 ? "page" : undefined}
          className={
            index === 0
              ? "rounded-md bg-accent/10 px-3 py-2 text-sm font-medium text-accent"
              : "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground"
          }
        >
          {item}
        </div>
      ))}
    </nav>
  );
}

export function AppShell({ organizationName, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-card px-4 py-6 md:flex">
        <div className="px-3 pb-7">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Workspace</p>
          <p className="mt-1 text-heading font-semibold tracking-tight">{PRODUCT_NAME}</p>
        </div>
        <Navigation />
        <p className="mt-auto px-3 text-caption text-muted-foreground">Build changes with confidence.</p>
      </aside>

      <div className="md:pl-64">
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold md:hidden">{PRODUCT_NAME}</p>
            <p className="truncate text-caption text-muted-foreground">{organizationName}</p>
          </div>
          <details className="group relative">
            <summary className="cursor-pointer list-none rounded-md border border-border bg-card px-3 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              User menu
            </summary>
            <div className="absolute right-0 mt-2 w-44 rounded-lg border border-border bg-card p-1 shadow-lg">
              <form action={`${apiOrigin}/auth/sign-out`} method="post">
                <Button type="submit" variant="ghost" className="w-full justify-start">
                  Sign out
                </Button>
              </form>
            </div>
          </details>
        </header>
        <Navigation compact />
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
