import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function text(path: string): Promise<string> { return await readFile(path, "utf8"); }

describe("B2 worker CLI", () => {
  it("exposes a neutral pnpm dev entrypoint that does not inject fake execution", async () => {
    const pkg = JSON.parse(await text("apps/worker/package.json")) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.dev).toBe("tsx src/cli.ts");
    expect(pkg.scripts?.dev).not.toContain("--fake");
  });

  it("composes the real worker by default and keeps fake execution behind an explicit env opt-in", async () => {
    const cli = await text("apps/worker/src/cli.ts");
    expect(cli).toContain("loadRealWorkerConfig");
    expect(cli).toContain("createRealProductExecutionRunner");
    expect(cli).toContain("runTaskExecutionWorker");
    expect(cli).toContain("TASK_EXECUTION_FAKE_RUNNER");
    expect(cli).toContain("coding_agent_worker");
    expect(cli).toContain("SIGINT");
    expect(cli).toContain("SIGTERM");
    expect(cli).toContain("pool.end");
    expect(cli).not.toContain("process.argv.includes(\"--fake\")");
  });

  it("documents the real worker command/config and the explicit fake-only queue mode", async () => {
    const readme = await text("README.md");
    for (const value of [
      "pnpm --filter @coding-agent/worker dev",
      "TASK_EXECUTION_WORKER_ID",
      "coding_agent_worker",
      "TASK_EXECUTION_MODEL",
      "TASK_EXECUTION_GATEWAY_URL",
      "E2B_API_KEY",
      "LITELLM_ADMIN_TOKEN",
      "TASK_EXECUTION_FAKE_RUNNER=1",
      "does not produce a real implementation",
    ]) expect(readme).toContain(value);
  });
});
