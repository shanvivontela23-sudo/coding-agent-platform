import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type MigrationEntry = { readonly name: string; readonly contents: string; readonly expectedSha256: string };
export type CommandResult = { readonly stdout: string; readonly stderr: string };

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

export function migrationPlanFromEntries(entries: readonly MigrationEntry[]): readonly MigrationEntry[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (!/^\d{4}_.+\.sql$/.test(entry.name)) throw new Error(`Migration ${entry.name} is not a numbered migration`);
    if (names.has(entry.name)) throw new Error(`Duplicate migration ${entry.name}`);
    names.add(entry.name);
    if (!/^[0-9a-f]{64}$/.test(entry.expectedSha256)) throw new Error(`Migration ${entry.name} has an invalid checksum`);
    if (sha256(entry.contents) !== entry.expectedSha256) throw new Error(`Migration ${entry.name} checksum mismatch`);
  }
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadMigrationPlan(directory = "packages/db/migrations"): Promise<readonly MigrationEntry[]> {
  const manifest = JSON.parse(await readFile(join(directory, "checksums.json"), "utf8")) as Record<string, string>;
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(files)) throw new Error("Migration checksum manifest does not match numbered migrations");
  return migrationPlanFromEntries(await Promise.all(files.map(async (name) => ({ name, contents: await readFile(join(directory, name), "utf8"), expectedSha256: manifest[name] ?? "" }))));
}

export async function runCommand(command: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {}): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => { if (code === 0) resolve({ stdout, stderr }); else reject(new Error(`${command} exited ${code ?? "unknown"}: ${stderr.trim()}`)); });
    if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
  });
}

async function psql(databaseUrl: string, sql: string): Promise<string> {
  const result = await runCommand("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]);
  return result.stdout.trim();
}

// Each migration from 0012 on adds a column that proves it was applied. A
// database that stops at one of these markers gets only the later migrations,
// in order; anything else that already has the core schema is refused rather
// than guessed at. Every new migration must add its marker here.
export const migrationMarkers: readonly { readonly name: string; readonly table: string; readonly column: string }[] = [
  { name: "0012_task_planning_attempt.sql", table: "tasks", column: "planning_attempt" },
  { name: "0013_stack_skill_execution_profile.sql", table: "task_executions", column: "execution_profile" },
  { name: "0014_project_decisions.sql", table: "project_decisions", column: "superseded_by" },
  { name: "0015_organization_skills.sql", table: "organization_skills", column: "applies_to_stacks" },
];

export function migrationsToApply(plan: readonly MigrationEntry[], hasCore: boolean, presentMarkers: ReadonlySet<string>): readonly MigrationEntry[] {
  const latest = plan.at(-1)?.name;
  if (latest && !migrationMarkers.some((marker) => marker.name === latest)) throw new Error(`Migration ${latest} has no applied-schema marker in apps/demo/src/migrations.ts`);
  if (!hasCore) return plan;
  const firstMissing = migrationMarkers.findIndex((marker) => !presentMarkers.has(marker.name));
  if (firstMissing === -1) return [];
  const partial = new Error("Database is partially migrated. Refusing to guess an applied prefix; apply the immutable numbered migrations in order before demo startup.");
  if (firstMissing === 0) throw partial;
  if (migrationMarkers.slice(firstMissing).some((marker) => presentMarkers.has(marker.name))) throw partial;
  const from = migrationMarkers[firstMissing]!.name;
  return plan.filter((entry) => entry.name >= from);
}

export async function ensureDemoMigrations(adminDatabaseUrl: string, directory = "packages/db/migrations"): Promise<{ readonly applied: readonly string[]; readonly plan: readonly MigrationEntry[] }> {
  const plan = await loadMigrationPlan(directory);
  const hasCore = (await psql(adminDatabaseUrl, "SELECT to_regclass('public.organizations') IS NOT NULL;")) === "t";
  const presentMarkers = new Set<string>();
  if (hasCore) {
    for (const marker of migrationMarkers) {
      const present = await psql(adminDatabaseUrl, `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${marker.table}' AND column_name='${marker.column}');`);
      if (present === "t") presentMarkers.add(marker.name);
    }
  }
  const applied: string[] = [];
  for (const migration of migrationsToApply(plan, hasCore, presentMarkers)) {
    await runCommand("psql", [adminDatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", join(directory, migration.name)]);
    applied.push(migration.name);
  }
  const roles = await psql(adminDatabaseUrl, "SELECT rolname FROM pg_roles WHERE rolname IN ('coding_agent_api','coding_agent_worker') ORDER BY rolname;");
  if (roles.split(/\r?\n/).filter(Boolean).join(",") !== "coding_agent_api,coding_agent_worker") throw new Error("Database roles coding_agent_api and coding_agent_worker are not ready");
  return { applied, plan };
}
