"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "verification_failed" | "fix_not_reproduced";
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

type Props = {
  readonly taskId: string;
  readonly taskStatus: "draft" | "waiting_for_answers" | "plan_ready" | "approved";
  readonly currentUserRole: "owner" | "developer" | "rep";
  readonly currentUserId: string;
  readonly requestedByUserId: string;
};

const active = (execution: Execution | null): boolean => execution?.status === "queued" || execution?.status === "running";

function statusText(execution: Execution): string {
  if (execution.status === "queued") {
    return Date.now() - new Date(execution.queuedAt).getTime() >= 60_000 ? "Waiting for a worker." : "Queued for implementation.";
  }
  if (execution.status === "running" && execution.cancelRequestedAt) return "Cancelling implementation…";
  if (execution.status === "running") return "Implementation in progress.";
  if (execution.status === "succeeded") return "Implementation completed.";
  if (execution.status === "verification_failed") return "Verification failed. New failures were found on the clean patched copy.";
  if (execution.status === "fix_not_reproduced") return "Fix not reproduced. Review the patch, but Dhara did not prove the bug with a fail-before/pass-after test.";
  if (execution.status === "cancelled") return "Implementation cancelled. No changes were published.";
  if (execution.status === "timed_out") return "Implementation timed out. No changes were published.";
  return execution.failureMessage || "Implementation failed. No changes were published.";
}

function metadataFlag(execution: Execution, key: string): boolean {
  return execution.resultMetadata[key] === true;
}

export function TaskExecutionStatus({ taskId, taskStatus, currentUserRole, currentUserId, requestedByUserId }: Props) {
  const [execution, setExecution] = useState<Execution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canControl = currentUserRole === "owner" || currentUserRole === "developer" || (currentUserRole === "rep" && currentUserId === requestedByUserId);

  const load = useCallback(async () => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/execution`, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json() as { readonly execution: Execution | null };
    setExecution(payload.execution);
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active(execution)) return;
    const timer = setInterval(() => { void load(); }, 2_000);
    return () => clearInterval(timer);
  }, [execution, load]);

  async function act(action: "start" | "cancel") {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/execution`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json() as { readonly execution?: Execution; readonly error?: string };
      if (!response.ok) { setError(payload.error || "Unable to update implementation."); return; }
      if (payload.execution) setExecution(payload.execution);
      else await load();
    } catch {
      setError("Unable to update implementation.");
    } finally {
      setBusy(false);
    }
  }

  const dependencyChanged = execution ? metadataFlag(execution, "dependencyChanged") || metadataFlag(execution, "lockfileChanged") : false;
  return (
    <Card>
      <CardHeader><CardTitle>Implementation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {execution ? <div className="space-y-1"><p className="text-sm font-medium">Attempt {execution.attempt}</p><p className="text-sm text-muted-foreground">{statusText(execution)}</p></div> : <p className="text-sm text-muted-foreground">No implementation attempt yet.</p>}
        {execution?.costUsd !== null && execution?.costUsd !== undefined ? <div><p className="text-xs text-muted-foreground">Execution cost</p><p className="text-sm font-medium">${execution.costUsd.toFixed(2)}</p></div> : null}
        {dependencyChanged ? <Alert><AlertDescription>Dependency or lockfile changes are included. Review them carefully.</AlertDescription></Alert> : null}
        {execution?.changeDocument ? <section className="space-y-2"><p className="text-sm font-medium">Change note</p><pre className="whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">{execution.changeDocument}</pre></section> : null}
        {execution?.resultPatch && execution.sourceVersionId ? <section className="space-y-2"><p className="text-sm font-medium">Result diff</p><pre className="max-h-[32rem] overflow-auto whitespace-pre rounded-md border bg-muted/30 p-4 text-xs leading-5">{execution.resultPatch}</pre></section> : null}
        {canControl && taskStatus !== "approved" && !execution ? <p className="text-sm text-muted-foreground">Approve the plan before starting implementation.</p> : null}
        {canControl && taskStatus === "approved" && !active(execution) ? <Button type="button" disabled={busy} onClick={() => void act("start")}>{busy ? "Starting…" : "Start implementation"}</Button> : null}
        {canControl && active(execution) ? <Button type="button" variant="outline" disabled={busy || Boolean(execution?.cancelRequestedAt)} onClick={() => void act("cancel")}>{busy ? "Cancelling…" : "Cancel implementation"}</Button> : null}
      </CardContent>
    </Card>
  );
}
