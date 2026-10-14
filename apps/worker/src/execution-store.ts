import { createHash } from "node:crypto";
import { type TenantPool, withTenant } from "../../api/src/database.js";
import type { ClaimedExecution } from "./postgres-execution-queue.js";
import type { PatchSafetyResult } from "./patch-safety.js";
import type { VerificationResult } from "./verification.js";
import { parseExecutionProfile, type ExecutionProfile } from "../../../packages/skills/src/profile.js";
import { recordProjectDecision } from "../../api/src/project-decision-database.js";
import { maskPersonalData } from "../../api/src/task-intake.js";
import { normalizeDecisionSummary } from "../../../packages/db/src/project-decisions.js";
import { sanitizeChangeNoteText } from "./change-document.js";

export type ExecutionProgress = {
  readonly sourcePreparedAt: string | null;
  readonly codingStartedAt: string | null;
  readonly codingFinishedAt: string | null;
  readonly patchExportedAt: string | null;
  readonly verifiedAt: string | null;
  readonly resultPatch: string | null;
  readonly resultMetadata: Readonly<Record<string, unknown>>;
};

export interface ExecutionStore {
  getProgress(execution: ClaimedExecution): Promise<ExecutionProgress>;
  markSourcePrepared(execution: ClaimedExecution): Promise<void>;
  // Stores the candidate only if no profile is pinned yet, and returns the
  // pinned one. A reclaimed execution therefore keeps its original profile.
  pinExecutionProfile?(execution: ClaimedExecution, candidate: ExecutionProfile): Promise<ExecutionProfile>;
  markCodingStarted(execution: ClaimedExecution): Promise<void>;
  saveCost(execution: ClaimedExecution, costUsd: number | null): Promise<void>;
  saveSafeCodingOutput(execution: ClaimedExecution, input: {
    readonly patch: string;
    readonly safety: PatchSafetyResult;
    readonly reproductionCommand: string | null;
    readonly codingSummary: string;
    readonly costUsd: number;
  }): Promise<void>;
  saveVerification(execution: ClaimedExecution, input: {
    readonly verification: VerificationResult;
    readonly changeDocument: string;
    readonly costUsd: number | null;
  }): Promise<void>;
}

type ProgressRow = {
  source_prepared_at: Date | string | null;
  coding_started_at: Date | string | null;
  coding_finished_at: Date | string | null;
  patch_exported_at: Date | string | null;
  verified_at: Date | string | null;
  result_patch: string | null;
  result_metadata: Record<string, unknown> | null;
};

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}
function tenant(execution: ClaimedExecution): { readonly organizationId: string } { return { organizationId: execution.organizationId }; }

export class PostgresExecutionStore implements ExecutionStore {
  constructor(private readonly pool: TenantPool) {}

  async getProgress(execution: ClaimedExecution): Promise<ExecutionProgress> {
    return await withTenant(this.pool, tenant(execution), async (database) => {
      const result = await database.query<ProgressRow>(
        `SELECT source_prepared_at,coding_started_at,coding_finished_at,patch_exported_at,verified_at,result_patch,result_metadata
           FROM task_executions WHERE organization_id=$1 AND id=$2 AND task_id=$3 LIMIT 1`,
        [execution.organizationId, execution.executionId, execution.taskId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("execution is not visible in claimed tenant");
      return { sourcePreparedAt: iso(row.source_prepared_at), codingStartedAt: iso(row.coding_started_at), codingFinishedAt: iso(row.coding_finished_at), patchExportedAt: iso(row.patch_exported_at), verifiedAt: iso(row.verified_at), resultPatch: row.result_patch, resultMetadata: row.result_metadata ?? {} };
    });
  }

  async pinExecutionProfile(execution: ClaimedExecution, candidate: ExecutionProfile): Promise<ExecutionProfile> {
    const profile = parseExecutionProfile(candidate);
    return await withTenant(this.pool, tenant(execution), async (database) => {
      const result = await database.query<{ execution_profile: unknown }>(
        `UPDATE task_executions
            SET execution_profile=COALESCE(execution_profile,$4::jsonb),
                implementation_skill_id=CASE WHEN execution_profile IS NULL THEN $5 ELSE implementation_skill_id END,
                implementation_skill_version=CASE WHEN execution_profile IS NULL THEN $6 ELSE implementation_skill_version END,
                planning_skill_id=CASE WHEN execution_profile IS NULL THEN $7 ELSE planning_skill_id END,
                planning_skill_version=CASE WHEN execution_profile IS NULL THEN $8 ELSE planning_skill_version END,
                sandbox_template_id=CASE WHEN execution_profile IS NULL THEN $9 ELSE sandbox_template_id END,
                updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND task_id=$3
          RETURNING execution_profile`,
        [execution.organizationId, execution.executionId, execution.taskId, JSON.stringify(profile), profile.skillId, profile.skillVersion, profile.planningSkillId, profile.planningSkillVersion, profile.sandboxTemplateId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("execution is not visible in claimed tenant");
      return parseExecutionProfile(row.execution_profile);
    });
  }

  async markSourcePrepared(execution: ClaimedExecution): Promise<void> {
    await withTenant(this.pool, tenant(execution), async (database) => {
      await database.query(`UPDATE task_executions SET source_prepared_at=COALESCE(source_prepared_at,now()),updated_at=now() WHERE organization_id=$1 AND id=$2 AND task_id=$3`, [execution.organizationId, execution.executionId, execution.taskId]);
    });
  }

  async markCodingStarted(execution: ClaimedExecution): Promise<void> {
    await withTenant(this.pool, tenant(execution), async (database) => {
      await database.query(`UPDATE task_executions SET coding_started_at=COALESCE(coding_started_at,now()),updated_at=now() WHERE organization_id=$1 AND id=$2 AND task_id=$3 AND coding_finished_at IS NULL`, [execution.organizationId, execution.executionId, execution.taskId]);
    });
  }

  async saveCost(execution: ClaimedExecution, costUsd: number | null): Promise<void> {
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0)) throw new Error("execution cost must be non-negative");
    await withTenant(this.pool, tenant(execution), async (database) => {
      await database.query(
        `UPDATE task_executions
            SET cost_usd=$4,
                result_metadata=(result_metadata - 'costUsd' - 'costUnavailable') || $5::jsonb,
                updated_at=now()
          WHERE organization_id=$1 AND id=$2 AND task_id=$3`,
        [execution.organizationId, execution.executionId, execution.taskId, costUsd, JSON.stringify(costUsd === null ? { costUnavailable: true } : { costUsd })],
      );
    });
  }

  async saveSafeCodingOutput(execution: ClaimedExecution, input: { readonly patch: string; readonly safety: PatchSafetyResult; readonly reproductionCommand: string | null; readonly codingSummary: string; readonly costUsd: number }): Promise<void> {
    const patchSha = createHash("sha256").update(input.patch).digest("hex");
    const patchBytes = Buffer.byteLength(input.patch, "utf8");
    const metadata = { reproductionCommand: input.reproductionCommand, codingSummary: input.codingSummary, costUsd: input.costUsd, costUnavailable: false, files: input.safety.files, dependencyChanged: input.safety.dependencyChanged, lockfileChanged: input.safety.lockfileChanged };
    await withTenant(this.pool, tenant(execution), async (database) => {
      await database.query(
        `UPDATE task_executions SET coding_finished_at=COALESCE(coding_finished_at,now()),patch_exported_at=COALESCE(patch_exported_at,now()),result_patch=$4,result_metadata=result_metadata || $5::jsonb,cost_usd=$6,updated_at=now() WHERE organization_id=$1 AND id=$2 AND task_id=$3`,
        [execution.organizationId, execution.executionId, execution.taskId, input.patch, JSON.stringify(metadata), input.costUsd],
      );
      await database.query(
        `INSERT INTO task_execution_artifacts (id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata)
         SELECT gen_random_uuid(),$1,$2,$3,'patch',NULL,$4,$5,$6::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM task_execution_artifacts WHERE organization_id=$1 AND execution_id=$3 AND kind='patch')`,
        [execution.organizationId, execution.taskId, execution.executionId, patchSha, patchBytes, JSON.stringify({ files: input.safety.files })],
      );
    });
  }

  async saveVerification(execution: ClaimedExecution, input: { readonly verification: VerificationResult; readonly changeDocument: string; readonly costUsd: number | null }): Promise<void> {
    const changeSha = createHash("sha256").update(input.changeDocument).digest("hex");
    const changeBytes = Buffer.byteLength(input.changeDocument, "utf8");
    await withTenant(this.pool, tenant(execution), async (database) => {
      for (const check of input.verification.checks) {
        await database.query(
          `INSERT INTO task_execution_checks (id,organization_id,task_id,execution_id,phase,check_key,status,command,details,started_at,finished_at)
           VALUES (gen_random_uuid(),$1,$2,$3,'verification',$4,$5,$6,$7::jsonb,now(),now())
           ON CONFLICT (organization_id,execution_id,phase,check_key) DO UPDATE SET status=EXCLUDED.status,command=EXCLUDED.command,details=EXCLUDED.details,finished_at=now()`,
          [execution.organizationId, execution.taskId, execution.executionId, check.name, check.status, check.command, JSON.stringify({ baselineExitCode: check.baselineExitCode, patchedExitCode: check.patchedExitCode, baselineFailingTests: check.baselineFailingTests, patchedFailingTests: check.patchedFailingTests })],
        );
        // What the project learns is whether the command itself works on the
        // unchanged source (the baseline). A failure the patch introduced is about
        // that fix, not the command, so it must not be remembered as "command failed".
        if (check.status === "skipped") continue;
        const safeCommand = maskPersonalData(sanitizeChangeNoteText(check.command));
        const worked = check.baselineExitCode === 0;
        await recordProjectDecision(database, execution.organizationId, {
          projectId: execution.projectId,
          taskId: execution.taskId,
          kind: worked ? "command_worked" : "command_failed",
          summary: normalizeDecisionSummary(`${safeCommand} ${worked ? "runs successfully on the unchanged project" : "does not pass on the unchanged project"} (clean verification).`, maskPersonalData),
          detail: { command: safeCommand, check: check.name, baselineExitCode: check.baselineExitCode, patchedExitCode: check.patchedExitCode, taskId: execution.taskId },
          source: "verification",
          memoryKey: `command:${check.name}:${createHash("sha256").update(safeCommand).digest("hex")}`,
        });
      }
      const reproduceStatus = input.verification.reproduce.command === null ? "skipped" : input.verification.reproduce.reproduced ? "passed" : "failed";
      await database.query(
        `INSERT INTO task_execution_checks (id,organization_id,task_id,execution_id,phase,check_key,status,command,details,started_at,finished_at)
         VALUES (gen_random_uuid(),$1,$2,$3,'reproduce','bug-proof',$4,$5,$6::jsonb,now(),now())
         ON CONFLICT (organization_id,execution_id,phase,check_key) DO UPDATE SET status=EXCLUDED.status,command=EXCLUDED.command,details=EXCLUDED.details,finished_at=now()`,
        [execution.organizationId, execution.taskId, execution.executionId, reproduceStatus, input.verification.reproduce.command, JSON.stringify(input.verification.reproduce)],
      );
      await database.query(
        `UPDATE task_executions SET verified_at=COALESCE(verified_at,now()),change_document=$4,result_metadata=result_metadata || $5::jsonb,cost_usd=$6,updated_at=now() WHERE organization_id=$1 AND id=$2 AND task_id=$3`,
        [execution.organizationId, execution.executionId, execution.taskId, input.changeDocument, JSON.stringify({ verification: input.verification, verifiedFiles: input.verification.verifiedFiles, ...(input.costUsd === null ? { costUnavailable: true } : { costUsd: input.costUsd, costUnavailable: false }) }), input.costUsd],
      );
      await database.query(
        `INSERT INTO task_execution_artifacts (id,organization_id,task_id,execution_id,kind,storage_key,sha256,size_bytes,metadata)
         SELECT gen_random_uuid(),$1,$2,$3,'change_document',NULL,$4,$5,'{}'::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM task_execution_artifacts WHERE organization_id=$1 AND execution_id=$3 AND kind='change_document')`,
        [execution.organizationId, execution.taskId, execution.executionId, changeSha, changeBytes],
      );
    });
  }
}
