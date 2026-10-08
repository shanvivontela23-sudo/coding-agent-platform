import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("task intake and clarification UI", () => {
  it("adds Tasks to the signed-in navigation with the required statuses", async () => {
    const shell = await readFile("apps/web/components/app-shell.tsx", "utf8");
    const tasks = await readFile("apps/web/app/tasks/page.tsx", "utf8");
    expect(shell).toContain('{ label: "Tasks", href: "/tasks" }');
    for (const status of ["Draft", "Waiting for answers", "Plan ready", "Approved"]) expect(tasks).toContain(status);
  });

  it("offers New task from a project and accepts English Hindi or mixed ticket text", async () => {
    const project = await readFile("apps/web/app/projects/[projectId]/page.tsx", "utf8");
    const intake = await readFile("apps/web/app/projects/[projectId]/tasks/new/page.tsx", "utf8");
    expect(project).toContain("New task");
    expect(intake).toContain("Paste a ticket or describe a change");
    expect(intake).toContain("English, Hindi, or mixed language");
    expect(intake).toContain('name="ticket"');
  });

  it("shows clarification without technical implementation wording and supports I don't know", async () => {
    const detail = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(detail).toContain("I don't know");
    expect(detail).toContain("Suggested answer");
    expect(detail).toContain("What I understand");
    expect(detail).toContain("Proposed approach");
    expect(detail).toContain("Estimated cost");
    expect(detail).toContain("Estimated time");
    expect(detail).toContain("Approve plan");
  });

  it("does not expose the encrypted original ticket broadly", async () => {
    const detail = await readFile("apps/web/app/tasks/[taskId]/page.tsx", "utf8");
    expect(detail).not.toContain("original_ticket_encrypted");
    expect(detail).not.toContain("originalTicketEncrypted");
  });
});
