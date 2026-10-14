import { stackBadgeModel, type StackReportFields } from "../src/stack-badge";

// A disclosure rather than a hover tooltip, so the command list works with a
// keyboard, a screen reader and touch, and without JavaScript.
export function StackSkillBadge({ report }: { readonly report: StackReportFields }) {
  const model = stackBadgeModel(report);
  if (model.kind === "generic") return <p className="text-sm text-muted-foreground">{model.message}</p>;
  return (
    <details className="group text-sm">
      <summary className="inline-flex cursor-pointer items-center rounded-full border border-border px-3 py-1 font-medium text-foreground">{model.label}</summary>
      {model.commands.length > 0 ? (
        <ul className="mt-2 space-y-1" aria-label="Commands Dhara will use">
          {model.commands.map((item) => (
            <li key={item.role} className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground">{item.role}:</span>
              <code>{item.command}</code>
              {item.source ? <span className="text-xs text-muted-foreground">({item.source === "repo" ? "from your project" : "stack default"})</span> : null}
            </li>
          ))}
        </ul>
      ) : <p className="mt-2 text-muted-foreground">No commands detected yet.</p>}
    </details>
  );
}
