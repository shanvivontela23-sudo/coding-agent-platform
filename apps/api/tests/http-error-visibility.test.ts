import { once } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSessionToken, type SessionIdentity } from "../src/auth.js";
import type { ProductDatabase } from "../src/database.js";
import type { Product07Service } from "../src/product-07-service.js";
import { attachProduct07Routes } from "../src/product-07-server.js";
import { createApiServer, type ApiServerOptions } from "../src/server.js";
import { attachTaskRoutes } from "../src/task-server.js";
import type { TaskReadService } from "../src/task-service.js";

const sessionSecret = "http-error-visibility-secret-long-enough";
const userId = "10000000-0000-4000-8000-0000000000c1";
const organizationId = "00000000-0000-4000-8000-0000000000c1";
const projectId = "20000000-0000-4000-8000-0000000000c1";

function session(expiresAtMs = Date.now() + 60_000): SessionIdentity {
  return { userId, organizationId, expiresAtMs };
}

function database(overrides: Partial<ProductDatabase> = {}): ProductDatabase {
  return {
    lookupMemberships: async () => [],
    createOrganizationWithOwner: async () => ({ userId, organizationId }),
    getHome: async () => ({ organization: { id: organizationId, name: "Acme" }, user: { id: userId, email: "owner@example.com" }, projects: [] }),
    getMembers: async () => ({ organization: { id: organizationId, name: "Acme" }, currentUser: { id: userId, email: "owner@example.com", role: "owner" }, members: [], invitations: [] }),
    createInvitation: async () => { throw new Error("not used"); },
    listVerifiedInvitations: async () => [],
    acceptVerifiedInvitation: async () => ({ userId, organizationId }),
    ...overrides,
  };
}

function apiServer(databaseOverride = database()): Server {
  return createApiServer({
    webOrigin: "http://localhost:3000",
    apiOrigin: "http://localhost:3001",
    sessionSecret,
    sessionDurationMs: 60_000,
    onboardingDurationMs: 60_000,
    auth: {
      signInWithPassword: async () => { throw new Error("not used"); },
      startGitHubOAuth: () => { throw new Error("not used"); },
      completeGitHubOAuth: async () => { throw new Error("not used"); },
    },
    database: databaseOverride,
  } as ApiServerOptions);
}

function productService(createUploadProject: Product07Service["createUploadProject"]): Product07Service {
  return {
    createUploadProject,
    getUploadProject: async () => null,
    reanalyse: async () => undefined,
    issueDownloadToken: async () => "token",
    download: async () => ({ bytes: new Uint8Array(), filename: "project.zip" }),
    deleteUploadProject: async () => undefined,
  };
}

async function withServer(server: Server, run: (baseUrl: string) => Promise<void>): Promise<void> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.close(); await once(server, "close"); }
}

function uploadForm(): FormData {
  const form = new FormData();
  form.set("name", "Customer app");
  form.set("zip", new Blob([new Uint8Array([1, 2, 3])], { type: "application/zip" }), "customer.zip");
  return form;
}

function validCookie(extra = ""): string {
  const token = createSessionToken(session(), sessionSecret);
  return `${extra}${extra ? "; " : ""}tenant_session=${encodeURIComponent(token)}`;
}

function parseRef(message: string): string {
  const match = message.match(/Something went wrong \(ref ([0-9a-f]{6})\)\. Please try again\./);
  expect(match).toBeTruthy();
  return match![1]!;
}

function lastLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const raw = spy.mock.calls.at(-1)?.[0];
  expect(typeof raw).toBe("string");
  return JSON.parse(String(raw)) as Record<string, unknown>;
}

describe("HTTP request error visibility", () => {
  it("skips a malformed unrelated cookie and still uploads with a valid tenant session", async () => {
    let uploads = 0;
    const service = productService(async () => { uploads += 1; return { projectId }; });
    const server = attachProduct07Routes(apiServer(), {
      apiOrigin: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      sessionSecret,
      service,
      maxUploadRequestBytes: 1024 * 1024,
    });

    await withServer(server, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/projects/upload`, {
        method: "POST",
        headers: { cookie: validCookie("foo=100%") },
        body: uploadForm(),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`http://localhost:3000/projects/${projectId}`);
      expect(uploads).toBe(1);
    });
  });

  it("redirects an expired upload session to sign-in instead of a project error", async () => {
    let uploads = 0;
    const service = productService(async () => { uploads += 1; return { projectId }; });
    const server = attachProduct07Routes(apiServer(), {
      apiOrigin: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      sessionSecret,
      service,
      maxUploadRequestBytes: 1024 * 1024,
    });
    const expired = createSessionToken(session(Date.now() - 1_000), sessionSecret);

    await withServer(server, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/projects/upload`, {
        method: "POST",
        headers: { cookie: `tenant_session=${encodeURIComponent(expired)}` },
        body: uploadForm(),
        redirect: "manual",
      });
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/");
      expect(location.searchParams.get("error")).toBe("Please sign in to continue.");
      expect(uploads).toBe(0);
    });
  });

  it("logs a product upload internal error with stack and returns the same request ref", async () => {
    const service = productService(async () => { throw new Error("upload database exploded"); });
    const server = attachProduct07Routes(apiServer(), {
      apiOrigin: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      sessionSecret,
      service,
      maxUploadRequestBytes: 1024 * 1024,
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withServer(server, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/projects/upload`, { method: "POST", headers: { cookie: validCookie() }, body: uploadForm(), redirect: "manual" });
        expect(response.status).toBe(303);
        const message = new URL(response.headers.get("location")!).searchParams.get("error") ?? "";
        expect(message).toContain("Unable to upload that project.");
        const requestId = parseRef(message);
        const logged = lastLog(stderr);
        expect(logged).toMatchObject({ requestId, error: { name: "Error", message: "upload database exploded" } });
        expect(String((logged.error as { stack?: unknown }).stack)).toContain("upload database exploded");
      });
    } finally { stderr.mockRestore(); }
  });

  it("logs task API internal errors with a stack and returns a reference message", async () => {
    const readService = { list: async () => { throw new Error("task database exploded"); } } as unknown as TaskReadService;
    const server = attachTaskRoutes(apiServer(), {
      apiOrigin: "http://localhost:3001",
      webOrigin: "http://localhost:3000",
      sessionSecret,
      readService,
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withServer(server, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/tasks`, { headers: { cookie: validCookie() } });
        expect(response.status).toBe(500);
        const payload = await response.json() as { error: string };
        const requestId = parseRef(payload.error);
        expect(lastLog(stderr)).toMatchObject({ requestId, error: { name: "Error", message: "task database exploded" } });
      });
    } finally { stderr.mockRestore(); }
  });

  it("logs base API internal errors with a stack and returns a reference message", async () => {
    const server = apiServer(database({ getHome: async () => { throw new Error("home database exploded"); } }));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withServer(server, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/home`, { headers: { cookie: validCookie() } });
        expect(response.status).toBe(500);
        const payload = await response.json() as { error: string };
        const requestId = parseRef(payload.error);
        const logged = lastLog(stderr);
        expect(logged).toMatchObject({ requestId, error: { name: "Error", message: "home database exploded" } });
        expect(String((logged.error as { stack?: unknown }).stack)).toContain("home database exploded");
      });
    } finally { stderr.mockRestore(); }
  });
});
