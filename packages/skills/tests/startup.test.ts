import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBuiltInStackSkillsAtStartup } from "../src/registry.js";

describe("startup validation of built-in stack skills", () => {
  it("accepts the committed built-ins", () => {
    expect(validateBuiltInStackSkillsAtStartup("API").has("typescript-node")).toBe(true);
  });

  it("stops startup on a malformed skill without echoing guide text", async () => {
    const root = await mkdtemp(join(tmpdir(), "dhara-skills-"));
    const skillDir = join(root, "broken");
    await mkdir(skillDir);
    const valid = JSON.parse(await readFile(new URL("../stacks/typescript-node/skill.json", import.meta.url), "utf8")) as Record<string, unknown>;
    await writeFile(join(skillDir, "skill.json"), JSON.stringify({ ...valid, version: "one" }));
    await writeFile(join(skillDir, "guide.md"), "SECRET-GUIDE-TEXT");
    const run = () => validateBuiltInStackSkillsAtStartup("Worker", pathToFileURL(`${root}/`));
    expect(run).toThrow(/^Worker cannot start: Invalid stack skill .*skill\.json at version/);
    try { run(); } catch (error) { expect(String(error)).not.toContain("SECRET-GUIDE-TEXT"); }
  });

  it("runs before any database pool, listener or worker loop in both entry points", async () => {
    const api = await readFile("apps/api/src/main.ts", "utf8");
    const worker = await readFile("apps/worker/src/cli.ts", "utf8");
    const apiCall = api.indexOf('validateBuiltInStackSkillsAtStartup("API")');
    expect(apiCall).toBeGreaterThan(-1);
    expect(apiCall).toBeLessThan(api.indexOf("new Pool("));
    expect(apiCall).toBeLessThan(api.indexOf(".listen("));
    const workerCall = worker.indexOf('validateBuiltInStackSkillsAtStartup("Worker")');
    expect(workerCall).toBeGreaterThan(-1);
    expect(workerCall).toBeLessThan(worker.indexOf("createRuntimePostgresPool(databaseUrl"));
    expect(workerCall).toBeLessThan(worker.indexOf("if (fake)"));
  });
});
