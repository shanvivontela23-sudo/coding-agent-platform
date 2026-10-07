import { Pool } from "pg";
import { createSupabaseAuthClient } from "./auth.js";
import { assertRestrictedDatabaseUrl, createProductDatabase, type TenantPool } from "./database.js";
import { createGitHubAppClient } from "./github-app.js";
import { createApiServer } from "./server.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid TCP port");

const databaseUrl = assertRestrictedDatabaseUrl(required("DATABASE_URL"));
const pool = new Pool({ connectionString: databaseUrl });
const database = createProductDatabase(pool as unknown as TenantPool);
const auth = createSupabaseAuthClient({
  supabaseUrl: required("SUPABASE_URL"),
  anonKey: required("SUPABASE_ANON_KEY"),
  flowSecret: required("SUPABASE_FLOW_SECRET"),
});
const githubApp = createGitHubAppClient({
  appId: required("GITHUB_APP_ID"),
  appSlug: required("GITHUB_APP_SLUG"),
  clientId: required("GITHUB_APP_CLIENT_ID"),
  clientSecret: required("GITHUB_APP_CLIENT_SECRET"),
  privateKey: required("GITHUB_APP_PRIVATE_KEY"),
});
const server = createApiServer({
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  apiOrigin: process.env.API_ORIGIN ?? `http://localhost:${port}`,
  sessionSecret: required("SESSION_SIGNING_SECRET"),
  sessionDurationMs: 8 * 60 * 60_000,
  onboardingDurationMs: 15 * 60_000,
  auth,
  database,
  githubApp,
});

server.listen(port, "127.0.0.1", () => { process.stdout.write(`coding-agent api listening on http://127.0.0.1:${port}\n`); });
const shutdown = () => { server.close(() => { void pool.end().finally(() => process.exit(0)); }); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
