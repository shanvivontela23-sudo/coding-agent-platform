import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AppShell } from "../../../components/app-shell";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { PageTitle, SectionTitle } from "../../../components/ui/heading";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";
type HomePayload = { readonly organization: { readonly name: string }; readonly user: { readonly id: string; readonly email: string | null } };
type Question = { readonly id: string; readonly ordinal: number; readonly question: string; readonly suggestedAnswer: string; readonly answer: string | null; readonly answerStatus: "unanswered" | "answered" | "developer_needed"; readonly routedToUserId: string | null };
type Task = {
  readonly id: string; readonly projectId: string; readonly projectName: string; readonly status: "draft" | "waiting_for_answers" | "plan_ready" | "approved"; readonly requestedByUserId: string; readonly maskedTicket: string; readonly currentUserRole: "owner" | "developer" | "rep"; readonly originalTicket?: string;
  readonly questions: readonly Question[]; readonly whatIUnderstand: string | null; readonly proposedApproach: string | null; readonly jobSize: "small" | "medium" | "large" | null;
  readonly estimatedCostUsdMin: number | null; readonly estimatedCostUsdMax: number | null; readonly estimatedTimeMinutesMin: number | null; readonly estimatedTimeMinutesMax: number | null;
  readonly clarificationFilteredCount: number; readonly clarificationRephrasedCount: number; readonly confirmedRequirement: string | null; readonly confirmedPlan: string | null;
};
type Props = { readonly params: Promise<{ readonly taskId: string }>; readonly searchParams: Promise<{ readonly error?: string }> };
const statusLabel = { draft: "Draft", waiting_for_answers: "Waiting for answers", plan_ready: "Plan ready", approved: "Approved" } as const;

async function requestHeaders(): Promise<{ cookie?: string }> { const store = await cookies(); const value = store.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; "); return value ? { cookie: value } : {}; }
async function load<T>(path: string, headers: { cookie?: string }): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, { headers, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error("Unable to load task.");
  return await response.json() as T;
}
function money(value: number | null): string { return value === null ? "—" : `$${value.toFixed(2)}`; }

export default async function TaskPage({ params, searchParams }: Props) {
  const { taskId } = await params; const { error } = await searchParams; const headers = await requestHeaders();
  const [home, payload] = await Promise.all([load<HomePayload>("/api/home", headers), load<{ task: Task }>(`/api/tasks/${encodeURIComponent(taskId)}`, headers)]);
  const task = payload.task; const canApprove = task.status === "plan_ready" && task.requestedByUserId === home.user.id && task.currentUserRole === "rep";
  return (
    <AppShell organizationName={home.organization.name} userEmail={home.user.email} activePath="/tasks">
      <div className="space-y-8">
        <section className="space-y-2"><p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">{task.projectName} · {statusLabel[task.status]}</p><PageTitle>Task</PageTitle><p className="max-w-3xl text-muted-foreground">{task.maskedTicket}</p></section>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {task.originalTicket ? <Card><CardHeader><CardTitle>Original request</CardTitle></CardHeader><CardContent><p className="whitespace-pre-wrap text-sm">{task.originalTicket}</p><p className="mt-3 text-xs text-muted-foreground">Visible only to the requesting support rep.</p></CardContent></Card> : null}

        {task.status === "draft" ? <Card><CardContent className="py-6 text-sm text-muted-foreground">Clarification has not completed yet.</CardContent></Card> : null}

        {task.questions.length > 0 ? <section className="space-y-4" aria-labelledby="questions-heading"><SectionTitle id="questions-heading">Questions</SectionTitle>{task.questions.map((question) => {
          const canAnswer = question.answerStatus === "unanswered" ? task.requestedByUserId === home.user.id : question.answerStatus === "developer_needed" && question.routedToUserId === home.user.id;
          return <Card key={question.id}><CardContent className="space-y-4 py-5"><div><p className="font-medium">{question.question}</p><p className="mt-1 text-sm text-muted-foreground"><span className="font-medium text-foreground">Suggested answer:</span> {question.suggestedAnswer}</p></div>{question.answerStatus === "answered" ? <p className="text-sm"><span className="font-medium">Answer:</span> {question.answer}</p> : question.answerStatus === "developer_needed" && !canAnswer ? <p className="text-sm text-muted-foreground">Waiting for a developer answer.</p> : canAnswer ? <div className="space-y-3"><form action={`${apiOrigin}/tasks/${task.id}/answers`} method="post" className="flex flex-col gap-2 sm:flex-row"><input type="hidden" name="questionId" value={question.id} /><Input name="answer" aria-label={`Answer question ${question.ordinal}`} defaultValue={question.answerStatus === "developer_needed" ? "" : question.suggestedAnswer} required /><Button type="submit">Save answer</Button></form>{question.answerStatus === "unanswered" ? <form action={`${apiOrigin}/tasks/${task.id}/answers`} method="post"><input type="hidden" name="questionId" value={question.id} /><input type="hidden" name="answer" value="I don't know" /><Button type="submit" variant="outline">I don&apos;t know</Button></form> : null}</div> : null}</CardContent></Card>;
        })}</section> : null}

        {task.whatIUnderstand && task.proposedApproach ? <section className="space-y-4" aria-labelledby="plan-heading"><SectionTitle id="plan-heading">Plan</SectionTitle><form action={`${apiOrigin}/tasks/${task.id}/approve`} method="post" className="space-y-4"><Card><CardHeader><CardTitle>What I understand</CardTitle></CardHeader><CardContent>{canApprove ? <textarea name="whatIUnderstand" rows={6} defaultValue={task.whatIUnderstand} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : <p className="whitespace-pre-wrap text-sm">{task.confirmedRequirement ?? task.whatIUnderstand}</p>}</CardContent></Card><Card><CardHeader><CardTitle>Proposed approach</CardTitle></CardHeader><CardContent>{canApprove ? <textarea name="proposedApproach" rows={6} defaultValue={task.proposedApproach} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" /> : <p className="whitespace-pre-wrap text-sm">{task.confirmedPlan ?? task.proposedApproach}</p>}</CardContent></Card><div className="grid gap-4 sm:grid-cols-3"><Card><CardContent className="py-5"><p className="text-xs text-muted-foreground">Job size</p><p className="mt-1 font-medium capitalize">{task.jobSize}</p></CardContent></Card><Card><CardContent className="py-5"><p className="text-xs text-muted-foreground">Estimated cost</p><p className="mt-1 font-medium">Estimate · {money(task.estimatedCostUsdMin)}–{money(task.estimatedCostUsdMax)}</p></CardContent></Card><Card><CardContent className="py-5"><p className="text-xs text-muted-foreground">Estimated time</p><p className="mt-1 font-medium">Estimate · {task.estimatedTimeMinutesMin ?? "—"}–{task.estimatedTimeMinutesMax ?? "—"} minutes</p></CardContent></Card></div>{canApprove ? <div className="flex justify-end"><Button type="submit">Approve plan</Button></div> : null}</form></section> : null}
      </div>
    </AppShell>
  );
}
