// Mirrors the API rule in task-database approveTask: only the user who
// requested the task may approve its plan, whatever their org role. Owners and
// developers can create tasks, so a role check here would strand their plans.
export function canApprovePlan(
  task: { readonly status: string; readonly requestedByUserId: string },
  currentUserId: string,
): boolean {
  return task.status === "plan_ready" && task.requestedByUserId === currentUserId;
}
