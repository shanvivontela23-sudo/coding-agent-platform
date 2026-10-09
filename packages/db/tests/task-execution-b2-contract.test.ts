import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationName = "0007_task_execution_b2.sql";
const migrationPath = `packages/db/migrations/${migrationName}`;

async function migration(): Promise<string> {
  return await readFile(migrationPath, "utf8");
}

describe("Part B2 task execution migration contract", () => {
  it("adds migration 0007 without changing applied migration 0006", async () => {
    const files = await readdir("packages/db/migrations");
    expect(files).toContain(migrationName);

    const checksums = JSON.parse(await readFile("packages/db/migrations/checksums.json", "utf8")) as Record<string, string>;
    expect(checksums["0006_task_execution.sql"]).toBe("4e392204068f9a8e79d2523633ce5fd895c43bd32eca74e2b83adc63fe4e0a45");
    const sql = await migration();
    expect(checksums[migrationName]).toBe(createHash("sha256").update(sql).digest("hex"));
    expect(Object.keys(checksums)).toHaveLength(7);
  });

  it("moves queue execution to a dedicated worker role with no direct table grants", async () => {
    const sql = await migration();
    expect(sql).toMatch(/CREATE ROLE coding_agent_worker[\s\S]*LOGIN[\s\S]*NOSUPERUSER[\s\S]*NOBYPASSRLS[\s\S]*NOINHERIT/i);
    expect(sql).toContain("GRANT coding_agent_app TO coding_agent_worker");
    expect(sql).toContain("REVOKE EXECUTE ON FUNCTION public.claim_task_execution(text, integer) FROM coding_agent_api");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.claim_task_execution(text, integer) TO coding_agent_worker");
    expect(sql).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[\s\S]*task_executions[\s\S]*TO\s+coding_agent_worker/i);
  });

  it("makes execution history append-and-update only and records durable paid-step progress", async () => {
    const sql = await migration();
    expect(sql).toContain("REVOKE DELETE ON task_executions, task_execution_checks, task_execution_artifacts FROM coding_agent_app");
    for (const column of ["source_prepared_at", "coding_started_at", "coding_finished_at", "patch_exported_at", "verified_at"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("WORKER_INTERRUPTED");
    expect(sql).toContain("coding_started_at IS NOT NULL");
    expect(sql).toContain("coding_finished_at IS NULL");
  });

  it("writes worker terminal audit events in queue state transitions", async () => {
    const sql = await migration();
    for (const eventType of [
      "task_execution_succeeded",
      "task_execution_failed",
      "task_execution_cancelled",
      "task_execution_timed_out",
    ]) expect(sql).toContain(eventType);
    expect(sql).toContain("'execution_id'");
    expect(sql).toContain("'failure_code'");
  });
});
