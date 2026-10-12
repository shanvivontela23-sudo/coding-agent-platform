import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSessionToken } from "../src/auth.js";
import { attachTaskExecutionRoutes } from "../src/task-execution-server.js";
import type { TaskExecutionService } from "../src/task-execution-service.js";

const taskId = "40000000-0000-4000-8000-000000000971";
const session = { organizationId: "00000000-0000-4000-8000-000000000971", userId: "10000000-0000-4000-8000-000000000971", expiresAtMs: Date.now() + 60_000 };
const secret = "demo-budget-http-session-secret-long-enough";

describe("demo budget cap execution payload", () => {
  it("includes configured demo caps on read-only execution GET", async () => {
    const service: TaskExecutionService = {
      get: vi.fn(async () => null),
      readiness: vi.fn(async () => ({ implementationBlocker: null })),
      start: vi.fn(async () => { throw new Error("not used"); }),
      cancel: vi.fn(async () => { throw new Error("not used"); }),
    };
    const server = createServer((_request, response) => { response.statusCode = 404; response.end(); });
    attachTaskExecutionRoutes(server, { apiOrigin: "http://127.0.0.1", sessionSecret: secret, service, demoBudgetCaps: { planningUsd: 1, executionUsd: 2 } });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    try {
      const cookie = `tenant_session=${encodeURIComponent(createSessionToken(session, secret))}`;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${taskId}/execution`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ execution: null, implementationBlocker: null, publication: null, zipResult: null, zipResultBuild: null, demoBudgetCaps: { planningUsd: 1, executionUsd: 2 } });
      expect(service.start).not.toHaveBeenCalled();
      expect(service.cancel).not.toHaveBeenCalled();
    } finally {
      server.close(); await once(server, "close");
    }
  });
});
