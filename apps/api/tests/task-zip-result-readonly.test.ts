import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { attachTaskExecutionRoutes } from "../src/task-execution-server.js";
import type { TaskExecutionService } from "../src/task-execution-service.js";
import { createTaskZipResultService, type TaskZipResultDatabase } from "../src/task-zip-result.js";
import type { ProjectStorage } from "../src/project-storage.js";

const session = {
  organizationId: "00000000-0000-4000-8000-000000000911",
  userId: "10000000-0000-4000-8000-000000000911",
  expiresAtMs: Date.now() + 60_000,
};
const taskId = "40000000-0000-4000-8000-000000000911";
const secret = "zip-result-readonly-session-secret-long-enough";

describe("ZIP result polling", () => {
  it("keeps ten concurrent GET /execution requests storage-write free", async () => {
    const writeVersion = vi.fn();
    const completeBuild = vi.fn(async () => { throw new Error("must not complete during GET"); });
    const database: TaskZipResultDatabase = {
      getStatus: vi.fn(async () => ({ status: "pending" as const, errorCode: null, errorMessage: null, artifact: null })),
      getContext: vi.fn(async () => null),
      getArtifact: vi.fn(async () => null),
      completeBuild,
      acceptUnproven: vi.fn(async () => null),
      retryBuild: vi.fn(async () => null),
      markFailed: vi.fn(async () => false),
      promote: vi.fn(async () => { throw new Error("not used"); }),
      auditDownload: vi.fn(async () => undefined),
    };
    const storage = { readVersion: vi.fn(), writeVersion, deleteVersion: vi.fn(), deleteProject: vi.fn() } as unknown as ProjectStorage;
    const zipResultService = createTaskZipResultService({ database, storage, downloadTokens: {} as never, limits: { maxCompressedBytes: 1024, maxUncompressedBytes: 2048, maxFiles: 20, maxFileBytes: 1024, maxNestedArchiveDepth: 1 } });
    const executionService: TaskExecutionService = {
      get: vi.fn(async () => null),
      readiness: vi.fn(async () => ({ implementationBlocker: null })),
      start: vi.fn(async () => { throw new Error("not used"); }),
      cancel: vi.fn(async () => { throw new Error("not used"); }),
    };
    const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
    attachTaskExecutionRoutes(server, { apiOrigin: "http://127.0.0.1", sessionSecret: secret, service: executionService, zipResultService });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const cookie = `tenant_session=${encodeURIComponent(createSessionToken(session, secret))}`;
    try {
      const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution`, { headers: { cookie } })));
      expect(responses.every((response) => response.status === 200)).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
    expect(database.getStatus).toHaveBeenCalledTimes(10);
    expect(writeVersion).not.toHaveBeenCalled();
    expect(completeBuild).not.toHaveBeenCalled();
  });
});
