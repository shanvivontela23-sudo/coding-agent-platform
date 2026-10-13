// Clarification runs inside the create request, so a task still in draft on
// its own page means clarification failed; it will not complete by waiting.
export const draftTaskMessage = "Dhara couldn't finish clarifying this request. Start a new task with the same request to try again.";

// Mirrors the API rule in task-database approveTask: only the user who
// requested the task may approve its plan, whatever their org role. Owners and
// developers can create tasks, so a role check here would strand their plans.
export function canApprovePlan(
  task: { readonly status: string; readonly requestedByUserId: string },
  currentUserId: string,
): boolean {
  return task.status === "plan_ready" && task.requestedByUserId === currentUserId;
}
