import { describe, expect, it, vi } from "vitest";
import type { SessionIdentity } from "../src/auth.js";
import { createProjectDecisionService } from "../src/project-decision-service.js";
import { createProjectDecisionDatabase, type ProjectDecisionDatabase } from "../src/project-decision-database.js";
import type { TenantPool } from "../src/database.js";

const session: SessionIdentity = { organizationId: "00000000-0000-4000-8000-000000000601", userId: "10000000-0000-4000-8000-000000000601", expiresAtMs: Date.now() + 60_000 };
const projectId = "20000000-0000-4000-8000-000000000601";
const decisionId = "50000000-0000-4000-8000-000000000601";
const decision = { id: decisionId, organizationId: session.organizationId, projectId, taskId: null, kind: "convention" as const, summary: "Tests live next to source", detail: {}, source: "verification" as const, createdAt: "2026-10-14T00:00:00.000Z", supersededBy: null };

function fakeDatabase(overrides: Partial<ProjectDecisionDatabase> = {}): ProjectDecisionDatabase {
  return {
    listCurrent: vi.fn(async () => [decision]),
    record: vi.fn(async () => decision),
    supersede: vi.fn(async () => true),
    getMembershipRole: vi.fn(async () => "owner" as const),
    ...overrides,
  };
}

describe("project decision service", () => {
  it("returns current decisions with the caller role", async () => {
    const database = fakeDatabase();
    await expect(createProjectDecisionService({ database }).list(session, projectId)).resolves.toEqual({ decisions: [decision], currentUserRole: "owner" });
    expect(database.listCurrent).toHaveBeenCalledWith(session, projectId, 15);
  });

  it("allows only owners to mark an entry wrong", async () => {
    const denied = fakeDatabase({ getMembershipRole: vi.fn(async () => "developer" as const) });
    await expect(createProjectDecisionService({ database: denied }).supersede(session, projectId, decisionId)).rejects.toMatchObject({ code: "PROJECT_DECISION_FORBIDDEN", status: 403 });
    expect(denied.supersede).not.toHaveBeenCalled();

    const owner = fakeDatabase();
    await expect(createProjectDecisionService({ database: owner }).supersede(session, projectId, decisionId)).resolves.toBeUndefined();
    expect(owner.supersede).toHaveBeenCalledWith(session, projectId, decisionId);
  });

  it("does not reveal a missing or cross-tenant decision", async () => {
    const database = fakeDatabase({ supersede: vi.fn(async () => false) });
    await expect(createProjectDecisionService({ database }).supersede(session, projectId, decisionId)).rejects.toMatchObject({ code: "PROJECT_DECISION_NOT_FOUND", status: 404 });
  });
});
describe("project decision database", () => {
  it("loads only current rows newest first with a hard limit", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const client = {
      async query<Row>(text: string, values?: readonly unknown[]) {
        calls.push({ text, ...(values ? { values } : {}) });
        if (text.includes("FROM projects")) return { rows: [{ id: projectId }] as Row[] };
        if (text.includes("FROM project_decisions")) return { rows: [{ id: decision.id, organization_id: decision.organizationId, project_id: projectId, task_id: null, kind: decision.kind, summary: decision.summary, detail: {}, source: decision.source, created_at: decision.createdAt, superseded_by: null }] as Row[] };
        return { rows: [] as Row[] };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query } as unknown as TenantPool;
    await expect(createProjectDecisionDatabase(pool).listCurrent(session, projectId, 15)).resolves.toEqual([decision]);
    const select = calls.find((call) => call.text.includes("FROM project_decisions"));
    expect(select?.text).toContain("superseded_by IS NULL");
    expect(select?.text).toContain("ORDER BY created_at DESC,id DESC");
    expect(select?.values).toEqual([session.organizationId, projectId, 15]);
  });

  it("returns the current matching fact without inserting a duplicate", async () => {
    const calls: string[] = [];
    const stored = { id: decision.id, organization_id: decision.organizationId, project_id: projectId, task_id: null, kind: "convention", summary: decision.summary, detail: { memoryKey: "convention:test-location", runner: "vitest" }, source: "verification", created_at: decision.createdAt, superseded_by: null, same_detail: true };
    const client = {
      async query<Row>(text: string) {
        calls.push(text);
        if (text.includes("FROM project_decisions") && text.includes("FOR UPDATE")) return { rows: [stored] as Row[] };
        return { rows: [] as Row[] };
      },
      release() {},
    };
    const pool = { connect: async () => client, query: client.query } as unknown as TenantPool;
    await expect(createProjectDecisionDatabase(pool).record(session, { projectId, taskId: null, kind: "convention", summary: decision.summary, detail: { runner: "vitest" }, source: "verification", memoryKey: "convention:test-location" })).resolves.toMatchObject({ id: decision.id });
    expect(calls.some((text) => text.includes("INSERT INTO project_decisions"))).toBe(false);
  });
});
