import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { SectionTitle } from "./ui/heading";

export type ProjectDecisionView = {
  readonly id: string;
  readonly taskId: string | null;
  readonly kind: "command_worked" | "command_failed" | "convention" | "reviewer_accepted" | "reviewer_rejected" | "rep_preference";
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly source: "verification" | "publication" | "zip_promotion" | "plan_review";
  readonly createdAt: string;
};

const kindLabel: Record<ProjectDecisionView["kind"], string> = {
  command_worked: "Command worked",
  command_failed: "Command failed",
  convention: "Convention",
  reviewer_accepted: "Accepted outcome",
  reviewer_rejected: "Rejected outcome",
  rep_preference: "Requester preference",
};
const sourceLabel: Record<ProjectDecisionView["source"], string> = {
  verification: "Verification",
  publication: "GitHub publication",
  zip_promotion: "ZIP promotion",
  plan_review: "Plan review",
};

export function ProjectDecisions({ projectId, decisions, currentUserRole, apiOrigin }: { readonly projectId: string; readonly decisions: readonly ProjectDecisionView[]; readonly currentUserRole: "owner" | "developer" | "rep"; readonly apiOrigin: string }) {
  return (
    <section className="space-y-4" aria-labelledby="project-decisions-heading">
      <div className="space-y-1"><SectionTitle id="project-decisions-heading">What Dhara learned</SectionTitle><p className="text-sm text-muted-foreground">Verified project facts and explicit review outcomes from earlier tasks. Current repository evidence always wins.</p></div>
      {decisions.length === 0 ? <Card><CardContent className="py-6 text-sm text-muted-foreground">No project learning yet.</CardContent></Card> : (
        <div className="grid gap-4">
          {decisions.map((decision) => <Card key={decision.id}><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><CardTitle>{kindLabel[decision.kind]}</CardTitle><p className="text-xs text-muted-foreground">{sourceLabel[decision.source]} · <time dateTime={decision.createdAt}>{new Date(decision.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</time></p></div>{currentUserRole === "owner" ? <form action={`${apiOrigin}/projects/${projectId}/decisions/${decision.id}/supersede`} method="post"><Button type="submit" variant="outline">Mark as wrong</Button></form> : null}</div></CardHeader><CardContent className="space-y-2"><p className="text-sm">{decision.summary}</p>{typeof decision.detail.reason === "string" ? <p className="text-sm text-muted-foreground">Reason: {decision.detail.reason}</p> : null}{decision.taskId ? <a className="text-sm font-medium text-accent underline underline-offset-4" href={`/tasks/${decision.taskId}`}>View source task</a> : null}</CardContent></Card>)}
        </div>
      )}
    </section>
  );
}
