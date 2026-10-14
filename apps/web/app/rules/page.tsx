import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../components/app-shell";
import { RuleTextField } from "../../components/rule-text-field";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { PageTitle, SectionTitle } from "../../components/ui/heading";
import { Input } from "../../components/ui/input";
import { promptBudgetMessage, ruleStacksLabel, type RuleView, type StackOption } from "../../src/organization-rules";

const apiOrigin = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:3001";
type RulesPayload = {
  readonly organization: { readonly name: string };
  readonly currentUser: { readonly email: string | null; readonly role: "owner" | "developer" | "rep" };
  readonly rules: readonly RuleView[];
  readonly stacks: readonly StackOption[];
  readonly limits: { readonly titleMaxChars: number; readonly bodyMaxChars: number; readonly promptMaxChars: number; readonly enabledChars: number };
};
type RulesPageProps = { readonly searchParams?: Promise<Record<string, string | string[] | undefined>> };

async function loadRules(): Promise<RulesPayload> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join("; ");
  const response = await fetch(`${apiOrigin}/api/organization/rules`, { headers: cookieHeader ? { cookie: cookieHeader } : {}, cache: "no-store" });
  if (response.status === 401) redirect("/?error=Please%20sign%20in%20to%20continue.");
  if (!response.ok) throw new Error("Unable to load coding rules.");
  return await response.json() as RulesPayload;
}

function StackChoices({ stacks, selected, idPrefix }: { readonly stacks: readonly StackOption[]; readonly selected: readonly string[] | null; readonly idPrefix: string }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Applies to</legend>
      <p className="text-xs text-muted-foreground">Leave all unchecked to apply the rule to every project.</p>
      <div className="flex flex-wrap gap-4">
        {stacks.map((stack) => (
          <label key={stack.id} htmlFor={`${idPrefix}-${stack.id}`} className="flex items-center gap-2 text-sm">
            <input id={`${idPrefix}-${stack.id}`} type="checkbox" name="stacks" value={stack.id} defaultChecked={selected?.includes(stack.id) ?? false} />
            {stack.displayName}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default async function RulesPage({ searchParams }: RulesPageProps) {
  const data = await loadRules();
  const params = searchParams ? await searchParams : {};
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  const notice = Array.isArray(params.notice) ? params.notice[0] : params.notice;
  const isOwner = data.currentUser.role === "owner";
  const budget = promptBudgetMessage(data.limits.enabledChars, data.limits.promptMaxChars);
  return (
    <AppShell organizationName={data.organization.name} userEmail={data.currentUser.email} activePath="/rules">
      <div className="space-y-8">
        <section className="space-y-2">
          <p className="text-caption font-semibold uppercase tracking-[0.18em] text-accent">Organization</p>
          <PageTitle>Coding rules</PageTitle>
          <p className="max-w-3xl text-muted-foreground">Rules your team writes once and Dhara follows on every task, for example &ldquo;Every pull request updates CHANGELOG.md&rdquo;. Dhara follows them when they fit the approved plan; they never override safety checks. Each change lists the rules it applied.</p>
        </section>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {notice ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {data.rules.length > 0 ? <Alert variant={budget.over ? "destructive" : "default"}><AlertDescription>{budget.text}</AlertDescription></Alert> : null}

        {isOwner ? (
          <section className="space-y-4" aria-labelledby="add-rule-heading">
            <SectionTitle id="add-rule-heading">Add a rule</SectionTitle>
            <Card>
              <CardContent className="pt-6">
                <form action={`${apiOrigin}/organization/rules`} method="post" className="space-y-4">
                  <div className="space-y-2"><label htmlFor="rule-title" className="text-sm font-medium">Title</label><Input id="rule-title" name="title" required maxLength={data.limits.titleMaxChars} placeholder="Update the changelog" /></div>
                  <div className="space-y-2"><label htmlFor="rule-body" className="text-sm font-medium">Rule</label><RuleTextField id="rule-body" name="body" maxLength={data.limits.bodyMaxChars} /></div>
                  <StackChoices stacks={data.stacks} selected={null} idPrefix="new" />
                  <Button type="submit">Add rule</Button>
                </form>
              </CardContent>
            </Card>
          </section>
        ) : <p className="text-sm text-muted-foreground">Only an organization owner can add or change rules.</p>}

        <section className="space-y-4" aria-labelledby="rules-heading">
          <SectionTitle id="rules-heading">Current rules</SectionTitle>
          {data.rules.length === 0 ? <Card><CardContent className="py-6 text-sm text-muted-foreground">No rules yet. Dhara follows each project&apos;s own conventions.</CardContent></Card> : (
            <div className="grid gap-4">
              {data.rules.map((rule) => (
                <Card key={rule.id}>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1"><CardTitle>{rule.title}</CardTitle><CardDescription>{ruleStacksLabel(rule, data.stacks)} · {rule.enabled ? "On" : "Off"}</CardDescription></div>
                      {isOwner ? (
                        <div className="flex gap-2">
                          <form action={`${apiOrigin}/organization/rules/${rule.id}/${rule.enabled ? "disable" : "enable"}`} method="post"><Button type="submit" variant="outline">{rule.enabled ? "Turn off" : "Turn on"}</Button></form>
                          <form action={`${apiOrigin}/organization/rules/${rule.id}/delete`} method="post"><Button type="submit" variant="outline">Delete</Button></form>
                        </div>
                      ) : null}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="whitespace-pre-wrap text-sm">{rule.body}</p>
                    {isOwner ? (
                      <details>
                        <summary className="cursor-pointer text-sm font-medium">Edit rule</summary>
                        <form action={`${apiOrigin}/organization/rules/${rule.id}/update`} method="post" className="mt-4 space-y-4">
                          <div className="space-y-2"><label htmlFor={`title-${rule.id}`} className="text-sm font-medium">Title</label><Input id={`title-${rule.id}`} name="title" required maxLength={data.limits.titleMaxChars} defaultValue={rule.title} /></div>
                          <div className="space-y-2"><label htmlFor={`body-${rule.id}`} className="text-sm font-medium">Rule</label><RuleTextField id={`body-${rule.id}`} name="body" maxLength={data.limits.bodyMaxChars} defaultValue={rule.body} /></div>
                          <StackChoices stacks={data.stacks} selected={rule.appliesToStacks} idPrefix={`edit-${rule.id}`} />
                          <Button type="submit">Save rule</Button>
                        </form>
                      </details>
                    ) : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
