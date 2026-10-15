"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "verification_failed" | "verification_incomplete" | "fix_not_reproduced";
type Execution = {
  readonly id: string;
  readonly attempt: number;
  readonly status: ExecutionStatus;
  readonly cancelRequestedAt: string | null;
  readonly queuedAt: string;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly sourceVersionId: string | null;
  readonly resultPatch: string | null;
  readonly changeDocument: string | null;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
  readonly costUsd: number | null;
};
type Publication = {
  readonly status: "publishing" | "published" | "failed" | "source_changed";
  readonly branchName: string;
  readonly baseMovedCommits: number | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  readonly unproven: boolean;
  readonly pullRequestState?: "open" | "merged" | "closed" | null;
  readonly failureMessage: string | null;
};
type ZipResult = {
  readonly executionId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly sourceVersionId: string;
  readonly artifactVersionId: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly promotedVersionId: string | null;
  readonly promotedVersionNumber: number | null;
};
type ZipResultBuild = {
  readonly status: "pending" | "building" | "ready" | "failed" | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
};
type DemoBudgetCaps = { readonly planningUsd: number; readonly executionUsd: number };
type Props = {
  readonly taskId: string;
  readonly taskStatus: "draft" | "waiting_for_answers" | "plan_ready" | "approved" | "rejected";
  readonly currentUserRole: "owner" | "developer" | "rep";
  readonly currentUserId: string;
  readonly requestedByUserId: string;
  readonly apiOrigin: string;
  readonly implementationBlocker?: string | null;
};
type DiffSection = { readonly path: string; readonly text: string; readonly added: number; readonly removed: number; readonly truncated: boolean };

export const DIFF_LINE_LIMIT = 200;
const active = (execution: Execution | null): boolean => execution?.status === "queued" || execution?.status === "running";
function statusText(execution: Execution): string {
  if (execution.status === "queued") return Date.now() - new Date(execution.queuedAt).getTime() >= 60_000 ? "Waiting for a worker." : "Queued for implementation.";
  if (execution.status === "running" && execution.cancelRequestedAt) return "Cancelling implementation…";
  if (execution.status === "running") return "Implementation in progress.";
  if (execution.status === "succeeded") return "Implementation completed.";
  if (execution.status === "verification_failed") return "Verification failed. New failures were found on the clean patched copy.";
  if (execution.status === "verification_incomplete") return "Verification incomplete. Dhara could not establish a passing baseline test or build, so this attempt is not marked successful.";
  if (execution.status === "fix_not_reproduced") return "Fix not reproduced. Review the patch, but Dhara did not prove the bug with a valid fail-before/pass-after test.";
  if (execution.status === "cancelled") return "Implementation cancelled. No changes were published.";
  if (execution.status === "timed_out") return "Implementation timed out. No changes were published.";
  return execution.failureMessage || "Implementation failed. No changes were published.";
}
function metadataFlag(execution: Execution, key: string): boolean { return execution.resultMetadata[key] === true; }
function diffSections(patch: string | null): readonly DiffSection[] {
  if (!patch) return [];
  const starts = [...patch.matchAll(/^diff --git .*$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0; const end = starts[index + 1]?.index ?? patch.length; const block = patch.slice(start, end).trimEnd(); const lines = block.split("\n");
    const marker = lines.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const header = lines[0] ?? ""; const path = marker && marker !== "/dev/null" ? marker.replace(/^b\//, "") : header.split(" ").at(-1)?.replace(/^b\//, "") ?? "Changed file";
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const truncated = lines.length > DIFF_LINE_LIMIT;
    return { path, added, removed, truncated, text: (truncated ? lines.slice(0, DIFF_LINE_LIMIT) : lines).join("\n") };
  });
}

export function TaskExecutionStatus({ taskId, taskStatus, currentUserRole, currentUserId, requestedByUserId, apiOrigin, implementationBlocker: initialBlocker = null }: Props) {
  const [execution, setExecution] = useState<Execution | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [zipResult, setZipResult] = useState<ZipResult | null>(null);
  const [zipResultBuild, setZipResultBuild] = useState<ZipResultBuild | null>(null);
  const [demoBudgetCaps, setDemoBudgetCaps] = useState<DemoBudgetCaps | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [zipSourceChanged, setZipSourceChanged] = useState(false);
  const [implementationBlocker, setImplementationBlocker] = useState<string | null>(initialBlocker);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canControl = currentUserRole === "owner" || currentUserRole === "developer" || (currentUserRole === "rep" && currentUserId === requestedByUserId);
  const canPublish = currentUserRole === "owner" || currentUserRole === "developer";
  const sections = useMemo(() => diffSections(execution?.resultPatch ?? null), [execution?.resultPatch]);
  const largeDiff = sections.some((section) => section.truncated);

  const load = useCallback(async () => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/execution`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { readonly execution: Execution | null; readonly implementationBlocker?: string | null; readonly publication?: Publication | null; readonly zipResult?: ZipResult | null; readonly zipResultBuild?: ZipResultBuild | null; readonly demoBudgetCaps?: DemoBudgetCaps | null };
    setExecution(payload.execution); setPublication(payload.publication ?? null); setZipResult(payload.zipResult ?? null); setZipResultBuild(payload.zipResultBuild ?? null); setDemoBudgetCaps(payload.demoBudgetCaps ?? null); setImplementationBlocker(payload.implementationBlocker ?? initialBlocker); setLoaded(true);
  }, [taskId, initialBlocker]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const zipBusy = zipResultBuild?.status === "pending" || zipResultBuild?.status === "building";
    if (!active(execution) && publication?.status !== "publishing" && !zipBusy) return;
    const timer = setInterval(() => { void load(); }, 2_000);
    return () => clearInterval(timer);
  }, [execution, publication, zipResultBuild, load]);

  async function act(action: "start" | "cancel" | "publish" | "acceptZip" | "retryZip" | "promoteZip") {
    setBusy(true); setError(null); setZipSourceChanged(false);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/execution`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json() as { readonly execution?: Execution; readonly publication?: Publication; readonly zipResult?: ZipResult; readonly code?: string; readonly error?: string };
      if (!response.ok) { if (payload.code === "SOURCE_CHANGED") setZipSourceChanged(true); setError(payload.error || "Unable to update implementation."); return; }
      if (payload.execution) setExecution(payload.execution); if (payload.publication) setPublication(payload.publication); if (payload.zipResult) setZipResult(payload.zipResult);
      await load();
    } catch { setError("Unable to update implementation."); }
    finally { setBusy(false); }
  }

  const dependencyChanged = execution ? metadataFlag(execution, "dependencyChanged") || metadataFlag(execution, "lockfileChanged") : false;
  // ZIP-backed runs deliver an updated ZIP (sourceVersionId); only GitHub-backed
  // runs can open a pull request. Live run: the button showed on a ZIP task.
  const publishable = (execution?.status === "succeeded" || execution?.status === "fix_not_reproduced") && !execution?.sourceVersionId;
  const publishLabel = execution?.status === "fix_not_reproduced" ? "Publish unproven pull request" : publication?.status === "failed" ? "Retry publication" : "Publish pull request";
  return (
    <Card>
      <CardHeader><CardTitle>Implementation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {demoBudgetCaps ? <section className="rounded-md border p-4" aria-label="Demo spend caps"><p className="text-sm font-medium">Demo spend caps</p><div className="mt-2 grid gap-2 text-sm sm:grid-cols-2"><p><span className="text-muted-foreground">Planning cap</span> · ${demoBudgetCaps.planningUsd.toFixed(2)} per planning run</p><p><span className="text-muted-foreground">Implementation cap</span> · ${demoBudgetCaps.executionUsd.toFixed(2)} per execution</p></div><p className="mt-2 text-xs text-muted-foreground">These are maximums, not estimates. Actual usage may be lower.</p></section> : null}
        {zipResultBuild?.status === "failed" ? <Alert variant="destructive"><AlertDescription>{zipResultBuild.errorMessage || "ZIP result build failed. Retry building the ZIP."}{canPublish ? <Button type="button" variant="outline" className="ml-3" disabled={busy} onClick={() => void act("retryZip")}>Retry building the ZIP</Button> : null}</AlertDescription></Alert> : null}
        {zipResultBuild?.status === "pending" || zipResultBuild?.status === "building" ? <Alert><AlertDescription>{zipResultBuild.status === "pending" ? "Updated ZIP is waiting for a worker." : "Building updated ZIP…"}</AlertDescription></Alert> : null}
        {implementationBlocker ? <Alert variant="destructive"><AlertDescription>{implementationBlocker === "Re-analyse this project before implementation" ? "Re-analyse this project before implementation" : implementationBlocker}</AlertDescription></Alert> : null}
        {execution ? <div className="space-y-1"><p className="text-sm font-medium">Attempt {execution.attempt}</p><p className="text-sm text-muted-foreground">{statusText(execution)}</p></div> : <p className="text-sm text-muted-foreground">No implementation attempt yet.</p>}
        {execution ? <div><p className="text-xs text-muted-foreground">Execution cost</p><p className="text-sm font-medium">{execution.costUsd === null ? "Cost unavailable" : `$${execution.costUsd.toFixed(2)}`}</p></div> : null}
        {dependencyChanged ? <Alert><AlertDescription>Dependency or lockfile changes are included. Review them carefully.</AlertDescription></Alert> : null}
        {execution?.changeDocument ? <section className="space-y-2"><p className="text-sm font-medium">Change note</p><pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">{execution.changeDocument}</pre></section> : null}
        {sections.length > 0 && execution?.sourceVersionId ? <section className="space-y-3"><div className="flex items-center justify-between gap-3"><p className="text-sm font-medium">Result diff</p>{largeDiff ? <a className="text-sm font-medium underline" href={`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}/execution/zip-result/patch`}>Download full patch</a> : null}</div>{sections.map((section) => <details key={`${section.path}-${section.added}-${section.removed}`} className="rounded-md border"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">{section.path} · +{section.added} added · −{section.removed} removed</summary><pre className="max-h-[32rem] overflow-auto whitespace-pre border-t bg-muted/30 p-4 text-xs leading-5">{section.text}{section.truncated ? "\n… diff truncated" : ""}</pre></details>)}</section> : null}
        {zipResult ? <section className="space-y-3 rounded-md border p-4"><div><p className="text-sm font-medium">Updated ZIP</p><p className="text-xs text-muted-foreground">{zipResult.fileCount} files · {(zipResult.sizeBytes / 1024).toFixed(1)} KB{zipResult.promotedVersionNumber ? ` · promoted as version ${zipResult.promotedVersionNumber}` : " · not promoted"}</p></div><div className="flex flex-wrap gap-2"><form action={`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}/execution/zip-result/download-token`} method="post"><Button type="submit" variant="outline">Download updated ZIP</Button></form><form action={`${apiOrigin}/projects/${encodeURIComponent(zipResult.projectId)}/versions/${encodeURIComponent(zipResult.sourceVersionId)}/download-token`} method="post"><Button type="submit" variant="outline">Download approved source ZIP</Button></form>{canPublish && !zipResult.promotedVersionId ? <Button type="button" disabled={busy || zipSourceChanged} onClick={() => void act("promoteZip")}>Promote to current version</Button> : null}</div></section> : null}
        {!zipResult && execution?.status === "fix_not_reproduced" && canPublish && !zipResultBuild?.status ? <Button type="button" variant="outline" disabled={busy} onClick={() => void act("acceptZip")}>Accept unproven ZIP result</Button> : null}
        {zipSourceChanged ? <Alert variant="destructive"><AlertDescription>source_changed: the project current version changed since this execution was approved. Re-plan before promoting.</AlertDescription></Alert> : null}
        {publication?.status === "published" && publication.pullRequestUrl ? <Alert><AlertDescription><a className="font-medium underline" href={publication.pullRequestUrl} target="_blank" rel="noreferrer">Pull request #{publication.pullRequestNumber}</a>{publication.baseMovedCommits !== null ? ` · base moved ${publication.baseMovedCommits} commit${publication.baseMovedCommits === 1 ? "" : "s"}` : ""}{publication.unproven ? " · unproven fix" : ""}{publication.pullRequestState === "merged" ? " · merged on GitHub" : publication.pullRequestState === "closed" ? " · closed without merging" : ""}</AlertDescription></Alert> : null}
        {publication?.status === "source_changed" ? <Alert variant="destructive"><AlertDescription>Source changed in a file named by the approved plan or patch. Re-plan before publishing.</AlertDescription></Alert> : null}
        {publication?.status === "failed" ? <Alert variant="destructive"><AlertDescription>{publication.failureMessage || "GitHub publication failed. Retry publication without starting a new implementation attempt."}</AlertDescription></Alert> : null}
        {taskStatus === "rejected" && !execution ? <p className="text-sm text-muted-foreground">This plan was rejected. Create a new task to propose a different approach.</p> : null}
        {canControl && taskStatus !== "approved" && taskStatus !== "rejected" && !execution ? <p className="text-sm text-muted-foreground">Approve the plan before starting implementation.</p> : null}
        {canControl && loaded && taskStatus === "approved" && !active(execution) && !implementationBlocker ? <Button type="button" disabled={busy} onClick={() => void act("start")}>{busy ? "Starting…" : "Start implementation"}</Button> : null}
        {canControl && active(execution) ? <Button type="button" variant="outline" disabled={busy || Boolean(execution?.cancelRequestedAt)} onClick={() => void act("cancel")}>{busy ? "Cancelling…" : "Cancel implementation"}</Button> : null}
        {canPublish && publishable && publication?.status !== "published" && publication?.status !== "source_changed" ? <Button type="button" disabled={busy || publication?.status === "publishing"} onClick={() => void act("publish")}>{publication?.status === "publishing" ? "Publishing…" : publishLabel}</Button> : null}
      </CardContent>
    </Card>
  );
}
