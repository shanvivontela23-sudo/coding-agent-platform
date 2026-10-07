import Link from "next/link";
import type { ReactNode } from "react";
import { PRODUCT_NAME } from "../src/product-config";
import { UserMenu } from "./user-menu";

const navigation = [
  { label: "Projects", href: "/home" },
  { label: "Members", href: "/members" },
] as const;
const futureNavigation = ["Tasks", "Settings"] as const;

type AppShellProps = {
  readonly organizationName: string;
  readonly userEmail: string | null;
  readonly children: ReactNode;
};

function Navigation({ compact = false }: { readonly compact?: boolean }) {
  return (
    <nav
      aria-label="Primary navigation"
      className={compact ? "flex gap-1 overflow-x-auto border-b border-border bg-sidebar px-4 py-2 md:hidden" : "space-y-1"}
    >
      {navigation.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="block rounded-md px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent-tint hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {item.label}
        </Link>
      ))}
      {futureNavigation.map((item) => (
        <span key={item} className="block rounded-md px-3 py-2 text-sm font-medium text-muted-foreground" aria-disabled="true">
          {item}
        </span>
      ))}
    </nav>
  );
}

export function AppShell({ organizationName, userEmail, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-sidebar px-4 py-6 md:flex">
        <div className="px-3 pb-7">
          <p className="text-xl font-semibold tracking-tight">{PRODUCT_NAME}</p>
          <p className="mt-1 truncate text-sm text-muted-foreground">{organizationName}</p>
        </div>
        <Navigation />
      </aside>

      <div className="md:pl-64">
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <div className="min-w-0 md:hidden">
            <p className="truncate text-sm font-semibold">{PRODUCT_NAME}</p>
            <p className="truncate text-xs text-muted-foreground">{organizationName}</p>
          </div>
          <div className="hidden md:block" />
          <UserMenu userEmail={userEmail} />
        </header>
        <Navigation compact />
        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
