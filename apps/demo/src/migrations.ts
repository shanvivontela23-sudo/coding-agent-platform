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

export async function ensureDemoMigrations(adminDatabaseUrl: string, directory = "packages/db/migrations"): Promise<{ readonly applied: readonly string[]; readonly plan: readonly MigrationEntry[] }> {
  const plan = await loadMigrationPlan(directory);
  const hasCore = (await psql(adminDatabaseUrl, "SELECT to_regclass('public.organizations') IS NOT NULL;")) === "t";
  const hasLatest = hasCore && (await psql(adminDatabaseUrl, "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tasks' AND column_name='planning_attempt');")) === "t";
  if (hasCore && !hasLatest) throw new Error("Database is partially migrated. Refusing to guess an applied prefix; apply the immutable numbered migrations in order before demo startup.");
  const applied: string[] = [];
  if (!hasCore) {
    for (const migration of plan) {
      await runCommand("psql", [adminDatabaseUrl, "-v", "ON_ERROR_STOP=1", "-f", join(directory, migration.name)]);
      applied.push(migration.name);
    }
  }
  const roles = await psql(adminDatabaseUrl, "SELECT rolname FROM pg_roles WHERE rolname IN ('coding_agent_api','coding_agent_worker') ORDER BY rolname;");
  if (roles.split(/\r?\n/).filter(Boolean).join(",") !== "coding_agent_api,coding_agent_worker") throw new Error("Database roles coding_agent_api and coding_agent_worker are not ready");
  return { applied, plan };
}
