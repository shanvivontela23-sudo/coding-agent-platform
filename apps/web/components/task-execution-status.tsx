"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
type Execution = {
  readonly id: string;
  readonly attempt: number;
  readonly status: ExecutionStatus;
  readonly cancelRequestedAt: string | null;
  readonly failureMessage: string | null;
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
  if (execution.status === "queued") return "Queued for implementation.";
  if (execution.status === "running" && execution.cancelRequestedAt) return "Cancelling implementation…";
  if (execution.status === "running") return "Implementation in progress.";
  if (execution.status === "succeeded") return "Implementation completed.";
  if (execution.status === "cancelled") return "Implementation cancelled. No changes were published.";
  if (execution.status === "timed_out") return "Implementation timed out. No changes were published.";
  return execution.failureMessage || "Implementation failed. No changes were published.";
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

  return (
    <Card>
      <CardHeader><CardTitle>Implementation</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {execution ? <div className="space-y-1"><p className="text-sm font-medium">Attempt {execution.attempt}</p><p className="text-sm text-muted-foreground">{statusText(execution)}</p></div> : <p className="text-sm text-muted-foreground">No implementation attempt yet.</p>}
        {canControl && taskStatus !== "approved" && !execution ? <p className="text-sm text-muted-foreground">Approve the plan before starting implementation.</p> : null}
        {canControl && taskStatus === "approved" && !active(execution) ? <Button type="button" disabled={busy} onClick={() => void act("start")}>{busy ? "Starting…" : "Start implementation"}</Button> : null}
        {canControl && active(execution) ? <Button type="button" variant="outline" disabled={busy || Boolean(execution?.cancelRequestedAt)} onClick={() => void act("cancel")}>{busy ? "Cancelling…" : "Cancel implementation"}</Button> : null}
      </CardContent>
    </Card>
  );
}
