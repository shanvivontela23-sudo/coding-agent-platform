import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 worker CLI", () => {
  it("exposes a pnpm dev entrypoint with explicit fake local runner", async () => {
    const pkg = JSON.parse(await text("apps/worker/package.json")) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.scripts?.dev).toBe("tsx src/cli.ts --fake");
    expect(pkg.dependencies?.pg).toBe("8.23.1");
  });

  it("requires DATABASE_URL and worker id, restricts the database user, and handles shutdown signals", async () => {
    const cli = await text("apps/worker/src/cli.ts");
    expect(cli).toContain("DATABASE_URL");
    expect(cli).toContain("TASK_EXECUTION_WORKER_ID");
    expect(cli).toContain("coding_agent_worker");
    expect(cli).toContain("SIGINT");
    expect(cli).toContain("SIGTERM");
    expect(cli).toContain("AbortController");
    expect(cli).toContain("pool.end");
    expect(cli).toContain("--fake");
  });

  it("documents the local command and worker-only database URL", async () => {
    const readme = await text("README.md");
    expect(readme).toContain("pnpm --filter @coding-agent/worker dev");
    expect(readme).toContain("TASK_EXECUTION_WORKER_ID");
    expect(readme).toContain("coding_agent_worker");
  });
});
