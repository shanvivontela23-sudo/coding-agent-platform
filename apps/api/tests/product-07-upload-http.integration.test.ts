import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { createProductDatabase } from "../src/database.js";
import type { GitHubAppClient } from "../src/github-app.js";
import { attachProduct07Routes } from "../src/product-07-server.js";
import { createProduct07Service } from "../src/product-07-service.js";
import { ProjectDownloadTokenService } from "../src/project-download-token.js";
import { LocalProjectStorage } from "../src/project-storage.js";
import { createApiServer } from "../src/server.js";
import { createUploadProjectDatabase } from "../src/upload-project-database.js";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationDb = "coding_agent_upload_http_integration";
const apiPassword = "coding-agent-api-integration-password";
const sessionSecret = "upload-http-session-secret-that-is-long-enough";
const organizationId = "00000000-0000-4000-8000-000000000071";
const userId = "10000000-0000-4000-8000-000000000071";
const supabaseUserId = "60000000-0000-4000-8000-000000000071";
const limits = { maxCompressedBytes: 2 * 1024 * 1024, maxUncompressedBytes: 4 * 1024 * 1024, maxFiles: 100, maxFileBytes: 512 * 1024, maxNestedArchiveDepth: 1 } as const;

let rootPool: Pool | null = null;
let adminPool: Pool | null = null;
let apiPool: Pool | null = null;
let storageRoot = "";

function databaseUrlFor(name: string, user?: string, password?: string): string {
  const url = new URL(baseDatabaseUrl!);
  url.pathname = `/${name}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { readonly name: string; readonly contents: string }[]): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.contents);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const localBytes = Buffer.concat(locals);
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

beforeAll(async () => {
  if (!baseDatabaseUrl) return;
  rootPool = new Pool({ connectionString: baseDatabaseUrl });
  await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
  await rootPool.query(`CREATE DATABASE ${integrationDb}`);
  adminPool = new Pool({ connectionString: databaseUrlFor(integrationDb) });
  for (const name of ["0001_tenant_core.sql", "0002_organization_invitations.sql", "0003_github_projects.sql", "0004_task_intake.sql", "0005_zip_projects_and_task_review_fixes.sql"]) {
    await adminPool.query(await readFile(join("packages/db/migrations", name), "utf8"));
  }
  await adminPool.query(`ALTER ROLE coding_agent_api PASSWORD '${apiPassword}'`);
  await adminPool.query(`
    INSERT INTO organizations (id,name) VALUES ('${organizationId}','Upload Integration');
    INSERT INTO users (id,supabase_user_id,email) VALUES ('${userId}','${supabaseUserId}','owner@example.com');
    INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('${organizationId}','${userId}','owner');
  `);
  apiPool = new Pool({ connectionString: databaseUrlFor(integrationDb, "coding_agent_api", apiPassword), max: 2 });
  storageRoot = await mkdtemp(join(tmpdir(), "dhara-upload-http-"));
}, 30_000);

afterAll(async () => {
  await apiPool?.end();
  await adminPool?.end();
  if (rootPool) {
    await rootPool.query(`DROP DATABASE IF EXISTS ${integrationDb} WITH (FORCE)`);
    await rootPool.end();
  }
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!baseDatabaseUrl)("ZIP upload HTTP persistence integration", () => {
  it("persists the project graph and archive through the restricted runtime role", async () => {
    const database = createProductDatabase(apiPool!);
    const uploadDatabase = createUploadProjectDatabase(apiPool!);
    const storage = new LocalProjectStorage({ rootDir: storageRoot });
    const githubApp = {
      installationUrl() { throw new Error("not used"); },
      async verifyUserInstallation() { throw new Error("not used"); },
      async listRepositories() { throw new Error("not used"); },
      async analyseRepository() { throw new Error("not used"); },
      async checkInstallation() { throw new Error("not used"); },
    } as unknown as GitHubAppClient;
    const service = createProduct07Service({
      database: uploadDatabase,
      productDatabase: database,
      storage,
      githubApp,
      downloadTokens: new ProjectDownloadTokenService({ secret: sessionSecret }),
      limits,
    });
    const productServer = createApiServer({
      webOrigin: "http://localhost:3000",
      apiOrigin: "http://localhost:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 60_000,
      auth: {
        async signInWithPassword() { throw new Error("not used"); },
        startGitHubOAuth() { throw new Error("not used"); },
        async completeGitHubOAuth() { throw new Error("not used"); },
      },
      database,
      githubApp,
    });
    const server = attachProduct07Routes(productServer, { apiOrigin: "http://localhost:3001", webOrigin: "http://localhost:3000", sessionSecret, service, maxUploadRequestBytes: limits.maxCompressedBytes + 1024 * 1024 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    try {
      const bytes = zip([
        { name: "customer-app/package.json", contents: JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { typescript: "5", vitest: "3" } }) },
        { name: "customer-app/src/index.ts", contents: "export const ready = true;" },
      ]);
      const form = new FormData();
      form.set("name", "Customer app");
      form.set("zip", new Blob([bytes], { type: "application/zip" }), "customer-app.zip");
      const token = createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
      const response = await fetch(`http://127.0.0.1:${address.port}/projects/upload`, {
        method: "POST",
        headers: { cookie: `tenant_session=${encodeURIComponent(token)}` },
        body: form,
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      const location = response.headers.get("location");
      expect(location).toMatch(/^http:\/\/localhost:3000\/projects\/[0-9a-f-]{36}$/i);
      const projectId = location!.split("/").at(-1)!;

      const persisted = await adminPool!.query<{
        project_id: string; provider: string; external_id: string; version_number: number; storage_key: string; report_count: string; audit_count: string;
      }>(`
        SELECT p.id AS project_id,r.provider,r.external_id,pv.version_number,pv.storage_key,
          (SELECT count(*)::text FROM project_reports pr WHERE pr.project_id=p.id) AS report_count,
          (SELECT count(*)::text FROM audit_events ae WHERE ae.organization_id=p.organization_id AND ae.payload->>'project_id'=p.id::text AND ae.event_type='upload_project_created') AS audit_count
        FROM projects p
        JOIN repositories r ON r.organization_id=p.organization_id AND r.project_id=p.id
        JOIN project_versions pv ON pv.organization_id=p.organization_id AND pv.project_id=p.id
        WHERE p.id=$1
      `, [projectId]);
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0]).toMatchObject({ project_id: projectId, provider: "upload", external_id: projectId, version_number: 1, report_count: "1", audit_count: "1" });
      const stored = await readFile(join(storageRoot, persisted.rows[0]!.storage_key));
      expect(stored.byteLength).toBeGreaterThan(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  }, 30_000);
});
