import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionToken, type SupabaseAuthClient } from "../../api/src/auth.js";
import type { ProductDatabase } from "../../api/src/database.js";
import type { GitHubAppClient } from "../../api/src/github-app.js";
import { createApiServer } from "../../api/src/server.js";
import { attachTaskRoutes } from "../../api/src/task-server.js";

const sessionSecret = "test-session-secret-that-is-long-enough-for-pages";
const userId = "10000000-0000-4000-8000-000000000091";
const organizationId = "00000000-0000-4000-8000-000000000091";
const githubProjectId = "20000000-0000-4000-8000-000000000091";
const uploadProjectId = "20000000-0000-4000-8000-000000000092";

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

async function freePort(): Promise<number> {
  const server = createHttpServer();
  const port = await listen(server);
  server.close();
  await once(server, "close");
  return port;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(3_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

async function waitForWeb(url: string, child: ChildProcessWithoutNullStreams, logs: () => string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next.js exited before becoming ready:\n${logs()}`);
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch { /* keep polling */ }
    await delay(100);
  }
  throw new Error(`Next.js did not become ready:\n${logs()}`);
}

const auth: SupabaseAuthClient = {
  async signInWithPassword() { throw new Error("not used"); },
  startGitHubOAuth() { throw new Error("not used"); },
  async completeGitHubOAuth() { throw new Error("not used"); },
};

const report = {
  languages: [],
  frameworks: [],
  packageManager: null,
  buildCommand: null,
  testCommand: null,
  workspaceCommands: [],
  stackSkill: "generic" as const,
  manifests: [],
};

const database = {
  async getHome() {
    return {
      organization: { id: organizationId, name: "Acme" },
      user: { id: userId, email: "owner@example.com" },
      projects: [
        { id: githubProjectId, name: "GitHub demo", source: { type: "github", fullName: "acme/backend" } },
        { id: uploadProjectId, name: "ZIP demo", source: { type: "upload", versionNumber: 3 } },
      ],
    };
  },
  async getProjectReport() {
    return {
      project: { id: githubProjectId, name: "GitHub demo" },
      repository: {
        id: "30000000-0000-4000-8000-000000000091",
        githubRepositoryId: 91,
        name: "backend",
        fullName: "acme/backend",
        defaultBranch: "main",
        lastAnalysedCommit: "a".repeat(40),
      },
      report,
      installation: { installationId: 91, status: "connected" as const },
    };
  },
} as unknown as ProductDatabase;

const githubApp = {
  async checkInstallation() { return undefined; },
} as unknown as GitHubAppClient;

const readService = {
  async list() { return []; },
  async get() { return null; },
  async approve() { return undefined; },
};

describe("signed-in task pages with task planning unconfigured", () => {
  it("keeps read pages usable, shows planning unavailable inline, and renders project sources", async () => {
    const apiServer = createApiServer({
      webOrigin: "http://127.0.0.1:3000",
      apiOrigin: "http://127.0.0.1:3001",
      sessionSecret,
      sessionDurationMs: 60_000,
      onboardingDurationMs: 60_000,
      auth,
      database,
      githubApp,
    });
    const server = attachTaskRoutes(apiServer, {
      apiOrigin: "http://127.0.0.1:3001",
      webOrigin: "http://127.0.0.1:3000",
      sessionSecret,
      service: undefined,
      readService,
      planningService: undefined,
    } as unknown as Parameters<typeof attachTaskRoutes>[1]);

    const apiPort = await listen(server);
    const webPort = await freePort();
    let output = "";
    const webDirectory = join(process.cwd(), "apps/web");
    const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(webPort)], {
      cwd: webDirectory,
      env: { ...process.env, NEXT_PUBLIC_API_ORIGIN: `http://127.0.0.1:${apiPort}`, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-20_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const token = createSessionToken({ userId, organizationId, expiresAtMs: Date.now() + 60_000 }, sessionSecret);
    const request = (path: string) => fetch(`http://127.0.0.1:${webPort}${path}`, { headers: { cookie: `tenant_session=${encodeURIComponent(token)}` } });

    try {
      await waitForWeb(`http://127.0.0.1:${webPort}/`, child, () => output);
      const tasksResponse = await request("/tasks");
      const tasksHtml = await tasksResponse.text();
      const newTaskResponse = await request(`/projects/${githubProjectId}/tasks/new`);
      const newTaskHtml = await newTaskResponse.text();
      const homeResponse = await request("/home");
      const homeHtml = await homeResponse.text();

      expect(tasksResponse.status, tasksHtml).toBe(200);
      expect(tasksHtml).toContain("No tasks yet. Open a project and choose New task.");
      expect(tasksHtml).not.toContain("Unable to load tasks.");

      expect(newTaskResponse.status, newTaskHtml).toBe(200);
      expect(newTaskHtml).toContain("Task planning is not configured.");
      expect(newTaskHtml).not.toContain("Internal Server Error");

      expect(homeResponse.status, homeHtml).toBe(200);
      expect(homeHtml).toContain("GitHub");
      expect(homeHtml).toContain("acme/backend");
      expect(homeHtml).toContain("ZIP upload");
      expect(homeHtml).toContain("Version 3");
    } finally {
      await stopChild(child);
      server.close();
      await once(server, "close");
    }
  }, 45_000);
});
