"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui/button";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";
type ThemePreference = "system" | "light" | "dark";
const themes: readonly ThemePreference[] = ["system", "light", "dark"];

function applyTheme(theme: ThemePreference): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("dhara-theme", theme);
}

function initials(userEmail: string | null): string {
  if (!userEmail) return "DU";
  const local = userEmail.split("@", 1)[0] ?? "";
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
  return local.slice(0, 2).toUpperCase() || "DU";
}

export function UserMenu({ userEmail }: { readonly userEmail: string | null }) {
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    const saved = localStorage.getItem("dhara-theme");
    if (saved === "light" || saved === "dark" || saved === "system") setTheme(saved);
  }, []);

  const chooseTheme = (next: ThemePreference) => {
    setTheme(next);
    applyTheme(next);
  };

  return (
    <details className="group relative">
      <summary
        aria-label="Account options"
        className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-input bg-card px-2 py-1.5 text-sm font-medium shadow-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-tint text-xs font-semibold text-accent" aria-hidden="true">
          {initials(userEmail)}
        </span>
        <span className="hidden max-w-52 truncate sm:inline">{userEmail ?? "Email unavailable"}</span>
      </summary>
      <div className="absolute right-0 z-30 mt-2 w-64 rounded-lg border border-border bg-card p-2 shadow-lg">
        <p className="truncate px-2 py-1 text-sm font-medium">{userEmail ?? "Email unavailable"}</p>
        <div className="my-2 border-t border-border" />
        <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Appearance</p>
        <div className="grid grid-cols-3 gap-1" aria-label="Theme preference">
          {themes.map((option) => (
            <Button
              key={option}
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={theme === option}
              onClick={() => chooseTheme(option)}
              className={theme === option ? "bg-accent-tint text-accent" : undefined}
            >
              {theme === option ? <span aria-hidden="true">✓</span> : null}
              {option === "system" ? "System" : option === "light" ? "Light" : "Dark"}
            </Button>
          ))}
        </div>
        <div className="my-2 border-t border-border" />
        <form action={`${apiOrigin}/auth/sign-out`} method="post">
          <Button type="submit" variant="ghost" className="w-full justify-start">
            Sign out
          </Button>
        </form>
      </div>
    </details>
  );
}
