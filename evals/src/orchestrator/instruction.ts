export const PHASE0_INSTRUCTION_VERSION = "phase0-bugfix-v1" as const;

export const PHASE0_BUGFIX_INSTRUCTION = [
  "Read the ticket and find the cause.",
  "Before changing production code, write a test that fails because of the bug.",
  "Fix the bug with the smallest change that fits the repository's style.",
  "Run the repository's formatter, lint, build or type-check, and the affected tests.",
  "End with a short plain-language summary of the cause, the change, and the checks you ran.",
].join(" ");

export function buildPhase0HarnessTicket(ticketText: string): string {
  const ticket = ticketText.trim();
  if (!ticket) throw new Error("Phase 0 ticket text is required");
  return `${PHASE0_BUGFIX_INSTRUCTION}\n\n--- Ticket ---\n${ticket}`;
}
