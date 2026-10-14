"use client";

import { useState } from "react";

// A textarea with a live character count, so owners see how close a rule is
// to the limit while they write it.
export function RuleTextField({ id, name, defaultValue = "", maxLength }: { readonly id: string; readonly name: string; readonly defaultValue?: string; readonly maxLength: number }) {
  const [length, setLength] = useState(defaultValue.length);
  return (
    <div className="space-y-1">
      <textarea
        id={id}
        name={name}
        required
        maxLength={maxLength}
        defaultValue={defaultValue}
        rows={4}
        onChange={(event) => setLength(event.target.value.length)}
        aria-describedby={`${id}-count`}
        className="flex w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        placeholder="Every pull request adds a line to CHANGELOG.md describing the change."
      />
      <p id={`${id}-count`} className="text-xs text-muted-foreground" aria-live="polite">{length} / {maxLength} characters. Short, concrete rules work best.</p>
    </div>
  );
}
