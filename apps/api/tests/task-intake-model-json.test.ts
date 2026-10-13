import { describe, expect, it } from "vitest";
import {
  ModelResponseFormatError,
  parseModelJson,
  TaskPlanner,
  type TaskModelGateway,
} from "../src/task-intake.js";

describe("parseModelJson", () => {
  it("parses the exact fenced shape returned by Claude Haiku via LiteLLM on the first live run", () => {
    const live = "```json\n{\n\"jobType\": \"bug_fix\",\n\"questions\": []\n}\n```";
    expect(parseModelJson(live)).toEqual({ jobType: "bug_fix", questions: [] });
  });

  it.each([
    ["bare JSON", "{\"a\":1}"],
    ["json fence", "```json\n{\"a\":1}\n```"],
    ["bare fence", "```\n{\"a\":1}\n```"],
    ["uppercase JSON fence", "```JSON\n{\"a\":1}\n```"],
    ["surrounding whitespace", "  \n```json\n  {\"a\":1}  \n```\n  "],
    ["CRLF fence", "```json\r\n{\"a\":1}\r\n```"],
    ["fence close on the same line", "```json\n{\"a\":1}```"],
  ])("accepts %s", (_label, text) => {
    expect(parseModelJson(text)).toEqual({ a: 1 });
  });

  it.each([
    ["prose without JSON", "Sure! The customer was refunded too much."],
    ["prose around JSON", "Here you go: {\"a\":1}"],
    ["invalid JSON inside a fence", "```json\n{ customer: secret-ticket-text }\n```"],
  ])("rejects %s without echoing model text", (_label, text) => {
    let caught: unknown;
    try { parseModelJson(text); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ModelResponseFormatError);
    const message = (caught as Error).message;
    expect(message).toBe("model response was not a single JSON object");
    expect(message).not.toContain("secret-ticket-text");
    expect(message).not.toContain("customer");
  });
});

class FailingGateway implements TaskModelGateway {
  starts = 0;
  finishes = 0;
  constructor(private readonly failOn: string) {}
  async startTaskRun(): Promise<void> { this.starts += 1; }
  async call(_taskId: string, purpose: string): Promise<unknown> {
    if (purpose === this.failOn) throw new ModelResponseFormatError();
    return { jobType: "bug_fix", questions: [] };
  }
  async finishTaskRun(): Promise<void> { this.finishes += 1; }
}

describe("TaskPlanner gateway run lifecycle on failure", () => {
  const input = { taskId: "task-1", maskedTicket: "refund wrong", repositoryContext: "ctx" };

  it("finishes the gateway run when clarify fails and rethrows the original error", async () => {
    const gateway = new FailingGateway("clarify");
    const planner = new TaskPlanner({ gateway, spendCapUsd: 1 });
    await expect(planner.clarify(input)).rejects.toBeInstanceOf(ModelResponseFormatError);
    expect(gateway.starts).toBe(1);
    expect(gateway.finishes).toBe(1);
  });

  it("finishes the gateway run when plan fails", async () => {
    const gateway = new FailingGateway("plan");
    const planner = new TaskPlanner({ gateway, spendCapUsd: 1 });
    await expect(planner.plan({ ...input, answers: [] })).rejects.toBeInstanceOf(ModelResponseFormatError);
    expect(gateway.finishes).toBe(1);
  });

  it("keeps the run open after a successful clarify so planning can follow", async () => {
    const gateway = new FailingGateway("never");
    const planner = new TaskPlanner({ gateway, spendCapUsd: 1 });
    await planner.clarify(input);
    expect(gateway.finishes).toBe(0);
  });
});
