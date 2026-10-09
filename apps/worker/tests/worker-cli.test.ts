import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 worker CLI", () => {
  it("exposes a neutral pnpm dev entrypoint that does not inject fake execution", async () => {
    const pkg = JSON.parse(await text("apps/worker/package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.dev).toBe("tsx src/cli.ts");
    expect(pkg.scripts?.dev).not.toContain("--fake");
  });

  it("requires DATABASE_URL and worker id, restricts the database user, handles shutdown signals, and gates fake mode by env", async () => {
    const cli = await text("apps/worker/src/cli.ts");
    expect(cli).toContain("DATABASE_URL");
    expect(cli).toContain("TASK_EXECUTION_WORKER_ID");
    expect(cli).toContain("coding_agent_worker");
    expect(cli).toContain("SIGINT");
    expect(cli).toContain("SIGTERM");
    expect(cli).toContain("AbortController");
    expect(cli).toContain("pool.end");
    expect(cli).toContain("TASK_EXECUTION_FAKE_RUNNER");
    expect(cli).not.toContain("process.argv.includes(\"--fake\")");
  });

  it("documents the local command, worker-only database URL, and explicit fake-only opt-in", async () => {
    const readme = await text("README.md");
    expect(readme).toContain("pnpm --filter @coding-agent/worker dev");
    expect(readme).toContain("TASK_EXECUTION_WORKER_ID");
    expect(readme).toContain("coding_agent_worker");
    expect(readme).toContain("TASK_EXECUTION_FAKE_RUNNER=1");
    expect(readme).toContain("does not produce a real implementation");
  });
});
