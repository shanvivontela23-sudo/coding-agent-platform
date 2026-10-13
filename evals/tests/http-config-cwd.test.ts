import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerCwd = join(repoRoot, "apps", "worker");

function runConfigLoadFromWorkerCwd(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--eval",
        "import { loadHarnessHttpConfig } from '../../evals/src/gateway/http/config.ts'; loadHarnessHttpConfig(); console.log('loaded');",
      ],
      {
        cwd: workerCwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("harness HTTP config path resolution", () => {
  it("loads the committed config when the process cwd is apps/worker", async () => {
    const result = await runConfigLoadFromWorkerCwd();

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("loaded");
  });
});
